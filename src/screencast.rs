//! Screen capture without WebKit's capturer.
//!
//! WebKitGTK 2.54's own `getDisplayMedia` takes DMA-BUF frames from PipeWire
//! and imports them black (and sometimes crashes in the GL upload). So the
//! page's `getDisplayMedia` is replaced (web/screencast.js): it opens the
//! WebSocket `/api/screencast`, and this module asks the ScreenCast portal for
//! a screen or window, reads the PipeWire stream with our own GStreamer
//! pipeline in system memory, and sends each frame as a JPEG. The page draws
//! the frames on a canvas and hands Zoom `canvas.captureStream()`.
//!
//! Protocol (server → page): text `{"type":"started","width":w,"height":h}`,
//! then binary JPEG frames, and text `{"type":"error","name":..,"message":..}`
//! or `{"type":"ended"}` at the end. The page closes the socket to stop.
//!
//! The choice is remembered: the portal is asked to persist it, and the restore
//! token it returns is kept in `$XDG_STATE_HOME/penguin-zoom/screencast-token`,
//! so the next share starts without the picker. `?choose=1` ignores the token
//! (the UI's "Change" button), and the new choice replaces it.
//!
//! `ZOOM_SHARE_SOURCE=test` replaces the portal with a moving test pattern
//! (no picker, no screen content): for headless tests.

use std::os::fd::{AsRawFd, OwnedFd};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use serde_json::json;
use tokio::sync::mpsc;

/// Frames per second sent to the page. Zoom sends screen share at low frame
/// rates anyway; this keeps JPEG work and socket traffic small.
const FPS: i32 = 15;
const JPEG_QUALITY: i32 = 80;
/// Frames are scaled down to fit this box (aspect kept); Zoom sends at most
/// 1080p for a share.
const MAX_W: i32 = 1920;
const MAX_H: i32 = 1080;

enum Event {
    Frame(Vec<u8>),
    Caps(i32, i32),
    End(Option<String>),
}

/// What the portal gave us; dropping it closes the portal session.
struct Portal {
    _proxy: ashpd::desktop::screencast::Screencast,
    session: ashpd::desktop::Session<ashpd::desktop::screencast::Screencast>,
    fd: OwnedFd,
    node: u32,
}

/// Where the portal's restore token is kept (not secret, but private: 0600).
fn token_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/state")))?;
    Some(base.join("penguin-zoom/screencast-token"))
}

fn load_token() -> Option<String> {
    let t = std::fs::read_to_string(token_path()?).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

fn save_token(token: Option<&str>) {
    let Some(p) = token_path() else { return };
    match token {
        Some(t) => {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let w = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&p);
            if let Err(e) = w.and_then(|mut f| f.write_all(t.as_bytes())) {
                eprintln!("[share] cannot save the restore token: {e}");
            }
        }
        None => {
            let _ = std::fs::remove_file(&p);
        }
    }
}

impl Portal {
    /// `restore`: a token from an earlier share; the portal then reuses that
    /// choice without its picker (or shows the picker if the token is stale).
    async fn open(restore: Option<&str>) -> Result<Self, (String, String)> {
        use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, StartCastOptions};
        use ashpd::desktop::{PersistMode, ResponseError};
        let e = |name: &str| {
            let name = name.to_string();
            move |err: ashpd::Error| {
                let n = match &err {
                    ashpd::Error::Response(ResponseError::Cancelled) => "NotAllowedError".to_string(),
                    _ => name.clone(),
                };
                (n, err.to_string())
            }
        };
        let proxy = Screencast::new().await.map_err(e("NotReadableError"))?;
        let session = proxy.create_session(Default::default()).await.map_err(e("NotReadableError"))?;
        // Embedded cursor when the portal offers it (xdph does).
        let cursor = match proxy.available_cursor_modes().await {
            Ok(m) if m.contains(CursorMode::EMBEDDED) => CursorMode::EMBEDDED,
            _ => CursorMode::HIDDEN,
        };
        proxy
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_cursor_mode(cursor)
                    .set_sources(SourceType::MONITOR | SourceType::WINDOW)
                    .set_multiple(false)
                    .set_persist_mode(PersistMode::ExplicitlyRevoked)
                    .set_restore_token(restore),
            )
            .await
            .map_err(e("NotReadableError"))?
            .response()
            .map_err(e("NotAllowedError"))?;
        let streams = proxy
            .start(&session, None, StartCastOptions::default())
            .await
            .map_err(e("NotReadableError"))?
            .response()
            .map_err(e("NotAllowedError"))?;
        // A new token comes with every start; the old one is used up.
        save_token(streams.restore_token());
        let node = streams
            .streams()
            .first()
            .map(|s| s.pipe_wire_node_id())
            .ok_or_else(|| ("NotAllowedError".to_string(), "the portal returned no stream".to_string()))?;
        let fd = proxy
            .open_pipe_wire_remote(&session, Default::default())
            .await
            .map_err(e("NotReadableError"))?;
        Ok(Self { _proxy: proxy, session, fd, node })
    }
}

/// Builds the capture pipeline.
/// `portal` None means the test pattern: a ball, or colour bars when the
/// share was "changed" (`choose`), so a test can see the switch.
fn pipeline(portal: Option<&Portal>, choose: bool, tx: mpsc::Sender<Event>) -> Result<gst::Pipeline, String> {
    gst::init().map_err(|e| e.to_string())?;
    let src = match portal {
        // pipewiresrc dups the fd, so `Portal` keeps the original.
        Some(p) => format!(
            "pipewiresrc fd={} path={} do-timestamp=true keepalive-time=1000 always-copy=true",
            p.fd.as_raw_fd(),
            p.node
        ),
        None => format!(
            "videotestsrc is-live=true pattern={} ! video/x-raw,width=1920,height=1080",
            if choose { "smpte" } else { "ball" }
        ),
    };
    // The size range makes videoscale shrink big sources (keeping the aspect
    // ratio) and leave smaller ones alone.
    // videoconvert first forces system-memory caps, so pipewiresrc negotiates
    // shared memory instead of the DMA-BUF that WebKit gets black.
    let desc = format!(
        "{src} ! videoconvert ! videoscale add-borders=false ! videorate drop-only=true \
         ! video/x-raw,format=I420,framerate={FPS}/1,width=[2,{MAX_W}],height=[2,{MAX_H}],pixel-aspect-ratio=1/1 \
         ! jpegenc quality={JPEG_QUALITY} ! appsink name=out sync=false max-buffers=2 drop=true emit-signals=false"
    );
    let p = gst::parse::launch(&desc)
        .map_err(|e| format!("pipeline: {e}"))?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "pipeline: not a pipeline".to_string())?;

    let sink = p
        .by_name("out")
        .and_then(|e| e.downcast::<gst_app::AppSink>().ok())
        .ok_or("pipeline: no appsink")?;
    let tx_frames = tx.clone();
    let mut size = (0, 0);
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(st) = sample.caps().and_then(|c| c.structure(0)) {
                    let wh = (st.get::<i32>("width").unwrap_or(0), st.get::<i32>("height").unwrap_or(0));
                    if wh != size {
                        size = wh;
                        // Must arrive before the frame: wait for room.
                        let _ = tx_frames.blocking_send(Event::Caps(wh.0, wh.1));
                    }
                }
                if let Some(buf) = sample.buffer() {
                    if let Ok(map) = buf.map_readable() {
                        // Full channel: the page is behind, drop this frame.
                        if tx_frames.try_send(Event::Frame(map.as_slice().to_vec())).is_err() && tx_frames.is_closed() {
                            return Err(gst::FlowError::Flushing);
                        }
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    // Errors and end of stream (e.g. the shared window closed).
    let bus = p.bus().ok_or("pipeline: no bus")?;
    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            match msg.view() {
                gst::MessageView::Eos(_) => {
                    let _ = tx.blocking_send(Event::End(None));
                    break;
                }
                gst::MessageView::Error(e) => {
                    let _ = tx.blocking_send(Event::End(Some(format!("{} ({:?})", e.error(), e.debug()))));
                    break;
                }
                _ => {}
            }
            if tx.is_closed() {
                break;
            }
        }
    });
    Ok(p)
}

/// One share: lives as long as the WebSocket.
pub async fn serve(socket: WebSocket, choose: bool) {
    let (mut ws, mut incoming) = socket.split();
    let test = std::env::var("ZOOM_SHARE_SOURCE").is_ok_and(|v| v == "test");
    let restore = if choose { None } else { load_token() };
    eprintln!(
        "[share] start ({}{})",
        if test { "test pattern" } else { "portal" },
        if test { "" } else if restore.is_some() { ", last choice" } else { ", picker" }
    );

    let portal = if test {
        None
    } else {
        // The page may give up (closes the socket) while the picker is open.
        let opened = tokio::select! {
            r = Portal::open(restore.as_deref()) => r,
            _ = wait_closed(&mut incoming) => { eprintln!("[share] page left during the picker"); return; }
        };
        match opened {
            Ok(p) => Some(p),
            Err((name, message)) => {
                eprintln!("[share] portal: {name}: {message}");
                let _ = ws.send(text(json!({ "type": "error", "name": name, "message": message }))).await;
                return;
            }
        }
    };

    let (tx, mut rx) = mpsc::channel::<Event>(3);
    let p = match pipeline(portal.as_ref(), choose, tx) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[share] {e}");
            let _ = ws.send(text(json!({ "type": "error", "name": "NotReadableError", "message": e }))).await;
            return;
        }
    };
    if let Err(e) = p.set_state(gst::State::Playing) {
        eprintln!("[share] cannot start the pipeline: {e}");
        let _ = ws.send(text(json!({ "type": "error", "name": "NotReadableError", "message": e.to_string() }))).await;
        let _ = p.set_state(gst::State::Null);
        return;
    }

    let mut started = false;
    let (mut frames, mut bytes) = (0u64, 0u64);
    let t0 = std::time::Instant::now();
    let end = loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(Event::Caps(w, h)) => {
                    eprintln!("[share] frames {w}x{h}");
                    let kind = if started { "resized" } else { "started" };
                    started = true;
                    let msg = json!({ "type": kind, "width": w, "height": h, "remembered": restore.is_some() });
                    if ws.send(text(msg)).await.is_err() { break None; }
                }
                Some(Event::Frame(jpeg)) => {
                    frames += 1;
                    bytes += jpeg.len() as u64;
                    if ws.send(Message::Binary(jpeg.into())).await.is_err() { break None; }
                }
                Some(Event::End(err)) => break Some(err),
                None => break Some(None),
            },
            _ = wait_closed(&mut incoming) => break None,
        }
    };
    let _ = p.set_state(gst::State::Null);
    let secs = t0.elapsed().as_secs_f64().max(0.001);
    eprintln!(
        "[share] stopped after {secs:.0} s: {frames} frames ({:.1}/s, {:.0} KB/frame)",
        frames as f64 / secs,
        bytes as f64 / frames.max(1) as f64 / 1024.0
    );
    match end {
        Some(Some(e)) => {
            eprintln!("[share] pipeline error: {e}");
            let _ = ws.send(text(json!({ "type": "error", "name": "NotReadableError", "message": e }))).await;
        }
        Some(None) => {
            let _ = ws.send(text(json!({ "type": "ended" }))).await;
        }
        None => {}
    }
    if let Some(p) = portal {
        let _ = p.session.close().await;
    }
}

fn text(v: serde_json::Value) -> Message {
    Message::Text(v.to_string().into())
}

/// Resolves when the page closes the socket (it sends nothing else).
async fn wait_closed(incoming: &mut futures_util::stream::SplitStream<WebSocket>) {
    loop {
        match incoming.next().await {
            None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
            Some(Ok(_)) => {}
        }
    }
}

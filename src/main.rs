//! Penguin for Zoom: Zoom's Meeting SDK for Web inside WebKitGTK, served by a
//! local axum server (server.rs). See PLAN.md.
//!
//! Usage:
//!   penguin-zoom [<zoom link or meeting number>]
//!       Opens the window. If an instance is already running, hands it the
//!       link (POST /api/open), which raises its window, and exits.
//!   penguin-zoom --cmd mute-toggle|camera-toggle|leave|raise
//!       Sends a command to the running instance (for global hotkeys); exit 1
//!       if it isn't running.
//!   penguin-zoom --server-only [<link>]
//!       Just the HTTP server, no window, no WebKit (for testing with curl).
//!
//! Env toggles:
//!   ZOOM_SPIKE_NO_SAB=1          don't set JSC_useSharedArrayBuffer
//!   ZOOM_SPIKE_UA=<string>       override the user agent (diagnosis only)
//!   ZOOM_SPIKE_WEBRTC_MODE=0|1|unset   video_webrtc_mode claim (default 0)
//!   ZOOM_PUBLIC_CLIENT_ID=<id>   public OAuth client (PKCE) for sign-in
//!   ZOOM_SPIKE_URL=<url>         load something other than the spike page
//!   ZOOM_SHARE_SOURCE=test       screen share sends a test pattern (no portal)

mod launch;
mod screencast;
mod server;
mod settings;
mod speakers;
mod theme;

use gtk::glib::{self, prelude::*};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    platform::unix::WindowExtUnix,
    window::WindowBuilder,
};
use webkit2gtk::{
    DeviceInfoPermissionRequest, HardwareAccelerationPolicy, PermissionRequestExt, SettingsExt,
    UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
};
use wry::{WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

/// Writes the embedded tracer plugin to the runtime dir and points GStreamer
/// (ours and the web process's, which inherits the environment) at it.
fn install_camfix() {
    const SO: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/libgstpenguincamfix.so"));
    let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) else { return };
    let dir = std::path::PathBuf::from(run).join("penguin-zoom/gst");
    let file = dir.join("libgstpenguincamfix.so");
    // Rewrite only on change: a new mtime makes GStreamer rescan the plugin.
    if std::fs::read(&file).map(|old| old != SO).unwrap_or(true) {
        // Write beside it and rename, so a running web process never maps a half-written file.
        let tmp = dir.join(format!(".camfix-{}", std::process::id()));
        if std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&tmp, SO)).and_then(|_| std::fs::rename(&tmp, &file)).is_err() {
            eprintln!("camera workaround not installed: can't write {}", file.display());
            return;
        }
    }
    let join = |var: &str, add: &str, sep: &str| match std::env::var(var) {
        Ok(v) if !v.is_empty() => format!("{v}{sep}{add}"),
        _ => add.to_string(),
    };
    // SAFETY: called from main() before any other thread exists.
    unsafe {
        std::env::set_var("GST_PLUGIN_PATH", join("GST_PLUGIN_PATH", &dir.to_string_lossy(), ":"));
        std::env::set_var("GST_TRACERS", join("GST_TRACERS", "penguincamfix", ";"));
    }
}

fn main() {
    // Must happen before GTK or any other thread starts: the WebKit web process
    // inherits our environment, and 2.54's launcher never enables SAB itself
    // (WebKit bug 317847).
    if std::env::var_os("ZOOM_SPIKE_NO_SAB").is_none() {
        // SAFETY: single-threaded at this point; no other thread reads env yet.
        unsafe { std::env::set_var("JSC_useSharedArrayBuffer", "1") };
    }
    // The SDK plays a detached keep-alive <audio> at volume 0. WebKitGTK turns
    // that into a real PulseAudio stream at 0 %, and WirePlumber saves stream
    // volumes per application.name, so it restored 0 % onto the Web Audio
    // streams that carry the remote audio: the meeting went silent. Opt our
    // streams out of WirePlumber's volume save/restore (libpulse reads
    // PULSE_PROP; the web process inherits it).
    let pulse_prop = match std::env::var("PULSE_PROP") {
        Ok(p) if !p.is_empty() => format!("{p} state.restore-props=false"),
        _ => "state.restore-props=false".to_string(),
    };
    // SAFETY: still single-threaded here.
    unsafe { std::env::set_var("PULSE_PROP", pulse_prop) };
    // WebKitGTK camera workaround (gst/camfix.c): hand the web process a
    // GStreamer tracer that fixes its capture pipeline.
    if std::env::var_os("PENGUIN_NO_CAMFIX").is_none() {
        install_camfix();
    }
    // WebKitGTK 2.54 suspends a muted <video> that is outside the viewport when
    // it is created, and for a camera/MediaStream element never resumes it
    // (managePlayerSuspend/setViewportVisibility return early for MediaStream
    // players): the SDK's off-screen capture element then never gets a frame.
    // WebKit's own switch for its layout tests turns the suspend off.
    if std::env::var_os("PENGUIN_SUSPEND_HIDDEN_VIDEO").is_none() {
        // SAFETY: still single-threaded here.
        unsafe { std::env::set_var("WEBKIT_GST_ALLOW_PLAYBACK_OF_INVISIBLE_VIDEOS", "1") };
    }
    // Hyprland's `class` on GTK3 is the program name, not the application ID.
    glib::set_prgname(Some("penguin-zoom"));

    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(i) = args.iter().position(|a| a == "--cmd") {
        let cmd = args.get(i + 1).map(String::as_str).unwrap_or("");
        if !server::COMMANDS.contains(&cmd) {
            eprintln!("usage: penguin-zoom --cmd <{}>", server::COMMANDS.join("|"));
            std::process::exit(2);
        }
        match post_to_running("/api/cmd", serde_json::json!({ "cmd": cmd })) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("penguin-zoom is not running ({e})");
                std::process::exit(1);
            }
        }
    }
    let server_only = args.iter().any(|a| a == "--server-only");
    let launch = launch::from_args(args.iter().cloned());

    let root = data_root();
    if !root.join("assets/zoom-sdk/VERSION").exists() {
        eprintln!("{}/assets/zoom-sdk missing: run scripts/fetch-sdk.sh first", root.display());
        std::process::exit(1);
    }

    // Single instance: whoever binds the port is the instance. A second launch
    // hands its link (if any) to the first, which raises its window.
    let listener = match std::net::TcpListener::bind(server::ADDR) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            let link = launch.as_ref().and_then(|l| l.link.clone());
            match post_to_running("/api/open", serde_json::json!({ "link": link })) {
                Ok(()) => {
                    eprintln!("[main] already running; handed over to it");
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("[main] {} is in use by something else: {e}", server::ADDR);
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("[main] cannot bind {}: {e}", server::ADDR);
            std::process::exit(1);
        }
    };

    if server_only {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
        if let Err(e) = rt.block_on(server::run(root, listener, launch)) {
            eprintln!("[server] fatal: {e}");
            std::process::exit(1);
        }
        return;
    }

    // axum on its own runtime thread.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            if let Err(e) = server::run(root, listener, launch).await {
                eprintln!("[server] fatal: {e}");
                std::process::exit(1);
            }
        });
    });

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Penguin for Zoom")
        .with_inner_size(LogicalSize::new(1280.0, 860.0))
        .build(&event_loop)
        .expect("window");

    let start_url =
        std::env::var("ZOOM_SPIKE_URL").unwrap_or_else(|_| format!("{}/", server::ORIGIN));
    let mut builder = WebViewBuilder::new()
        .with_url(&start_url)
        .with_devtools(true)
        .with_new_window_req_handler(|url, _features| {
            // Only web links go to the system browser; never file: or other schemes.
            if url.starts_with("https://") || url.starts_with("http://") {
                eprintln!("[webview] new-window request (opening in system browser): {url}");
                let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
            } else {
                eprintln!("[webview] new-window request refused (not http/https): {url}");
            }
            wry::NewWindowResponse::Deny
        });
    if let Ok(ua) = std::env::var("ZOOM_SPIKE_UA") {
        builder = builder.with_user_agent(&ua);
    }
    let vbox = window.default_vbox().expect("tao gtk vbox");
    // Retry the first load briefly in case the listener isn't bound yet.
    wait_for_server();
    let webview = builder.build_gtk(vbox).expect("webview");

    configure_webkit(&webview.webview());

    // Closing the window leaves the meeting first (the process exiting skips
    // the page's unload, so Zoom would keep us listed until it times out).
    // The same on SIGTERM/SIGINT/SIGHUP (kill, logout, Ctrl+C): without this
    // the process just dies and a ghost participant stays in the meeting.
    for sig in [1, 2, 15] {
        let proxy = event_loop.create_proxy();
        glib::unix_signal_add(sig, move || {
            let _ = proxy.send_event(());
            glib::ControlFlow::Continue
        });
    }
    let mut closing: Option<std::time::Instant> = None;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if matches!(event, Event::WindowEvent { event: WindowEvent::CloseRequested, .. } | Event::UserEvent(())) {
            if closing.is_none() {
                let _ = webview.evaluate_script("try { window.zc && zc.leave() } catch (e) {}");
                window.set_visible(false);
                closing = Some(std::time::Instant::now() + std::time::Duration::from_millis(1500));
            }
        }
        if let Some(t) = closing {
            *control_flow = if std::time::Instant::now() >= t { ControlFlow::Exit } else { ControlFlow::WaitUntil(t) };
        }
    });
}

/// POSTs JSON to the running instance's server; Ok only on a 2xx answer.
fn post_to_running(path: &str, body: serde_json::Value) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let res = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?
            .post(format!("{}{path}", server::ORIGIN))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let st = res.status();
        if st.is_success() {
            Ok(())
        } else {
            Err(format!("{path} answered {st}: {}", res.text().await.unwrap_or_default()))
        }
    })
}

fn wait_for_server() {
    for _ in 0..50 {
        if std::net::TcpStream::connect(server::ADDR).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    eprintln!("[main] server did not come up on {}", server::ADDR);
}

/// Turns a WebKit runtime feature on or off by identifier. The feature API is
/// WebKitGTK 2.42+, newer than the webkit2gtk crate's bindings (2.40), so the
/// few C functions are declared here; the library is already linked.
fn set_webkit_feature(s: &webkit2gtk::Settings, id: &str, enabled: bool) {
    use std::ffi::{c_char, c_int, c_void, CStr};
    unsafe extern "C" {
        fn webkit_settings_get_all_features() -> *mut c_void;
        fn webkit_feature_list_get_length(list: *mut c_void) -> usize;
        fn webkit_feature_list_get(list: *mut c_void, i: usize) -> *mut c_void;
        fn webkit_feature_list_unref(list: *mut c_void);
        fn webkit_feature_get_identifier(f: *mut c_void) -> *const c_char;
        fn webkit_settings_set_feature_enabled(s: *mut c_void, f: *mut c_void, enabled: c_int);
        fn webkit_settings_get_feature_enabled(s: *mut c_void, f: *mut c_void) -> c_int;
    }
    let raw = s.as_ptr();
    // SAFETY: plain GObject/boxed calls on valid objects; the list is freed.
    unsafe {
        let list = webkit_settings_get_all_features();
        let mut found = false;
        for i in 0..webkit_feature_list_get_length(list) {
            let f = webkit_feature_list_get(list, i);
            if CStr::from_ptr(webkit_feature_get_identifier(f)).to_bytes() == id.as_bytes() {
                webkit_settings_set_feature_enabled(raw.cast(), f, enabled as c_int);
                eprintln!("[webkit] feature {id} = {}", webkit_settings_get_feature_enabled(raw.cast(), f) != 0);
                found = true;
            }
        }
        webkit_feature_list_unref(list);
        if !found {
            eprintln!("[webkit] feature {id} not found in this WebKitGTK");
        }
    }
}

fn configure_webkit(wv: &webkit2gtk::WebView) {
    if let Some(s) = WebViewExt::settings(wv) {
        s.set_enable_media_stream(true);
        s.set_enable_mediasource(true);
        s.set_enable_encrypted_media(true);
        s.set_enable_webrtc(true); // no-op on Arch's build (no ENABLE_WEB_RTC)
        s.set_enable_webaudio(true);
        s.set_enable_webgl(true);
        s.set_media_playback_requires_user_gesture(false);
        s.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Always);
        s.set_enable_developer_extras(true);
        s.set_javascript_can_access_clipboard(true);
        // No page-requested fullscreen: Zoom's SDK can put the whole GTK window
        // into fullscreen, which the compositor's own toggle (SUPER+F) then
        // can't undo. Fullscreen stays the window manager's job.
        s.set_enable_fullscreen(false);
        // The SDK renders video and screen share in workers on OffscreenCanvas
        // WebGL. WebKitGTK ships that behind a runtime feature that is off by
        // default ("AllowWebGLInWorkers", status stable); without it the share
        // decoder's fallback writes to an already-transferred canvas and the
        // received share stays blank. Off with ZOOM_SPIKE_NO_WEBGL_WORKERS=1.
        if std::env::var_os("ZOOM_SPIKE_NO_WEBGL_WORKERS").is_none() {
            set_webkit_feature(&s, "AllowWebGLInWorkers", true);
            // Alone it still returns null in a worker on 2.54 (probe:
            // ?probeworker); WebGL in workers needs the GPU-process WebGL path.
            set_webkit_feature(&s, "UseGPUProcessForWebGL", true);
        }
        // Experiments: ZOOM_SPIKE_FEATURES="Name=1,Other=0".
        for kv in std::env::var("ZOOM_SPIKE_FEATURES").unwrap_or_default().split(',') {
            if let Some((k, v)) = kv.split_once('=') {
                set_webkit_feature(&s, k.trim(), v.trim() == "1");
            }
        }
        eprintln!("[webkit] user agent: {}", s.user_agent().unwrap_or_default());
    }

    wv.connect_permission_request(|wv, req| {
        let uri = wv.uri().map(|u| u.to_string()).unwrap_or_default();
        let local = uri.starts_with(&format!("{}/", server::ORIGIN)) || uri == server::ORIGIN;
        if let Some(m) = req.downcast_ref::<UserMediaPermissionRequest>() {
            let (a, v) = (m.is_for_audio_device(), m.is_for_video_device());
            let kind = match (a, v) {
                (false, false) => "screen".to_string(),
                _ => [a.then_some("microphone"), v.then_some("camera")]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("+"),
            };
            decide(req, local, &format!("user-media ({kind})"), &uri);
        } else if req.is::<DeviceInfoPermissionRequest>() {
            decide(req, local, "device-info", &uri);
        } else {
            decide(req, false, req.type_().name(), &uri);
        }
        true
    });

    wv.connect_web_process_terminated(|_, reason| {
        eprintln!("[webkit] web process terminated: {reason:?}");
    });
}

fn decide(req: &webkit2gtk::PermissionRequest, allow: bool, what: &str, uri: &str) {
    eprintln!(
        "[permission] {what} from {} -> {}",
        uri.split('?').next().unwrap_or(""),
        if allow { "ALLOW" } else { "deny" }
    );
    if allow { req.allow() } else { req.deny() }
}

/// Where `ui/`, `web/` and `assets/zoom-sdk/` live: `$PENGUIN_ZOOM_DATA`,
/// else the installed copy (`/usr/share/penguin-zoom`, from the PKGBUILD),
/// else the source tree this binary was built from (development).
fn data_root() -> std::path::PathBuf {
    if let Some(d) = std::env::var_os("PENGUIN_ZOOM_DATA") {
        return d.into();
    }
    let installed = std::path::PathBuf::from("/usr/share/penguin-zoom");
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // A development build run from its own tree prefers that tree.
    let exe_in_tree = std::env::current_exe().map(|e| e.starts_with(&dev)).unwrap_or(false);
    if !exe_in_tree && installed.join("assets/zoom-sdk/VERSION").exists() { installed } else { dev }
}

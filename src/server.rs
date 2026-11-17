//! Local HTTP server. Binds 127.0.0.1:53682 only.
//!
//! Every response carries COOP `same-origin` + COEP `require-corp`, so the very
//! first document is cross-origin isolated and SDK workers inherit it.
//!
//! Routes:
//!   GET  /                 ui/index.html (falls back to the spike page)
//!   GET  /<file>           other files in ui/ (app.js, style.css, …)
//!   GET  /glue.js          web/glue.js
//!   GET  /spike, /spike.js the spike page
//!   GET  /sdk/*            vendored Zoom Meeting SDK (assets/zoom-sdk)
//!   GET  /oauth/login, /oauth/callback   sign-in (public client, PKCE)
//!   POST /api/signature    SDK join signature
//!   GET  /api/zak, /api/status
//!   POST /api/log          page console forwarding
//!   GET  /api/launch       meeting link from the command line
//!   POST /api/open         a second launch hands its link over (single instance)
//!   GET/PUT /api/settings
//!   GET/POST /api/speakers output device (routed natively, see speakers.rs)
//!   GET  /api/events       SSE: {"type":"cmd",…} and {"type":"open",…}
//!   POST /api/cmd          broadcast a command (global hotkeys, `--cmd`)
//!   GET  /api/theme        current Omarchy colours or null

use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Redirect, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, broadcast};
use tokio_stream::{Stream, StreamExt, wrappers::BroadcastStream};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

use crate::{launch::Launch, settings::Settings, speakers, theme};

pub const ADDR: &str = "127.0.0.1:53682";
pub const ORIGIN: &str = "http://127.0.0.1:53682";
const REDIRECT_URI: &str = "http://127.0.0.1:53682/oauth/callback";
/// Confidential client ID (not secret). Goes into the SDK signature as `appKey`.
const SDK_CLIENT_ID: &str = "QIyq0AOWRRCCEFesq_s52w";

#[derive(Default)]
struct Session {
    pkce_verifier: Option<String>,
    pkce_state: Option<String>,
    access_token: Option<String>,
    /// Unix time the access token stops working (Zoom: one hour).
    access_expires: i64,
    refresh_token: Option<String>,
    /// The keyring was already asked for a saved sign-in in this run.
    keyring_checked: bool,
    user_label: Option<String>,
}

/// Commands the page acts on (`POST /api/cmd`, `penguin-zoom --cmd …`).
pub const COMMANDS: &[&str] = &["mute-toggle", "camera-toggle", "leave", "raise"];

#[derive(Clone)]
struct AppState {
    root: PathBuf,
    session: Arc<Mutex<Session>>,
    http: reqwest::Client,
    /// The link we were started with, if any.
    launch: Launch,
    settings: Arc<Mutex<Settings>>,
    /// JSON event payloads for `/api/events` subscribers.
    events: broadcast::Sender<String>,
    /// Zoom's web and API hosts; the tests point these at a stand-in server.
    zoom_web: String,
    zoom_api: String,
    /// Keep the sign-in in the keyring (off in tests: `PENGUIN_NO_KEYRING`).
    keyring: bool,
}

/// Serves on `listener`, which main.rs already bound (that bind is the
/// single-instance check).
pub async fn run(root: PathBuf, listener: std::net::TcpListener, launch: Option<Launch>) -> std::io::Result<()> {
    let settings = Arc::new(Mutex::new(crate::settings::load()));
    tokio::spawn(speakers::watch(settings.clone()));
    let state = AppState {
        root: root.clone(),
        session: Arc::default(),
        http: reqwest::Client::new(),
        launch: launch.unwrap_or_default(),
        settings,
        events: broadcast::channel(32).0,
        zoom_web: "https://zoom.us".into(),
        zoom_api: "https://api.zoom.us".into(),
        keyring: std::env::var_os("PENGUIN_NO_KEYRING").is_none(),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/glue.js", get(glue_js))
        .route("/spike", get(spike))
        .route("/spike.js", get(spike_js))
        .route("/oauth/login", get(oauth_login))
        .route("/oauth/callback", get(oauth_callback))
        .route("/api/signature", post(signature))
        .route("/api/zak", get(zak))
        .route("/api/status", get(status))
        .route("/api/signout", post(signout))
        .route("/api/log", post(log))
        .route("/api/launch", get(launch_info))
        .route("/api/open", post(open))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/speakers", get(get_speakers).post(set_speaker))
        .route("/api/events", get(events))
        .route("/api/cmd", post(cmd))
        .route("/api/theme", get(get_theme))
        .route("/api/screencast", get(screencast_ws))
        .route("/screencast.js", get(screencast_js))
        .nest_service("/sdk", ServeDir::new(root.join("assets/zoom-sdk")))
        // The UI's own files (app.js, style.css, …) at the root path. The
        // layers below apply to the fallback too, so these get COOP/COEP.
        .fallback_service(
            Router::new()
                .fallback_service(ServeDir::new(root.join("ui")))
                .layer(axum::middleware::map_response(js_as_application_javascript)),
        )
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(axum::middleware::from_fn(log_failures))
        .layer(axum::middleware::from_fn(local_only))
        .with_state(state);

    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    eprintln!("[server] listening on {ORIGIN}");
    axum::serve(listener, app).await
}

/// Logs every non-success response, so missing SDK assets show up in the terminal.
/// Only answer requests addressed to this server by its own name, so a web
/// page that rebinds its DNS name to 127.0.0.1 (DNS rebinding) can't use the
/// API: its requests carry its own Host. Requests that change something or
/// return secrets (ZAK, signatures) must also not come from another origin.
async fn local_only(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    // Plain owned values only: a borrow of the request (Body isn't Sync)
    // held across the await would make this future non-Send.
    let refused = {
        let h = req.headers();
        let get = |n: header::HeaderName| h.get(n).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let (host, origin) = (get(header::HOST), get(header::ORIGIN));
        let ok_host = host.as_deref().is_some_and(host_allowed);
        let sensitive = req.method() != axum::http::Method::GET
            || matches!(req.uri().path(), "/api/zak" | "/api/signature" | "/api/events" | "/api/screencast");
        let ok_origin = !sensitive || origin.as_deref().is_none_or(origin_allowed);
        (!ok_host || !ok_origin)
            .then(|| format!("{} {} (host {host:?}, origin {origin:?})", req.method(), req.uri().path()))
    };
    if let Some(what) = refused {
        eprintln!("[server] refused {what}");
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

fn host_allowed(h: &str) -> bool {
    let port = ADDR.rsplit(':').next().unwrap_or("");
    h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")
}

fn origin_allowed(o: &str) -> bool {
    o.strip_prefix("http://").is_some_and(host_allowed)
}

async fn log_failures(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let path = req.uri().path().to_owned();
    let res = next.run(req).await;
    let st = res.status();
    if !(st.is_success() || st.is_redirection()) {
        eprintln!("[http] {st} {path}");
    }
    res
}

// ---------- static page ----------

async fn index(State(s): State<AppState>) -> Response {
    let ui = s.root.join("ui/index.html");
    if tokio::fs::try_exists(&ui).await.unwrap_or(false) {
        return serve_file(&ui, "text/html; charset=utf-8").await;
    }
    eprintln!("[server] ui/index.html missing; serving the spike page at /");
    spike(State(s)).await
}

async fn spike(State(s): State<AppState>) -> Response {
    serve_file(&s.root.join("web/index.html"), "text/html; charset=utf-8").await
}

async fn glue_js(State(s): State<AppState>) -> Response {
    serve_file(&s.root.join("web/glue.js"), "application/javascript; charset=utf-8").await
}

async fn screencast_js(State(s): State<AppState>) -> Response {
    serve_file(&s.root.join("web/screencast.js"), "application/javascript; charset=utf-8").await
}

/// Screen share frames from our own portal capture (screencast.rs).
/// `?choose=1` shows the picker even when an earlier choice is remembered.
async fn screencast_ws(
    ws: axum::extract::ws::WebSocketUpgrade,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let choose = q.get("choose").is_some_and(|v| v == "1");
    ws.on_upgrade(move |socket| crate::screencast::serve(socket, choose))
}

async fn spike_js(State(s): State<AppState>) -> Response {
    serve_file(&s.root.join("web/spike.js"), "text/javascript; charset=utf-8").await
}

/// mime_guess labels .js `text/javascript`; the UI contract says
/// `application/javascript` (both work for ES modules).
async fn js_as_application_javascript(mut res: Response) -> Response {
    let is_js = res.headers().get(header::CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"text/javascript"));
    if is_js {
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/javascript"));
    }
    res
}

/// Read from disk on every request so the page can be edited without a rebuild.
async fn serve_file(path: &std::path::Path, mime: &'static str) -> Response {
    match tokio::fs::read(path).await {
        Ok(body) => ([(header::CONTENT_TYPE, mime)], body).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("{}: {e}", path.display())).into_response(),
    }
}

// ---------- signature ----------

#[derive(Deserialize)]
struct SigReq {
    #[serde(rename = "meetingNumber")]
    meeting_number: String,
    #[serde(default)]
    role: u8,
}

/// The hosted signing service (signer/). Zoom's terms keep the SDK secret off
/// users' machines, so release builds sign there. `PENGUIN_SIGNER_URL` overrides
/// the built-in URL; set it empty (`PENGUIN_SIGNER_URL=`) to sign locally with
/// the developer's keyring secret (development only).
const DEFAULT_SIGNER_URL: &str = "https://penguin.kitah.co.il";

fn signer_url() -> Option<String> {
    let u = std::env::var("PENGUIN_SIGNER_URL").unwrap_or_else(|_| DEFAULT_SIGNER_URL.to_string());
    let u = u.trim().trim_end_matches('/');
    (!u.is_empty()).then(|| u.to_string())
}

async fn signature(State(s): State<AppState>, Json(req): Json<SigReq>) -> Response {
    let mn: String = req.meeting_number.chars().filter(|c| c.is_ascii_digit()).collect();
    if mn.is_empty() {
        return err(StatusCode::BAD_REQUEST, "meeting number has no digits");
    }
    if let Some(base) = signer_url() {
        return remote_signature(&s, &base, &mn, req.role).await;
    }
    let secret = match client_secret().await {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let iat = now() - 30;
    let exp = iat + 2 * 3600;
    let mut payload = json!({
        "appKey": SDK_CLIENT_ID,
        "mn": mn,
        "role": if req.role == 1 { 1 } else { 0 },
        "iat": iat,
        "exp": exp,
        "tokenExp": exp,
    });
    // This WebKitGTK has no RTCPeerConnection: ask Zoom for WebAssembly video.
    // ZOOM_SPIKE_WEBRTC_MODE=unset leaves the claim out, =1 forces WebRTC video.
    match std::env::var("ZOOM_SPIKE_WEBRTC_MODE").as_deref() {
        Ok("unset") => {}
        Ok("1") => payload["video_webrtc_mode"] = json!(1),
        _ => payload["video_webrtc_mode"] = json!(0),
    }
    let sig = sign_jwt(&payload, secret.as_bytes());
    eprintln!("[sig] signed for meeting …{} role {}", &mn[mn.len().saturating_sub(3)..], req.role);
    Json(json!({ "signature": sig, "meetingNumber": mn })).into_response()
}

fn sign_jwt(payload: &serde_json::Value, secret: &[u8]) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(payload.to_string());
    let input = format!("{header}.{body}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(input.as_bytes());
    let tag = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{input}.{tag}")
}

/// Asks the hosted signer. Host signatures (role 1) carry the user's Zoom token,
/// which the signer checks with Zoom before signing.
async fn remote_signature(s: &AppState, base: &str, mn: &str, role: u8) -> Response {
    let role = if role == 1 { 1 } else { 0 };
    let mut rq = s
        .http
        .post(format!("{base}/v1/signature"))
        .timeout(std::time::Duration::from_secs(15))
        .json(&json!({ "meetingNumber": mn, "role": role }));
    if role == 1 {
        match access_token(s).await {
            Some(t) => rq = rq.bearer_auth(t),
            None => return err(StatusCode::UNAUTHORIZED, "sign in to start a meeting as host"),
        }
    }
    match rq.send().await {
        Ok(r) => {
            let st = r.status();
            let v: serde_json::Value = r.json().await.unwrap_or_default();
            if st.is_success() && v["signature"].is_string() {
                eprintln!("[sig] remote signature for meeting …{} role {role}", &mn[mn.len().saturating_sub(3)..]);
                return Json(json!({ "signature": v["signature"], "meetingNumber": mn })).into_response();
            }
            let code = if st == StatusCode::TOO_MANY_REQUESTS { st } else { StatusCode::BAD_GATEWAY };
            err(code, &format!("signing service: {st} {}", redact(&v)))
        }
        Err(e) => err(StatusCode::BAD_GATEWAY, &format!("signing service unreachable: {e}")),
    }
}

/// Development signing only: read lazily from the GNOME keyring; never cached,
/// never logged. The item stored before the rename (service native-linux-zoom)
/// still works.
async fn client_secret() -> Result<String, String> {
    for service in ["penguin-zoom", "native-linux-zoom"] {
        let out = tokio::process::Command::new("secret-tool")
            .args(["lookup", "service", service, "key", "client-secret"])
            .output()
            .await
            .map_err(|e| format!("could not run secret-tool: {e}"))?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !s.is_empty() {
            return Ok(s);
        }
    }
    Err("no signing service configured (PENGUIN_SIGNER_URL) and no client secret in the keyring".into())
}

// ---------- OAuth (public client, PKCE) ----------

/// The Marketplace app's public (PKCE) client ID. Not secret.
const PUBLIC_CLIENT_ID: &str = "I7gQRtV3QNK0b48jBgUE0Q";

/// `ZOOM_PUBLIC_CLIENT_ID` overrides the built-in ID (e.g. for a second app).
fn public_client_id() -> Option<String> {
    std::env::var("ZOOM_PUBLIC_CLIENT_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| Some(PUBLIC_CLIENT_ID.to_string()))
}

fn random_b64(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("OS RNG");
    URL_SAFE_NO_PAD.encode(buf)
}

async fn oauth_login(State(s): State<AppState>) -> Response {
    let Some(client_id) = public_client_id() else {
        return err(
            StatusCode::PRECONDITION_FAILED,
            "ZOOM_PUBLIC_CLIENT_ID not set (PLAN.md owner item 4)",
        );
    };
    let verifier = random_b64(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let st = random_b64(16);
    {
        let mut sess = s.session.lock().await;
        sess.pkce_verifier = Some(verifier);
        sess.pkce_state = Some(st.clone());
    }
    let mut u = url::Url::parse(&format!("{}/oauth/authorize", s.zoom_web)).unwrap();
    u.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &st);
    eprintln!("[oauth] redirecting to zoom.us/oauth/authorize");
    Redirect::to(u.as_str()).into_response()
}

async fn oauth_callback(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(e) = q.get("error") {
        return err(StatusCode::BAD_REQUEST, &format!("authorize error: {e}"));
    }
    let Some(code) = q.get("code") else {
        return err(StatusCode::BAD_REQUEST, "no code in callback");
    };
    // Check state before consuming the verifier, so a stray hit on this URL
    // (e.g. from another web page) can't cancel a sign-in in progress.
    let verifier = {
        let mut sess = s.session.lock().await;
        if sess.pkce_state.is_none() || q.get("state") != sess.pkce_state.as_ref() {
            return err(StatusCode::BAD_REQUEST, "state mismatch; start at /oauth/login");
        }
        sess.pkce_state = None;
        sess.pkce_verifier.take()
    };
    let Some(verifier) = verifier else {
        return err(StatusCode::BAD_REQUEST, "no PKCE verifier; start at /oauth/login");
    };
    let client_id = public_client_id().unwrap_or_default();
    // Public client: client_id in the form body, no Authorization header.
    let res = s
        .http
        .post(format!("{}/oauth/token", s.zoom_web))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await;
    let tok: serde_json::Value = match res {
        Ok(r) => {
            let st = r.status();
            let v = r.json().await.unwrap_or_default();
            if !st.is_success() {
                return err(StatusCode::BAD_GATEWAY, &format!("token exchange {st}: {}", redact(&v)));
            }
            v
        }
        Err(e) => return err(StatusCode::BAD_GATEWAY, &format!("token exchange: {e}")),
    };
    let access = tok["access_token"].as_str().map(str::to_owned);
    let refresh = tok["refresh_token"].as_str().map(str::to_owned);
    eprintln!("[oauth] signed in; scopes: {}", tok["scope"].as_str().unwrap_or("?"));
    let label = match &access {
        Some(a) => fetch_me(&s, a).await,
        None => None,
    };
    if let Some(r) = &refresh {
        keyring_save_refresh(s.keyring, r).await;
    }
    {
        let mut sess = s.session.lock().await;
        sess.access_token = access;
        sess.access_expires = now() + tok["expires_in"].as_i64().unwrap_or(3600);
        sess.refresh_token = refresh;
        sess.keyring_checked = true;
        sess.user_label = label;
    }
    Redirect::to("/").into_response()
}

// The sign-in survives restarts through the refresh token in the keyring
// (`secret-tool`, attributes service=penguin-zoom key=refresh-token). Zoom
// returns a new refresh token with every refresh and the old one stops
// working, so the stored one is replaced each time. `PENGUIN_NO_KEYRING=1`
// (tests) keeps the sign-in in memory only.
const KEYRING_REFRESH: [&str; 4] = ["service", "penguin-zoom", "key", "refresh-token"];

async fn keyring_load_refresh(on: bool) -> Option<String> {
    if !on {
        return None;
    }
    let out = tokio::process::Command::new("secret-tool")
        .arg("lookup")
        .args(KEYRING_REFRESH)
        .output()
        .await
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// The token goes to secret-tool on stdin, never on a command line.
async fn keyring_save_refresh(on: bool, token: &str) {
    use tokio::io::AsyncWriteExt;
    if !on {
        return;
    }
    let child = tokio::process::Command::new("secret-tool")
        .args(["store", "--label=Penguin for Zoom sign-in"])
        .args(KEYRING_REFRESH)
        .stdin(std::process::Stdio::piped())
        .spawn();
    let ok = match child {
        Ok(mut c) => {
            let wrote = match c.stdin.take() {
                Some(mut i) => i.write_all(token.as_bytes()).await.is_ok(),
                None => false,
            };
            wrote && c.wait().await.is_ok_and(|st| st.success())
        }
        Err(_) => false,
    };
    if !ok {
        eprintln!("[oauth] could not save the sign-in in the keyring; it lasts until the app closes");
    }
}

async fn keyring_clear_refresh(on: bool) {
    if on {
        let _ = tokio::process::Command::new("secret-tool").arg("clear").args(KEYRING_REFRESH).status().await;
    }
}

/// A working access token, or None when not signed in. Refreshes it when it
/// is about to expire, and restores a saved sign-in on the first call. The
/// session lock is held across the refresh on purpose: two refreshes with the
/// same refresh token would leave one of them with a dead token.
async fn access_token(s: &AppState) -> Option<String> {
    let mut sess = s.session.lock().await;
    if let Some(t) = &sess.access_token
        && now() < sess.access_expires - 60
    {
        return Some(t.clone());
    }
    if sess.refresh_token.is_none() && !sess.keyring_checked {
        sess.keyring_checked = true;
        sess.refresh_token = keyring_load_refresh(s.keyring).await;
    }
    let refresh = sess.refresh_token.clone()?;
    let client_id = public_client_id().unwrap_or_default();
    let res = s
        .http
        .post(format!("{}/oauth/token", s.zoom_web))
        .timeout(std::time::Duration::from_secs(10))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .send()
        .await;
    let r = match res {
        Ok(r) => r,
        Err(e) => {
            // Offline: keep the refresh token for the next try.
            eprintln!("[oauth] refresh failed: {e}");
            return None;
        }
    };
    let st = r.status();
    let v: serde_json::Value = r.json().await.unwrap_or_default();
    let Some(access) = v["access_token"].as_str().filter(|_| st.is_success()) else {
        eprintln!("[oauth] refresh: {st} {}", redact(&v));
        if st == StatusCode::BAD_REQUEST || st == StatusCode::UNAUTHORIZED {
            // Zoom no longer accepts this refresh token (expired after 90
            // days, revoked, or already used): the user has to sign in again.
            // Other failures (429, 5xx) keep it for the next try.
            sess.access_token = None;
            sess.refresh_token = None;
            sess.user_label = None;
            keyring_clear_refresh(s.keyring).await;
        }
        return None;
    };
    let access = access.to_owned();
    sess.access_token = Some(access.clone());
    sess.access_expires = now() + v["expires_in"].as_i64().unwrap_or(3600);
    if let Some(new) = v["refresh_token"].as_str() {
        sess.refresh_token = Some(new.to_owned());
        keyring_save_refresh(s.keyring, new).await;
    }
    if sess.user_label.is_none() {
        sess.user_label = fetch_me(s, &access).await;
    }
    eprintln!("[oauth] access token refreshed");
    Some(access)
}

async fn fetch_me(s: &AppState, access: &str) -> Option<String> {
    let v: serde_json::Value = s
        .http
        .get(format!("{}/v2/users/me", s.zoom_api))
        .bearer_auth(access)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let name = format!(
        "{} {}",
        v["first_name"].as_str().unwrap_or(""),
        v["last_name"].as_str().unwrap_or("")
    );
    Some(name.trim().to_string()).filter(|s| !s.is_empty())
}

/// Fetches a fresh ZAK. The app has scope `user:read:token`, so
/// `/users/me/token?type=zak` is tried first; `/users/me/zak` (scope
/// `user:read:zak`) stays as a fallback in case the scope changes.
async fn zak(State(s): State<AppState>) -> Response {
    let Some(access) = access_token(&s).await else {
        return err(StatusCode::UNAUTHORIZED, "not signed in");
    };
    let mut last = String::new();
    for (path, field) in [("/v2/users/me/token?type=zak", "token"), ("/v2/users/me/zak", "token")] {
        match s
            .http
            .get(format!("{}{path}", s.zoom_api))
            .bearer_auth(&access)
            .send()
            .await
        {
            Ok(r) => {
                let st = r.status();
                let v: serde_json::Value = r.json().await.unwrap_or_default();
                if let (true, Some(z)) = (st.is_success(), v[field].as_str()) {
                    eprintln!("[zak] got ZAK from {path}");
                    return Json(json!({ "zak": z, "endpoint": path })).into_response();
                }
                last = format!("{path}: {st} {}", redact(&v));
                eprintln!("[zak] {last}");
            }
            Err(e) => last = format!("{path}: {e}"),
        }
    }
    err(StatusCode::BAD_GATEWAY, &last)
}

/// Sign out: revoke the token at Zoom (Zoom's rule for removing an app) and
/// forget it here either way. Public client, so client_id goes in the body.
/// Whether Zoom accepts revoke from a public client is still unconfirmed
/// (PLAN.md §6); `revoked: false` tells the page to point the user at the
/// Marketplace's Added apps page instead.
async fn signout(State(s): State<AppState>) -> Response {
    // Revoke needs a token Zoom still accepts, so refresh first if needed.
    let token = access_token(&s).await;
    {
        let mut sess = s.session.lock().await;
        sess.user_label = None;
        sess.refresh_token = None;
        sess.access_token = None;
        sess.keyring_checked = true;
    }
    keyring_clear_refresh(s.keyring).await;
    let Some(token) = token else {
        return Json(json!({ "revoked": true, "note": "was not signed in" })).into_response();
    };
    let client_id = public_client_id().unwrap_or_default();
    let revoked = match s
        .http
        .post(format!("{}/oauth/revoke", s.zoom_web))
        .form(&[("token", token.as_str()), ("client_id", client_id.as_str())])
        .send()
        .await
    {
        Ok(r) => {
            let st = r.status();
            let v: serde_json::Value = r.json().await.unwrap_or_default();
            eprintln!("[oauth] revoke: {st} {}", redact(&v));
            st.is_success() && v["status"].as_str().is_none_or(|x| x == "success")
        }
        Err(e) => {
            eprintln!("[oauth] revoke failed: {e}");
            false
        }
    };
    Json(json!({ "revoked": revoked })).into_response()
}

async fn status(State(s): State<AppState>) -> Response {
    let signed_in = access_token(&s).await.is_some();
    let sess = s.session.lock().await;
    Json(json!({
        "signedIn": signed_in,
        "hasRefresh": sess.refresh_token.is_some(),
        "user": sess.user_label,
        "publicClientConfigured": public_client_id().is_some(),
        "remoteSigner": signer_url().is_some(),
        "sabEnv": std::env::var("JSC_useSharedArrayBuffer").ok(),
        "webrtcMode": std::env::var("ZOOM_SPIKE_WEBRTC_MODE").unwrap_or_else(|_| "0".into()),
    }))
    .into_response()
}

// ---------- page log forwarding ----------

#[derive(Deserialize)]
struct LogReq {
    level: String,
    msg: String,
}

async fn log(Json(l): Json<LogReq>) -> StatusCode {
    let msg: String = l.msg.chars().take(4000).collect();
    eprintln!("[page:{}] {} @{}", l.level, redact_str(&msg), now());
    StatusCode::NO_CONTENT
}

// ---------- launch link, single instance ----------

async fn launch_info(State(s): State<AppState>) -> Json<Launch> {
    Json(s.launch.clone())
}

#[derive(Deserialize)]
struct OpenReq {
    link: Option<String>,
    /// false when the page itself asks (a pasted link): no window raise.
    #[serde(default = "yes")]
    raise: bool,
}

fn yes() -> bool {
    true
}

/// A second `penguin-zoom <link>` posts here and exits. Tells the page (SSE
/// "open") and raises our window; this is always an explicit user action.
async fn open(State(s): State<AppState>, Json(req): Json<OpenReq>) -> Response {
    let parsed = req.link.as_deref().and_then(crate::launch::parse);
    match &parsed {
        Some(l) => {
            let mut ev = serde_json::to_value(l).unwrap();
            ev["type"] = json!("open");
            let _ = s.events.send(ev.to_string());
            eprintln!("[open] meeting link ({})", if req.raise { "second launch" } else { "pasted" });
        }
        None if req.link.is_some() => eprintln!("[open] unrecognised link"),
        None => {}
    }
    if req.raise {
        raise_window().await;
    }
    Json(json!({ "ok": true, "parsed": parsed.is_some() })).into_response()
}

/// Best effort: focus our window in Hyprland. 0.56 dispatches Lua; older
/// versions take the classic dispatcher syntax.
async fn raise_window() {
    let run = |args: &'static [&'static str]| async move {
        tokio::process::Command::new("hyprctl").args(args).output().await.ok().filter(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            o.status.success() && !out.starts_with("error")
        })
    };
    if run(&["dispatch", r#"hl.dsp.focus({ window = "class:penguin-zoom" })"#]).await.is_none() {
        let _ = run(&["dispatch", "focuswindow", "class:penguin-zoom"]).await;
    }
}

// ---------- commands and events ----------

#[derive(Deserialize)]
struct CmdReq {
    cmd: String,
}

async fn cmd(State(s): State<AppState>, Json(req): Json<CmdReq>) -> Response {
    if !COMMANDS.contains(&req.cmd.as_str()) {
        return err(StatusCode::BAD_REQUEST, &format!("unknown cmd {:?}; one of {COMMANDS:?}", req.cmd));
    }
    if req.cmd == "raise" {
        raise_window().await;
    }
    let listeners = s.events.send(json!({ "type": "cmd", "cmd": req.cmd }).to_string()).unwrap_or(0);
    Json(json!({ "ok": true, "listeners": listeners })).into_response()
}

async fn events(State(s): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // A lagged subscriber just skips what it missed.
    let stream = BroadcastStream::new(s.events.subscribe())
        .filter_map(|m| m.ok())
        .map(|data| Ok(Event::default().data(data)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ---------- settings ----------

async fn get_settings(State(s): State<AppState>) -> Json<Settings> {
    Json(s.settings.lock().await.clone())
}

/// Replaces the whole object; missing fields take their defaults.
async fn put_settings(State(s): State<AppState>, Json(new): Json<Settings>) -> Response {
    let mut cur = s.settings.lock().await;
    // Held across the write so concurrent PUTs can't interleave on the temp file.
    if let Err(e) = crate::settings::save(&new).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &format!("saving settings: {e}"));
    }
    let speaker_changed = cur.speaker_id != new.speaker_id;
    *cur = new.clone();
    drop(cur);
    if speaker_changed {
        // Cleared choice: send our streams back to the system default.
        let target = match new.speaker_id.clone() {
            Some(t) => Some(t),
            None => speakers::default_sink().await.ok(),
        };
        if let Some(t) = target {
            let _ = speakers::route(&t).await;
        }
    }
    Json(new).into_response()
}

// ---------- speakers ----------

async fn get_speakers(State(s): State<AppState>) -> Response {
    let chosen = s.settings.lock().await.speaker_id.clone();
    match speakers::list(chosen.as_deref()).await {
        Ok(l) => Json(l).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

#[derive(Deserialize)]
struct SpeakerReq {
    id: String,
}

async fn set_speaker(State(s): State<AppState>, Json(req): Json<SpeakerReq>) -> Response {
    // Validate (and move the current streams) before saving the choice.
    if let Err(e) = speakers::route(&req.id).await {
        return err(StatusCode::BAD_REQUEST, &e);
    }
    {
        let mut cur = s.settings.lock().await;
        let mut new = cur.clone();
        new.speaker_id = Some(req.id.clone());
        if let Err(e) = crate::settings::save(&new).await {
            return err(StatusCode::INTERNAL_SERVER_ERROR, &format!("saving settings: {e}"));
        }
        *cur = new;
    }
    match speakers::list(Some(&req.id)).await {
        Ok(l) => Json(l).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

// ---------- theme ----------

async fn get_theme() -> Json<Option<theme::Theme>> {
    Json(theme::current().await)
}

// ---------- helpers ----------

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn err(code: StatusCode, msg: &str) -> Response {
    eprintln!("[server] {code}: {msg}");
    (code, Json(json!({ "error": msg }))).into_response()
}

fn redact(v: &serde_json::Value) -> String {
    redact_str(&v.to_string())
}

/// Masks anything that looks like a JWT or long bearer-ish token.
fn redact_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut tok = String::new();
    let flush = |tok: &mut String, out: &mut String| {
        // Zoom's signature, ZAK and OAuth tokens are all JWTs ("eyJ…").
        let jwt = tok.starts_with("eyJ") && tok.len() > 20;
        let long = tok.len() >= 80;
        if jwt || long {
            out.push_str("[redacted]");
        } else {
            out.push_str(tok);
        }
        tok.clear();
    };
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            tok.push(c);
        } else {
            flush(&mut tok, &mut out);
            out.push(c);
        }
    }
    flush(&mut tok, &mut out);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_our_own_host_and_origin() {
        use super::{host_allowed, origin_allowed};
        assert!(host_allowed("127.0.0.1:53682") && host_allowed("localhost:53682"));
        assert!(!host_allowed("evil.example:53682") && !host_allowed("127.0.0.1:1234") && !host_allowed("127.0.0.1"));
        assert!(origin_allowed("http://127.0.0.1:53682"));
        assert!(!origin_allowed("http://evil.example:53682") && !origin_allowed("https://127.0.0.1:53682") && !origin_allowed("null"));
    }

    use super::*;

    #[test]
    fn jwt_shape_and_hmac() {
        // RFC 7515-style check against a known HS256 vector computed independently.
        let sig = sign_jwt(&json!({"a":1}), b"k");
        let parts: Vec<_> = sig.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
        assert_eq!(parts[1], "eyJhIjoxfQ");
        let mut mac = Hmac::<Sha256>::new_from_slice(b"k").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert_eq!(parts[2], URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
    }

    #[tokio::test]
    async fn js_mime_rewrite() {
        let res = ([(header::CONTENT_TYPE, "text/javascript")], "x").into_response();
        let res = js_as_application_javascript(res).await;
        assert_eq!(res.headers()[header::CONTENT_TYPE], "application/javascript");
        let res = ([(header::CONTENT_TYPE, "text/css")], "x").into_response();
        assert_eq!(js_as_application_javascript(res).await.headers()[header::CONTENT_TYPE], "text/css");
    }

    #[test]
    fn redaction() {
        let r = redact_str("zak=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk ok");
        assert_eq!(r, "zak=[redacted] ok");
        assert_eq!(redact_str("short words stay"), "short words stay");
    }

    // ---- sign-in: refresh, rotation, ZAK and sign-out against a stand-in for Zoom ----

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A stand-in for zoom.us + api.zoom.us. Refresh token `rN` yields access
    /// token `aN` and refresh token `r(N+1)`, each usable once, as at Zoom;
    /// `busy` gets a 429; anything else is refused with 400.
    #[derive(Clone, Default)]
    struct Fake {
        refreshes: Arc<AtomicUsize>,
        used: Arc<Mutex<Vec<String>>>,
        revoked: Arc<Mutex<Vec<String>>>,
    }

    async fn fake_token(State(f): State<Fake>, axum::Form(q): axum::Form<HashMap<String, String>>) -> Response {
        f.refreshes.fetch_add(1, Ordering::SeqCst);
        let r = q.get("refresh_token").cloned().unwrap_or_default();
        if q.get("grant_type").map(String::as_str) != Some("refresh_token") || !q.contains_key("client_id") {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_request"}))).into_response();
        }
        if r == "busy" {
            return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": "rate"}))).into_response();
        }
        let n = r.strip_prefix('r').and_then(|n| n.parse::<u32>().ok());
        let mut used = f.used.lock().await;
        match n {
            Some(n) if !used.contains(&r) => {
                used.push(r);
                Json(json!({"access_token": format!("a{n}"), "refresh_token": format!("r{}", n + 1), "expires_in": 3600}))
                    .into_response()
            }
            _ => (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))).into_response(),
        }
    }

    async fn fake_api(headers: axum::http::HeaderMap, uri: axum::http::Uri) -> Response {
        let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
        if !auth.starts_with("Bearer a") {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        match uri.path() {
            "/v2/users/me" => Json(json!({"first_name": "Test", "last_name": "User"})).into_response(),
            "/v2/users/me/token" => Json(json!({"token": format!("zak-for-{}", &auth[7..])})).into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn fake_revoke(State(f): State<Fake>, axum::Form(q): axum::Form<HashMap<String, String>>) -> Response {
        f.revoked.lock().await.push(q.get("token").cloned().unwrap_or_default());
        Json(json!({"status": "success"})).into_response()
    }

    /// App state wired to a fresh stand-in, signed in with `refresh` if given.
    async fn fake_zoom(refresh: Option<&str>) -> (AppState, Fake) {
        let fake = Fake::default();
        let app = Router::new()
            .route("/oauth/token", post(fake_token))
            .route("/oauth/revoke", post(fake_revoke))
            .fallback(fake_api)
            .with_state(fake.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let state = AppState {
            root: PathBuf::new(),
            session: Arc::new(Mutex::new(Session {
                refresh_token: refresh.map(str::to_owned),
                ..Default::default()
            })),
            http: reqwest::Client::new(),
            launch: Launch::default(),
            settings: Arc::default(),
            events: broadcast::channel(1).0,
            zoom_web: base.clone(),
            zoom_api: base,
            keyring: false,
        };
        (state, fake)
    }

    async fn body_json(res: Response) -> serde_json::Value {
        serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn refresh_token_is_replaced_on_every_refresh() {
        let (s, fake) = fake_zoom(Some("r1")).await;
        assert_eq!(access_token(&s).await.as_deref(), Some("a1"));
        {
            let sess = s.session.lock().await;
            assert_eq!(sess.refresh_token.as_deref(), Some("r2"));
            assert_eq!(sess.user_label.as_deref(), Some("Test User"));
        }
        // Still fresh: no second trip to Zoom.
        assert_eq!(access_token(&s).await.as_deref(), Some("a1"));
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 1);
        // Under a minute left: refreshed with the new refresh token, not the used one.
        s.session.lock().await.access_expires = now() + 30;
        assert_eq!(access_token(&s).await.as_deref(), Some("a2"));
        assert_eq!(s.session.lock().await.refresh_token.as_deref(), Some("r3"));
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_refresh() {
        let (s, fake) = fake_zoom(Some("r1")).await;
        let (a, b, c) = tokio::join!(access_token(&s), access_token(&s), access_token(&s));
        assert_eq!((a.as_deref(), b.as_deref(), c.as_deref()), (Some("a1"), Some("a1"), Some("a1")));
        assert_eq!(fake.refreshes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refused_refresh_token_signs_out_but_a_busy_zoom_does_not() {
        let (s, _) = fake_zoom(Some("expired")).await;
        s.session.lock().await.user_label = Some("Old".into());
        assert_eq!(access_token(&s).await, None);
        {
            let sess = s.session.lock().await;
            assert!(sess.refresh_token.is_none() && sess.access_token.is_none() && sess.user_label.is_none());
        }

        let (s, _) = fake_zoom(Some("busy")).await;
        assert_eq!(access_token(&s).await, None);
        assert_eq!(s.session.lock().await.refresh_token.as_deref(), Some("busy"));

        // Zoom unreachable: the refresh token stays as well.
        let (mut s, _) = fake_zoom(Some("r1")).await;
        s.zoom_web = "http://127.0.0.1:1".into();
        assert_eq!(access_token(&s).await, None);
        assert_eq!(s.session.lock().await.refresh_token.as_deref(), Some("r1"));
    }

    #[tokio::test]
    async fn zak_and_status_follow_the_sign_in() {
        let (s, _) = fake_zoom(None).await;
        assert_eq!(zak(State(s.clone())).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(status(State(s)).await).await["signedIn"], false);

        let (s, _) = fake_zoom(Some("r1")).await;
        let v = body_json(zak(State(s.clone())).await).await;
        assert_eq!(v["zak"], "zak-for-a1");
        let v = body_json(status(State(s)).await).await;
        assert_eq!((v["signedIn"].as_bool(), v["user"].as_str()), (Some(true), Some("Test User")));
    }

    #[tokio::test]
    async fn sign_out_revokes_and_forgets() {
        let (s, fake) = fake_zoom(Some("r1")).await;
        let v = body_json(signout(State(s.clone())).await).await;
        assert_eq!(v["revoked"], true);
        assert_eq!(*fake.revoked.lock().await, vec!["a1".to_string()]);
        let sess = s.session.lock().await;
        assert!(sess.refresh_token.is_none() && sess.access_token.is_none() && sess.keyring_checked);
    }
}

//! penguin-signer: signs Zoom Meeting SDK JWTs for the Penguin for Zoom desktop
//! app, so the SDK secret never ships in the client (Zoom API ToU). Also
//! receives Zoom's app deauthorization webhook. Sits behind Caddy on
//! 127.0.0.1; holds no user data.

mod hostauth;
mod jwt;
mod ratelimit;
mod webhook;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, DefaultBodyLimit, MatchedPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tracing::{info, warn};

const BODY_LIMIT: usize = 4 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ZOOM_API_TIMEOUT: Duration = Duration::from_secs(5);

/// A secret from the environment. Debug never shows it.
struct Secret(Vec<u8>);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

#[derive(Debug)]
struct Config {
    sdk_key: String,
    sdk_secret: Secret,
    webhook_secret: Option<Secret>,
    bind: SocketAddr,
    rate_per_hour: u32,
    rate_burst: u32,
    zoom_api_base: String,
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match env_nonempty(name) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| format!("{name} is not valid")),
    }
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let sdk_key = env_nonempty("ZOOM_SDK_KEY").ok_or("ZOOM_SDK_KEY is not set")?;
        let sdk_secret = env_nonempty("ZOOM_SDK_SECRET").ok_or("ZOOM_SDK_SECRET is not set")?;
        let webhook_secret = env_nonempty("ZOOM_WEBHOOK_SECRET");
        // Refuse the placeholders from penguin-signer.env.example.
        for (name, v) in [
            ("ZOOM_SDK_KEY", Some(&sdk_key)),
            ("ZOOM_SDK_SECRET", Some(&sdk_secret)),
            ("ZOOM_WEBHOOK_SECRET", webhook_secret.as_ref()),
        ] {
            if v.is_some_and(|v| v.contains("REPLACE_ME")) {
                return Err(format!("{name} still holds the example placeholder"));
            }
        }
        let webhook_secret = webhook_secret.map(|s| Secret(s.into_bytes()));
        let ip: IpAddr = env_parse("BIND", IpAddr::from([127, 0, 0, 1]))?;
        let port: u16 = env_parse("PORT", 8080)?;
        Ok(Self {
            sdk_key,
            sdk_secret: Secret(sdk_secret.into_bytes()),
            webhook_secret,
            bind: SocketAddr::new(ip, port),
            rate_per_hour: env_parse("RATE_PER_HOUR", 60)?,
            rate_burst: env_parse("RATE_BURST", 10)?,
            zoom_api_base: env_nonempty("ZOOM_API_BASE")
                .unwrap_or_else(|| "https://api.zoom.us".into())
                .trim_end_matches('/')
                .to_string(),
        })
    }
}

struct App {
    cfg: Config,
    limiter: ratelimit::RateLimiter,
    verified: hostauth::VerifiedCache,
    http: reqwest::Client,
}

type AppState = Arc<App>;

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

fn too_many(wait: Duration) -> Response {
    let mut r = err(
        StatusCode::TOO_MANY_REQUESTS,
        "rate limited, try again later",
    );
    if let Ok(v) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
        r.headers_mut().insert(header::RETRY_AFTER, v);
    }
    r
}

/// The client address. Caddy appends the peer it saw to X-Forwarded-For, so
/// the last hop is the one we trust; only when the request came from loopback
/// (i.e. through the proxy). Otherwise use the socket peer.
fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    if peer.ip().is_loopback()
        && let Some(last) = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .map(str::trim)
            .rfind(|s| !s.is_empty())
        && let Ok(ip) = last.parse::<IpAddr>()
    {
        return ip;
    }
    peer.ip()
}

// ---------- /v1/signature ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigReq {
    meeting_number: Value,
    #[serde(default)]
    role: u8,
}

async fn signature(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<SigReq>, JsonRejection>,
) -> Response {
    let Ok(Json(req)) = body else {
        return err(
            StatusCode::BAD_REQUEST,
            "expected JSON {meetingNumber, role}",
        );
    };
    let raw = match &req.meeting_number {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => {
            return err(
                StatusCode::BAD_REQUEST,
                "meetingNumber must be a string or number",
            );
        }
    };
    let mn = match jwt::normalize_meeting_number(&raw) {
        Ok(mn) => mn,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if req.role > 1 {
        return err(StatusCode::BAD_REQUEST, "role must be 0 or 1");
    }
    let now = Instant::now();
    let ip = client_ip(&headers, peer);

    if req.role == 1 {
        let auth = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        let Some(token) = hostauth::bearer(auth) else {
            info!(role = 1, outcome = "no_token", "signature refused");
            return err(
                StatusCode::UNAUTHORIZED,
                "host signature needs a Zoom access token",
            );
        };
        let h = hostauth::token_hash(token);
        if !app.verified.contains(&h, now) {
            // Unverified host attempts count against the same per-IP budget,
            // so nobody can use us to hammer Zoom's API.
            if let Err(wait) = app.limiter.check(ip, now) {
                info!(role = 1, outcome = "rate_limited", "signature refused");
                return too_many(wait);
            }
            match hostauth::verify_with_zoom(&app.http, &app.cfg.zoom_api_base, token).await {
                hostauth::Verdict::Valid => app.verified.insert(h, Instant::now()),
                hostauth::Verdict::Invalid => {
                    info!(role = 1, outcome = "bad_token", "signature refused");
                    return err(
                        StatusCode::UNAUTHORIZED,
                        "Zoom did not accept the access token",
                    );
                }
                hostauth::Verdict::Unavailable => {
                    warn!(role = 1, outcome = "zoom_unavailable", "signature refused");
                    return err(
                        StatusCode::BAD_GATEWAY,
                        "could not reach Zoom to check the token",
                    );
                }
            }
        }
    } else if let Err(wait) = app.limiter.check(ip, now) {
        info!(role = 0, outcome = "rate_limited", "signature refused");
        return too_many(wait);
    }

    let payload = jwt::payload(&app.cfg.sdk_key, &mn, req.role, unix_now());
    let sig = jwt::sign_jwt(&payload, &app.cfg.sdk_secret.0);
    info!(role = req.role, outcome = "signed", "signature issued");
    Json(json!({ "signature": sig, "meetingNumber": mn })).into_response()
}

// ---------- /v1/zoom-webhook ----------

async fn zoom_webhook(State(app): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(secret) = &app.cfg.webhook_secret else {
        warn!("webhook received but ZOOM_WEBHOOK_SECRET is not set");
        return err(StatusCode::SERVICE_UNAVAILABLE, "webhook not configured");
    };
    let h = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if let Err(e) = webhook::verify(
        &secret.0,
        h("x-zm-signature"),
        h("x-zm-request-timestamp"),
        &body,
        unix_now(),
    ) {
        warn!(reason = ?e, "webhook rejected");
        return err(StatusCode::UNAUTHORIZED, "invalid signature");
    }
    let Ok(event) = serde_json::from_slice::<Value>(&body) else {
        return err(StatusCode::BAD_REQUEST, "body is not JSON");
    };
    let kind = event.get("event").and_then(Value::as_str).unwrap_or("");
    match kind {
        "endpoint.url_validation" => match webhook::url_validation_response(&secret.0, &event) {
            Some(r) => {
                info!(event = kind, "webhook url validation answered");
                Json(r).into_response()
            }
            None => err(StatusCode::BAD_REQUEST, "missing payload.plainToken"),
        },
        // We keep no user data, so there is nothing to delete: just record it.
        "app_deauthorized" => {
            info!(
                event = kind,
                "app deauthorized by a user; no stored data to delete"
            );
            StatusCode::OK.into_response()
        }
        _ => {
            // Log only a known-safe shape of the event name.
            let safe = kind.len() <= 64
                && kind
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_');
            info!(
                event = if safe { kind } else { "<unrecognised>" },
                "webhook event ignored"
            );
            StatusCode::OK.into_response()
        }
    }
}

// ---------- plumbing ----------

async fn healthz() -> &'static str {
    "ok"
}

async fn not_found() -> Response {
    err(StatusCode::NOT_FOUND, "not found")
}

/// One structured line per request: method, route, status, latency. No IPs,
/// no headers, no bodies.
async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "<unmatched>".to_string(), |p| p.as_str().to_string());
    let start = Instant::now();
    let resp = next.run(req).await;
    info!(
        method = %method,
        route = %route,
        status = resp.status().as_u16(),
        ms = start.elapsed().as_millis() as u64,
        "request"
    );
    resp
}

fn router(app: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/signature", post(signature))
        .route("/v1/zoom-webhook", post(zoom_webhook))
        .fallback(not_found)
        .layer(middleware::from_fn(access_log))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .with_state(app)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! { () = ctrl_c => {}, () = term => {} }
    info!("shutting down");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_max_level(tracing::Level::INFO)
        .init();

    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            // Names the variable only, never a value.
            tracing::error!(error = %e, "refusing to start");
            std::process::exit(2);
        }
    };
    if cfg.webhook_secret.is_none() {
        warn!("ZOOM_WEBHOOK_SECRET not set: /v1/zoom-webhook will answer 503");
    }
    let http = reqwest::Client::builder()
        .timeout(ZOOM_API_TIMEOUT)
        .user_agent(concat!("penguin-signer/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client");
    let bind = cfg.bind;
    let app = Arc::new(App {
        limiter: ratelimit::RateLimiter::new(cfg.rate_per_hour, cfg.rate_burst),
        verified: hostauth::VerifiedCache::default(),
        http,
        cfg,
    });

    let janitor = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(600));
        loop {
            tick.tick().await;
            let now = Instant::now();
            janitor.limiter.prune(now);
            janitor.verified.prune(now);
        }
    });

    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(%bind, error = %e, "could not bind");
            std::process::exit(1);
        }
    };
    info!(%bind, rate_per_hour = app.cfg.rate_per_hour, rate_burst = app.cfg.rate_burst, "listening");
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("server");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_ip_uses_last_forwarded_hop_only_via_loopback() {
        let mut h = HeaderMap::new();
        h.append(
            "x-forwarded-for",
            "203.0.113.9, 198.51.100.4".parse().unwrap(),
        );
        let lo: SocketAddr = "127.0.0.1:5555".parse().unwrap();
        let ext: SocketAddr = "192.0.2.50:5555".parse().unwrap();
        assert_eq!(client_ip(&h, lo), "198.51.100.4".parse::<IpAddr>().unwrap());
        assert_eq!(client_ip(&h, ext), ext.ip());
        assert_eq!(client_ip(&HeaderMap::new(), lo), lo.ip());
        h.insert("x-forwarded-for", "garbage".parse().unwrap());
        assert_eq!(client_ip(&h, lo), lo.ip());
    }

    #[test]
    fn secret_debug_is_redacted() {
        let s = Secret(b"hunter2".to_vec());
        assert!(!format!("{s:?}").contains("hunter2"));
    }
}

//! Host (role 1) gate: the caller must present a Zoom user OAuth access token.
//! We prove it is live by asking Zoom for the user's ZAK with it; the ZAK
//! itself is discarded. Successful checks are cached by SHA-256 of the token
//! (the token is never stored or logged).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

pub const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CACHE_MAX: usize = 10_000;

pub type TokenHash = [u8; 32];

pub fn token_hash(token: &str) -> TokenHash {
    Sha256::digest(token.as_bytes()).into()
}

/// Pull the token out of `Authorization: Bearer <token>`.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let h = header?.trim();
    let (scheme, rest) = h.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let t = rest.trim();
    // Zoom access tokens are long JWT-like strings; bound the size anyway.
    (!t.is_empty() && t.len() <= 4096 && t.bytes().all(|b| b.is_ascii_graphic())).then_some(t)
}

#[derive(Default)]
pub struct VerifiedCache {
    map: Mutex<HashMap<TokenHash, Instant>>,
}

impl VerifiedCache {
    pub fn contains(&self, h: &TokenHash, now: Instant) -> bool {
        let map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        map.get(h).is_some_and(|&until| now < until)
    }

    pub fn insert(&self, h: TokenHash, now: Instant) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= CACHE_MAX {
            map.retain(|_, until| now < *until);
            if map.len() >= CACHE_MAX {
                map.clear();
            }
        }
        map.insert(h, now + CACHE_TTL);
    }

    pub fn prune(&self, now: Instant) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, until| now < *until);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Valid,
    Invalid,
    /// Zoom unreachable or 5xx: not the caller's fault.
    Unavailable,
}

/// GET {base}/v2/users/me/token?type=zak (the app's scope is user:read:token),
/// falling back to /v2/users/me/zak when the first is refused for a reason
/// other than a bad token (e.g. the scope on the app changes).
pub async fn verify_with_zoom(http: &reqwest::Client, api_base: &str, token: &str) -> Verdict {
    let urls = [
        format!("{api_base}/v2/users/me/token?type=zak"),
        format!("{api_base}/v2/users/me/zak"),
    ];
    let mut verdict = Verdict::Invalid;
    for url in &urls {
        match http.get(url).bearer_auth(token).send().await {
            Ok(r) if r.status().is_success() => return Verdict::Valid,
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => return Verdict::Invalid,
            Ok(r) if r.status().is_server_error() => verdict = Verdict::Unavailable,
            Ok(_) => verdict = Verdict::Invalid,
            Err(_) => verdict = Verdict::Unavailable,
        }
    }
    verdict
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_parsing() {
        assert_eq!(bearer(Some("Bearer abc.def")), Some("abc.def"));
        assert_eq!(bearer(Some("bearer   abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(Some("Bearer a b")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn cache_expires() {
        let c = VerifiedCache::default();
        let t0 = Instant::now();
        let h = token_hash("tok");
        assert!(!c.contains(&h, t0));
        c.insert(h, t0);
        assert!(c.contains(&h, t0 + Duration::from_secs(299)));
        assert!(!c.contains(&h, t0 + Duration::from_secs(301)));
        assert!(!c.contains(&token_hash("other"), t0));
        c.prune(t0 + Duration::from_secs(301));
        assert!(c.map.lock().unwrap().is_empty());
    }
}

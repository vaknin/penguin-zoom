//! Zoom event webhook verification, per https://developers.zoom.us/docs/api/webhooks/
//!
//! - every request: `x-zm-signature` == "v0=" + hex(HMAC-SHA256(secret,
//!   "v0:{x-zm-request-timestamp}:{raw body}")); the timestamp is Unix seconds.
//! - `endpoint.url_validation`: reply {plainToken, encryptedToken =
//!   hex(HMAC-SHA256(secret, plainToken))} with 200 within 3 s.

use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

/// Oldest (or furthest in the future) timestamp we accept, in seconds.
pub const MAX_SKEW_SECS: i64 = 5 * 60;

fn hmac_hex(secret: &[u8], msg: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(msg);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    MissingHeaders,
    BadTimestamp,
    Stale,
    BadSignature,
}

/// Check the signature headers against the raw body at time `now` (Unix s).
pub fn verify(
    secret: &[u8],
    signature: Option<&str>,
    timestamp: Option<&str>,
    body: &[u8],
    now: i64,
) -> Result<(), VerifyError> {
    let (Some(sig), Some(ts)) = (signature, timestamp) else {
        return Err(VerifyError::MissingHeaders);
    };
    let ts_num: i64 = ts.trim().parse().map_err(|_| VerifyError::BadTimestamp)?;
    if (now - ts_num).abs() > MAX_SKEW_SECS {
        return Err(VerifyError::Stale);
    }
    let mut msg = Vec::with_capacity(body.len() + 32);
    msg.extend_from_slice(b"v0:");
    msg.extend_from_slice(ts.as_bytes());
    msg.push(b':');
    msg.extend_from_slice(body);
    let expected = format!("v0={}", hmac_hex(secret, &msg));
    if ct_eq(
        expected.as_bytes(),
        sig.trim().to_ascii_lowercase().as_bytes(),
    ) {
        Ok(())
    } else {
        Err(VerifyError::BadSignature)
    }
}

/// The response body for `endpoint.url_validation`, or None if the event
/// carries no usable `payload.plainToken`.
pub fn url_validation_response(secret: &[u8], event: &Value) -> Option<Value> {
    let plain = event.get("payload")?.get("plainToken")?.as_str()?;
    if plain.is_empty() || plain.len() > 256 {
        return None;
    }
    Some(json!({
        "plainToken": plain,
        "encryptedToken": hmac_hex(secret, plain.as_bytes()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"whsec";
    const BODY: &str = r#"{"event":"endpoint.url_validation","payload":{"plainToken":"qgg8vlvZRS6UYooatFL8Aw"},"event_ts":1700000000000}"#;
    // Both computed independently with Python's hmac/hashlib.
    const SIG: &str = "v0=bb55f1b5bebc087d58a52902971aaced1eb0eab91d90ddb8e2e85c109bcb09c6";
    const ENCRYPTED: &str = "578b8d6bb754f5457ba891570620d73f823339ffe3bd2580e8c65be71862b095";

    #[test]
    fn signature_ok() {
        let r = verify(
            SECRET,
            Some(SIG),
            Some("1700000000"),
            BODY.as_bytes(),
            1_700_000_100,
        );
        assert_eq!(r, Ok(()));
    }

    #[test]
    fn signature_rejections() {
        let b = BODY.as_bytes();
        let now = 1_700_000_000;
        assert_eq!(
            verify(SECRET, None, Some("1700000000"), b, now),
            Err(VerifyError::MissingHeaders)
        );
        assert_eq!(
            verify(SECRET, Some(SIG), None, b, now),
            Err(VerifyError::MissingHeaders)
        );
        assert_eq!(
            verify(SECRET, Some(SIG), Some("abc"), b, now),
            Err(VerifyError::BadTimestamp)
        );
        // Older than 5 minutes, or from the future.
        assert_eq!(
            verify(SECRET, Some(SIG), Some("1700000000"), b, now + 301),
            Err(VerifyError::Stale)
        );
        assert_eq!(
            verify(SECRET, Some(SIG), Some("1700000000"), b, now - 301),
            Err(VerifyError::Stale)
        );
        // Wrong secret, tampered body, tampered timestamp, missing prefix.
        assert_eq!(
            verify(b"other", Some(SIG), Some("1700000000"), b, now),
            Err(VerifyError::BadSignature)
        );
        let tampered = BODY.replace("qgg8", "qgg9");
        assert_eq!(
            verify(
                SECRET,
                Some(SIG),
                Some("1700000000"),
                tampered.as_bytes(),
                now
            ),
            Err(VerifyError::BadSignature)
        );
        assert_eq!(
            verify(SECRET, Some(SIG), Some("1700000001"), b, now),
            Err(VerifyError::BadSignature)
        );
        assert_eq!(
            verify(SECRET, Some(&SIG[3..]), Some("1700000000"), b, now),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn url_validation() {
        let ev: Value = serde_json::from_str(BODY).unwrap();
        let r = url_validation_response(SECRET, &ev).unwrap();
        assert_eq!(r["plainToken"], "qgg8vlvZRS6UYooatFL8Aw");
        assert_eq!(r["encryptedToken"], ENCRYPTED);
        assert!(url_validation_response(SECRET, &json!({"payload": {}})).is_none());
    }
}

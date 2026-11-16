//! Meeting SDK signature (JWT, HS256), byte-for-byte the same as the desktop
//! app's former local signer in `src/server.rs` (`signature()` + `sign_jwt()`).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

/// Longest meeting number we accept (Zoom IDs are 9-11 digits today).
pub const MAX_MEETING_DIGITS: usize = 13;

/// Keep only ASCII digits; reject empty or longer than 13 digits.
pub fn normalize_meeting_number(raw: &str) -> Result<String, &'static str> {
    let mn: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if mn.is_empty() {
        return Err("meeting number has no digits");
    }
    if mn.len() > MAX_MEETING_DIGITS {
        return Err("meeting number is too long");
    }
    Ok(mn)
}

/// Payload: {appKey, mn, role, iat=now-30, exp=iat+2h, tokenExp=exp,
/// video_webrtc_mode:0}. WebKitGTK has no RTCPeerConnection, so the client
/// needs WebAssembly video (`video_webrtc_mode: 0`).
pub fn payload(sdk_key: &str, mn: &str, role: u8, now: i64) -> Value {
    let iat = now - 30;
    let exp = iat + 2 * 3600;
    json!({
        "appKey": sdk_key,
        "mn": mn,
        "role": if role == 1 { 1 } else { 0 },
        "iat": iat,
        "exp": exp,
        "tokenExp": exp,
        "video_webrtc_mode": 0,
    })
}

pub fn sign_jwt(payload: &Value, secret: &[u8]) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(payload.to_string());
    let input = format!("{header}.{body}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(input.as_bytes());
    let tag = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{input}.{tag}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_number_validation() {
        assert_eq!(
            normalize_meeting_number("123 4567 8901").unwrap(),
            "12345678901"
        );
        assert_eq!(
            normalize_meeting_number("  85-746-065 ").unwrap(),
            "85746065"
        );
        assert_eq!(normalize_meeting_number("1234567890123").unwrap().len(), 13);
        assert!(normalize_meeting_number("12345678901234").is_err());
        assert!(normalize_meeting_number("").is_err());
        assert!(normalize_meeting_number("abc-def").is_err());
        // Non-ASCII digits are not digits for us.
        assert!(normalize_meeting_number("١٢٣").is_err());
    }

    #[test]
    fn payload_fields() {
        let p = payload("KEY", "123456789", 7, 1_700_000_000);
        assert_eq!(p["appKey"], "KEY");
        assert_eq!(p["mn"], "123456789");
        assert_eq!(p["role"], 0, "anything but 1 is attendee");
        assert_eq!(p["iat"], 1_699_999_970);
        assert_eq!(p["exp"], 1_699_999_970 + 7200);
        assert_eq!(p["tokenExp"], p["exp"]);
        assert_eq!(p["video_webrtc_mode"], 0);
        assert_eq!(payload("K", "1", 1, 0)["role"], 1);
    }

    /// Fixed vector, computed independently with Python:
    ///   hmac.new(b"test-secret", f"{h}.{b}".encode(), sha256), base64url no pad.
    #[test]
    fn jwt_fixed_vector() {
        let p = payload("testkey", "123456789", 0, 1_700_000_030);
        let jwt = sign_jwt(&p, b"test-secret");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
        let body: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(body, p);
        assert!(!jwt.contains('=') && !jwt.contains('+') && !jwt.contains('/'));
        assert_eq!(jwt, EXPECTED_JWT);
    }

    const EXPECTED_JWT: &str = concat!(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
        "eyJhcHBLZXkiOiJ0ZXN0a2V5IiwiZXhwIjoxNzAwMDA3MjAwLCJpYXQiOjE3MDAwMDAwMDAsIm1uIjoiMTIz",
        "NDU2Nzg5Iiwicm9sZSI6MCwidG9rZW5FeHAiOjE3MDAwMDcyMDAsInZpZGVvX3dlYnJ0Y19tb2RlIjowfQ.",
        "cbvRLOcZcMcef2-ZugrPHNdbZ7ksnGTd_WTsPLzwgP8"
    );
}

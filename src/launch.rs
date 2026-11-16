//! Meeting links handed to us on the command line (or by a second launch).
//!
//! Pure parsing only: no I/O, so it is unit-tested below.

use serde::Serialize;

/// What `GET /api/launch` and the SSE "open" event carry.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Launch {
    /// The argument exactly as given.
    pub link: Option<String>,
    /// Meeting number, digits only.
    pub number: Option<String>,
    /// Passcode from the link (`pwd=`), as given (often Zoom's encoded form).
    pub pwd: Option<String>,
}

/// First argument that looks like a Zoom link or meeting number.
pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Option<Launch> {
    args.into_iter().filter(|a| !a.starts_with("--")).find_map(|a| parse(&a))
}

/// Parses one Zoom link or bare meeting number. Accepts:
/// - `zoommtg://zoom.us/join?confno=123&pwd=x` (also `zoomus://`)
/// - `https://*.zoom.us/j/123?pwd=x`, `/s/123`, `/w/123`, `/wc/join/123`,
///   `/wc/123/join` (scheme optional)
/// - a bare number with spaces or dashes, e.g. `123 4567 8901`
pub fn parse(s: &str) -> Option<Launch> {
    let s = s.trim();
    let (number, pwd) = parse_bare(s).map(|n| (n, None)).or_else(|| parse_url(s))?;
    Some(Launch { link: Some(s.to_string()), number: Some(number), pwd })
}

/// Zoom meeting IDs are 9–11 digits (personal IDs 10); allow a little slack.
fn valid_number(n: &str) -> bool {
    (9..=12).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit())
}

fn parse_bare(s: &str) -> Option<String> {
    if !s.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') {
        return None;
    }
    let n: String = s.chars().filter(char::is_ascii_digit).collect();
    valid_number(&n).then_some(n)
}

fn parse_url(s: &str) -> Option<(String, Option<String>)> {
    let with_scheme;
    let s = if s.contains("://") {
        s
    } else {
        with_scheme = format!("https://{s}");
        &with_scheme
    };
    let u = url::Url::parse(s).ok()?;
    let query = |k: &str| {
        u.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty())
    };
    let number = match u.scheme() {
        "zoommtg" | "zoomus" => query("confno"),
        "https" | "http" => {
            let host = u.host_str()?.to_ascii_lowercase();
            let zoom = ["zoom.us", "zoomgov.com", "zoom.com"]
                .iter()
                .any(|d| host == *d || host.ends_with(&format!(".{d}")));
            if !zoom {
                return None;
            }
            let seg: Vec<&str> = u.path_segments()?.filter(|p| !p.is_empty()).collect();
            match seg.as_slice() {
                ["j" | "s" | "w", n, ..] => Some(n.to_string()),
                ["wc", "join", n, ..] => Some(n.to_string()),
                ["wc", n, ..] => Some(n.to_string()),
                _ => None,
            }
        }
        _ => None,
    }?;
    valid_number(&number).then(|| (number, query("pwd")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn np(s: &str) -> Option<(String, Option<String>)> {
        parse(s).map(|l| (l.number.unwrap(), l.pwd))
    }

    #[test]
    fn links() {
        let some = |n: &str, p: Option<&str>| Some((n.to_string(), p.map(str::to_string)));
        assert_eq!(np("zoommtg://zoom.us/join?action=join&confno=123456789&pwd=abc.1"), some("123456789", Some("abc.1")));
        assert_eq!(np("zoomus://zoom.us/join?confno=1234567890"), some("1234567890", None));
        assert_eq!(np("https://us05web.zoom.us/j/76816665924?pwd=XyZ123.1"), some("76816665924", Some("XyZ123.1")));
        assert_eq!(np("https://zoom.us/j/76816665924"), some("76816665924", None));
        assert_eq!(np("us02web.zoom.us/j/76816665924?pwd=q"), some("76816665924", Some("q")));
        assert_eq!(np("https://acme.zoom.us/wc/join/76816665924?pwd=q"), some("76816665924", Some("q")));
        assert_eq!(np("https://zoom.us/wc/76816665924/join"), some("76816665924", None));
        assert_eq!(np("https://zoom.us/s/76816665924"), some("76816665924", None));
        assert_eq!(np("https://zoom.us/j/76816665924?pwd="), some("76816665924", None));
    }

    #[test]
    fn bare_numbers() {
        assert_eq!(np("768 1666 5924"), Some(("76816665924".into(), None)));
        assert_eq!(np("768-1666-5924"), Some(("76816665924".into(), None)));
        assert_eq!(np(" 123456789 "), Some(("123456789".into(), None)));
    }

    #[test]
    fn rejects() {
        for s in [
            "",
            "12345",                               // too short
            "https://evil.example/j/76816665924",  // not Zoom
            "https://notzoom.us/j/76816665924",    // suffix trick
            "https://zoom.us/my/vanity",           // vanity URLs need Zoom's lookup
            "https://zoom.us/j/abc",
            "zoommtg://zoom.us/join?confno=",
            "--server-only",
            "hello world",
        ] {
            assert_eq!(parse(s), None, "{s:?}");
        }
    }

    #[test]
    fn first_matching_arg() {
        let l = from_args(["--server-only".into(), "x".into(), "https://zoom.us/j/123456789?pwd=p".into()]).unwrap();
        assert_eq!(l.link.as_deref(), Some("https://zoom.us/j/123456789?pwd=p"));
        assert_eq!(l.number.as_deref(), Some("123456789"));
        assert_eq!(l.pwd.as_deref(), Some("p"));
    }
}

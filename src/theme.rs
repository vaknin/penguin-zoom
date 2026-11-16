//! Colours from the current Omarchy theme, read-only.
//!
//! Omarchy writes the active theme's palette to `colors.toml` in
//! `~/.local/state/omarchy/current/theme/` (older installs:
//! `~/.config/omarchy/current/theme/`). Some themes rewrite it through the day,
//! so it's read on every request; it's a tiny file.

use std::path::PathBuf;

use serde::Serialize;

use crate::settings::home;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Theme {
    pub bg: String,
    pub fg: String,
    pub accent: String,
}

fn candidates() -> Vec<PathBuf> {
    let env_or = |var: &str, dflt: &str| {
        std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(dflt))
    };
    let rel = "omarchy/current/theme/colors.toml";
    vec![env_or("XDG_STATE_HOME", ".local/state").join(rel), env_or("XDG_CONFIG_HOME", ".config").join(rel)]
}

pub async fn current() -> Option<Theme> {
    for p in candidates() {
        if let Ok(s) = tokio::fs::read_to_string(&p).await {
            return parse_colors_toml(&s);
        }
    }
    None
}

/// Reads `background`, `foreground` and `accent` from top-level
/// `key = "#rrggbb"` lines. Not a TOML parser: that's all this file holds.
pub fn parse_colors_toml(s: &str) -> Option<Theme> {
    let get = |key: &str| {
        s.lines().find_map(|l| {
            let (k, v) = l.split_once('=')?;
            if k.trim() != key {
                return None;
            }
            let v = v.split('#').nth(1).map(|h| format!("#{}", h.chars().take(6).collect::<String>()))?;
            let hex = &v[1..];
            (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && l.contains(&format!("\"{v}")))
                .then(|| v.to_ascii_lowercase())
        })
    };
    Some(Theme { bg: get("background")?, fg: get("foreground")?, accent: get("accent")? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omarchy_colors() {
        let t = parse_colors_toml(
            "# comment\nmode = \"dark\"\naccent = \"#C0BFBC\"\ndark_background = \"#111111\"\n\
             background = \"#000000\"\nforeground = \"#dfdedb\"\nbright_foreground = \"#f0eeeb\"\n",
        )
        .unwrap();
        assert_eq!(t, Theme { bg: "#000000".into(), fg: "#dfdedb".into(), accent: "#c0bfbc".into() });
    }

    #[test]
    fn incomplete_or_bad() {
        assert_eq!(parse_colors_toml("background = \"#000000\"\nforeground = \"#ffffff\"\n"), None);
        assert_eq!(parse_colors_toml("background = \"#00\"\nforeground = \"#fff\"\naccent = \"#123456\""), None);
        assert_eq!(parse_colors_toml("background = \"rgba(1c1c1baa)\"\nforeground = \"#ffffff\"\naccent = \"#123456\""), None);
    }
}

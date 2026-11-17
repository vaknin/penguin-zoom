//! User settings: `$XDG_CONFIG_HOME/penguin-zoom/settings.json`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    #[default]
    Standard,
    Keyboard,
}

/// Missing fields take their default (`#[serde(default)]`); unknown fields
/// are ignored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub style: Style,
    pub join_muted: bool,
    pub join_camera_off: bool,
    pub hide_idle: bool,
    /// Hide Zoom's Active Apps Notifier (owner's choice; Zoom requires it shown).
    pub hide_apps_notice: bool,
    pub name: String,
    /// PulseAudio sink name to route our playback to; None = system default.
    pub speaker_id: Option<String>,
    /// Chosen camera and microphone, by label; None = whatever the system
    /// gives by default.
    pub camera: Option<String>,
    pub mic: Option<String>,
    /// The same choice by WebKit device id. Ids stay the same between launches
    /// (checked 2026-11-17) and work before the first permission grant, when
    /// labels are still hidden; they also tell apart two devices with one label.
    pub camera_id: Option<String>,
    pub mic_id: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            style: Style::Standard,
            join_muted: true,
            join_camera_off: false,
            hide_idle: true,
            hide_apps_notice: false,
            name: String::new(),
            speaker_id: None,
            camera: None,
            mic: None,
            camera_id: None,
            mic_id: None,
        }
    }
}

pub fn path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"));
    base.join("penguin-zoom/settings.json")
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/".into())
}

/// Loads settings; a missing or broken file gives defaults (with a note).
pub fn load() -> Settings {
    let p = path();
    match std::fs::read_to_string(&p) {
        Ok(s) => from_json_lenient(&s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            eprintln!("[settings] {}: {e}; using defaults", p.display());
            Settings::default()
        }
    }
}

/// Like serde with `default`, but a field with a bad value (e.g. an unknown
/// `style`) falls back to its default instead of discarding the whole file.
fn from_json_lenient(s: &str) -> Settings {
    let Ok(Value::Object(file)) = serde_json::from_str::<Value>(s) else {
        eprintln!("[settings] settings.json is not a JSON object; using defaults");
        return Settings::default();
    };
    let Value::Object(mut merged) = serde_json::to_value(Settings::default()).unwrap() else {
        unreachable!()
    };
    for (k, v) in file {
        let mut trial = merged.clone();
        trial.insert(k.clone(), v);
        if serde_json::from_value::<Settings>(Value::Object(trial.clone())).is_ok() {
            merged = trial;
        } else {
            eprintln!("[settings] ignoring bad value for {k:?}");
        }
    }
    serde_json::from_value(Value::Object(merged)).unwrap_or_default()
}

/// Writes atomically: a temp file in the same directory, then rename.
pub async fn save(s: &Settings) -> std::io::Result<()> {
    let p = path();
    let dir = p.parent().expect("settings path has a parent");
    tokio::fs::create_dir_all(dir).await?;
    let tmp = dir.join(".settings.json.tmp");
    let body = serde_json::to_vec_pretty(s).expect("settings serialize");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, &p).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_camel_case() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"style":"standard","joinMuted":true,"joinCameraOff":false,
                "hideIdle":true,"hideAppsNotice":false,"name":"","speakerId":null,
                "camera":null,"mic":null,"cameraId":null,"micId":null})
        );
    }

    #[test]
    fn partial_unknown_and_bad_fields() {
        let s = from_json_lenient(r#"{"style":"keyboard","name":"Kivan","extra":1,"joinMuted":"yes"}"#);
        assert_eq!(s.style, Style::Keyboard);
        assert_eq!(s.name, "Kivan");
        assert!(s.join_muted, "bad value falls back to default");
        let s = from_json_lenient(r#"{"style":"fancy","speakerId":"sink.a"}"#);
        assert_eq!(s.style, Style::Standard);
        assert_eq!(s.speaker_id.as_deref(), Some("sink.a"));
        assert_eq!(from_json_lenient("[]"), Settings::default());
        assert_eq!(from_json_lenient("not json"), Settings::default());
    }
}

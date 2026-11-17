//! Speaker (output device) selection.
//!
//! WebKitGTK has no `HTMLMediaElement.setSinkId`, so the page can't pick an
//! output. Instead we move our own playback streams (PulseAudio sink-inputs,
//! via pipewire-pulse) to the chosen sink with `pactl`, and keep moving new
//! ones: the SDK opens its playback streams late, and again on rejoin.
//!
//! `ZOOM_SPEAKERS_DRY_RUN=1` logs the moves instead of doing them (for testing
//! next to a real call).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::settings::Settings;

/// The `application.name` on WebKit's streams: libpulse takes it from the
/// program name, which main.rs sets (WirePlumber keys its saved volumes on
/// it).
pub const APP_NAME: &str = "penguin-zoom";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Speaker {
    pub id: String,
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sink {
    pub index: u64,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SinkInput {
    pub index: u64,
    pub sink: u64,
    pub app_name: Option<String>,
    pub pid: Option<u32>,
}

// ---------- parsing (pure) ----------

pub fn parse_sinks(json: &str) -> Result<Vec<Sink>, String> {
    let v: Vec<Value> = serde_json::from_str(json).map_err(|e| format!("sinks JSON: {e}"))?;
    Ok(v.iter()
        .filter_map(|s| {
            let name = s["name"].as_str()?.to_string();
            Some(Sink {
                index: s["index"].as_u64()?,
                description: s["description"].as_str().unwrap_or(&name).to_string(),
                name,
            })
        })
        .collect())
}

pub fn parse_sink_inputs(json: &str) -> Result<Vec<SinkInput>, String> {
    let v: Vec<Value> = serde_json::from_str(json).map_err(|e| format!("sink-inputs JSON: {e}"))?;
    Ok(v.iter()
        .filter_map(|s| {
            let p = &s["properties"];
            Some(SinkInput {
                index: s["index"].as_u64()?,
                sink: s["sink"].as_u64()?,
                app_name: p["application.name"].as_str().map(str::to_string),
                // pactl prints every property as a string.
                pid: p["application.process.id"].as_str().and_then(|x| x.parse().ok()),
            })
        })
        .collect())
}

/// Ours: named after us, or played by our process or one of its children
/// (the WebKit web process).
pub fn is_ours(si: &SinkInput, pids: &HashSet<u32>) -> bool {
    si.app_name.as_deref() == Some(APP_NAME) || si.pid.is_some_and(|p| pids.contains(&p))
}

/// The speaker list, marking the sink we route to: the chosen one if it still
/// exists, else the system default.
pub fn speakers(sinks: &[Sink], chosen: Option<&str>, default: &str) -> Vec<Speaker> {
    let target = chosen.filter(|c| sinks.iter().any(|s| s.name == *c)).unwrap_or(default);
    sinks
        .iter()
        .map(|s| Speaker { id: s.name.clone(), name: s.description.clone(), current: s.name == target })
        .collect()
}

/// Sink-input indexes that need moving to `target` (a sink name).
pub fn to_move(sinks: &[Sink], inputs: &[SinkInput], target: &str, pids: &HashSet<u32>) -> Vec<u64> {
    let Some(t) = sinks.iter().find(|s| s.name == target) else { return vec![] };
    inputs.iter().filter(|i| is_ours(i, pids) && i.sink != t.index).map(|i| i.index).collect()
}

/// `pactl subscribe` line for a new playback stream, e.g.
/// `Event 'new' on sink-input #123`.
pub fn is_new_sink_input(line: &str) -> bool {
    line.starts_with("Event 'new' on sink-input ")
}

// ---------- pactl ----------

async fn pactl(args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new("pactl")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("could not run pactl: {e}"))?;
    if !out.status.success() {
        return Err(format!("pactl {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn sinks() -> Result<Vec<Sink>, String> {
    parse_sinks(&pactl(&["-f", "json", "list", "sinks"]).await?)
}

pub async fn list(chosen: Option<&str>) -> Result<Vec<Speaker>, String> {
    let sinks = sinks().await?;
    let default = pactl(&["get-default-sink"]).await.unwrap_or_default();
    Ok(speakers(&sinks, chosen, default.trim()))
}

/// The system's default sink name (what "no choice" means).
pub async fn default_sink() -> Result<String, String> {
    Ok(pactl(&["get-default-sink"]).await?.trim().to_string())
}

/// Our pid plus every descendant's, from /proc.
fn our_pids() -> HashSet<u32> {
    let me = std::process::id();
    let mut parent_of = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/proc") {
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may contain spaces.
            let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
            let ppid = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)?.parse().ok());
            if let Some(ppid) = ppid {
                parent_of.push((pid, ppid));
            }
        }
    }
    let mut set = HashSet::from([me]);
    loop {
        let before = set.len();
        for &(pid, ppid) in &parent_of {
            if set.contains(&ppid) {
                set.insert(pid);
            }
        }
        if set.len() == before {
            return set;
        }
    }
}

/// Moves all our streams to `target`. Returns how many were moved.
pub async fn route(target: &str) -> Result<usize, String> {
    let sinks = sinks().await?;
    if !sinks.iter().any(|s| s.name == target) {
        return Err(format!("no such sink: {target}"));
    }
    let inputs = parse_sink_inputs(&pactl(&["-f", "json", "list", "sink-inputs"]).await?)?;
    let ids = to_move(&sinks, &inputs, target, &our_pids());
    let dry = std::env::var_os("ZOOM_SPEAKERS_DRY_RUN").is_some();
    for id in &ids {
        if dry {
            eprintln!("[speakers] dry run: would move sink-input {id} to {target}");
        } else if let Err(e) = pactl(&["move-sink-input", &id.to_string(), target]).await {
            eprintln!("[speakers] {e}");
        }
    }
    if !ids.is_empty() && !dry {
        eprintln!("[speakers] moved {} stream(s) to {target}", ids.len());
    }
    Ok(ids.len())
}

/// Background task: follows `pactl subscribe` and routes each new playback
/// stream to the chosen speaker. Does nothing while no speaker is chosen.
/// Restarts pactl if it exits (e.g. PipeWire restarted).
pub async fn watch(settings: Arc<Mutex<Settings>>) {
    let chosen = || async { settings.lock().await.speaker_id.clone() };
    loop {
        if let Some(t) = chosen().await {
            let _ = route(&t).await;
        }
        let child = tokio::process::Command::new("pactl")
            .arg("subscribe")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn();
        match child {
            Ok(mut child) => {
                let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !is_new_sink_input(&line) {
                        continue;
                    }
                    if let Some(t) = chosen().await {
                        // Let the stream finish connecting before listing it.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if let Err(e) = route(&t).await {
                            eprintln!("[speakers] {e}");
                        }
                    }
                }
                let _ = child.kill().await;
                eprintln!("[speakers] pactl subscribe ended; restarting in 5 s");
            }
            Err(e) => eprintln!("[speakers] could not run pactl subscribe: {e}; retrying in 5 s"),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SINKS: &str = r#"[
      {"index":832,"state":"RUNNING","name":"alsa_output.pci-0000_04_00.6.HiFi__Speaker__sink",
       "description":"Ryzen HD Audio Controller Speaker","properties":{}},
      {"index":900,"state":"SUSPENDED","name":"bluez_output.AA_BB.1",
       "description":"WH-1000XM4","properties":{}}
    ]"#;

    const INPUTS: &str = r#"[
      {"index":11965,"driver":"PipeWire","client":"11964","sink":832,
       "properties":{"application.name":"Brave","application.process.id":"4793",
                     "application.process.binary":"brave","media.name":"Playback"}},
      {"index":12001,"sink":832,
       "properties":{"application.name":"penguin-zoom","application.process.id":"7001",
                     "application.process.binary":"WebKitWebProcess","media.name":"Playback Stream"}},
      {"index":12002,"sink":900,
       "properties":{"application.name":"penguin-zoom","media.name":"Playback Stream"}},
      {"index":12003,"sink":832,
       "properties":{"application.name":"WebKit","application.process.id":"7002"}},
      {"index":12004,"sink":832,"properties":{}}
    ]"#;

    #[test]
    fn parses() {
        let s = parse_sinks(SINKS).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[1], Sink { index: 900, name: "bluez_output.AA_BB.1".into(), description: "WH-1000XM4".into() });
        let i = parse_sink_inputs(INPUTS).unwrap();
        assert_eq!(i.len(), 5);
        assert_eq!(i[1].pid, Some(7001));
        assert_eq!(i[4], SinkInput { index: 12004, sink: 832, app_name: None, pid: None });
        assert!(parse_sinks("nope").is_err());
        assert_eq!(parse_sinks("[]").unwrap(), vec![]);
    }

    #[test]
    fn current_speaker() {
        let s = parse_sinks(SINKS).unwrap();
        let dflt = "alsa_output.pci-0000_04_00.6.HiFi__Speaker__sink";
        let cur = |c: Option<&str>| speakers(&s, c, dflt).into_iter().find(|x| x.current).unwrap().id;
        assert_eq!(cur(None), dflt);
        assert_eq!(cur(Some("bluez_output.AA_BB.1")), "bluez_output.AA_BB.1");
        assert_eq!(cur(Some("gone")), dflt, "a vanished choice falls back to default");
        assert_eq!(
            serde_json::to_value(&speakers(&s, None, dflt)[1]).unwrap(),
            serde_json::json!({"id":"bluez_output.AA_BB.1","name":"WH-1000XM4","current":false})
        );
    }

    #[test]
    fn matching_and_moves() {
        let s = parse_sinks(SINKS).unwrap();
        let i = parse_sink_inputs(INPUTS).unwrap();
        let pids = HashSet::from([7002]);
        // Brave never; ours by name or by pid; already-on-target skipped.
        assert_eq!(to_move(&s, &i, "bluez_output.AA_BB.1", &pids), vec![12001, 12003]);
        assert_eq!(to_move(&s, &i, "alsa_output.pci-0000_04_00.6.HiFi__Speaker__sink", &pids), vec![12002]);
        assert_eq!(to_move(&s, &i, "missing", &pids), Vec::<u64>::new());
        assert_eq!(to_move(&s, &i, "bluez_output.AA_BB.1", &HashSet::new()), vec![12001]);
    }

    #[test]
    fn subscribe_lines() {
        assert!(is_new_sink_input("Event 'new' on sink-input #12005"));
        assert!(!is_new_sink_input("Event 'change' on sink-input #12005"));
        assert!(!is_new_sink_input("Event 'new' on source-output #3"));
        assert!(!is_new_sink_input("Event 'new' on sink #3"));
    }

    #[test]
    fn our_pids_has_self() {
        assert!(our_pids().contains(&std::process::id()));
    }
}

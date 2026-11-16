#!/usr/bin/env bash
# Two-way audio check for a spike that is already in a meeting, without the
# real speakers or microphone:
#   - the app's playback is moved to a null sink "spike_spk" and recorded;
#   - the app's capture is moved to "spike_mic.monitor", fed with speech.
# Usage: scripts/audio-test.sh <outdir> <phase-seconds> [phone-play-cmd]
#   phase A: speech -> app mic (laptop -> phone), watch SDK active-speaker events
#   phase B: record app playback while [phone-play-cmd] makes the phone talk
set -euo pipefail
OUT="$1"; SECS="${2:-15}"; PHONE_PLAY="${3:-}"
mkdir -p "$OUT"
SPEECH="$OUT/speech.wav"
[ -f "$SPEECH" ] || ffmpeg -loglevel error -y -stream_loop 9 -i /usr/share/sounds/alsa/Front_Center.wav -ar 48000 -ac 1 "$SPEECH"

mods=()
retargeted=()
cleanup() {
  mods_kill 2>/dev/null || true
  for i in "${retargeted[@]}"; do pw-metadata -d "$i" target.object >/dev/null 2>&1 || true; done
  for m in "${mods[@]}"; do pactl unload-module "$m" 2>/dev/null || true; done
}
trap cleanup EXIT
mods+=("$(pactl load-module module-null-sink sink_name=spike_spk sink_properties=device.description=spike_spk)")
# A virtual *source*: pw-play writes into it, the app captures from it.
mods+=("$(pactl load-module module-null-sink sink_name=spike_mic media.class=Audio/Source/Virtual sink_properties=device.description=spike_mic)")

# WebKit's streams (the web process plays and captures for the page).
ids() { pactl -f json list "$1" | python3 -c '
import json,sys
for s in json.load(sys.stdin):
    p=s.get("properties",{})
    blob=" ".join(str(p.get(k,"")) for k in ("application.process.binary","application.name","media.name"))
    # pactl indexes are object.serial; pw-metadata needs the PipeWire object.id.
    key = sys.argv[1] if len(sys.argv) > 1 else "index"
    if "WebKit" in blob or "penguin-zoom" in blob: print(s["index"] if key == "index" else p.get("object.id"))' "${2:-index}"; }
# Zoom may open playback streams later, so keep moving any new WebKit stream.
( while true; do for i in $(ids sink-inputs); do pactl move-sink-input "$i" spike_spk 2>/dev/null; done; sleep 0.5; done ) &
MOVER=$!
mods_kill() { kill "$MOVER" 2>/dev/null || true; }
sleep 1; echo "playback streams on spike_spk: $(ids sink-inputs | tr '\n' ' ')"
# WebKit's capture stream is a native PipeWire stream with node.dont-reconnect,
# which pactl refuses to move; retarget it through the default metadata instead.
for i in $(ids source-outputs object.id); do pw-metadata "$i" target.object spike_mic >/dev/null && retargeted+=("$i") && echo "retargeted capture $i -> spike_mic"; done
sleep 1
pw-link -l | grep -A2 -i "spike_mic" | head -8 || true

level() { python3 -I - "$1" <<'PY'
import sys, wave, numpy as np
w = wave.open(sys.argv[1]); sr = w.getframerate(); ch = w.getnchannels()
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
a = a.reshape(-1, ch).mean(axis=1) / 32768
secs = [a[i:i+sr] for i in range(0, len(a) - sr + 1, sr)]
db = [20*np.log10(max(np.sqrt(np.mean(s*s)), 1e-6)) for s in secs]
print("per-second dBFS:", " ".join(f"{d:.0f}" for d in db))
print(f"max {max(db):.1f} dBFS, median {np.median(db):.1f} dBFS")
PY
}

echo "== baseline: app playback, phone mic hears the room ($((SECS*3))s) from $(date +%s)"
date +%s > "$OUT/baseline.start"
timeout "$((SECS*3))" pw-record -P "{ stream.capture.sink = true }" --target spike_spk --rate 48000 --channels 1 "$OUT/baseline.wav" 2>/dev/null || true
level "$OUT/baseline.wav"

echo "== phase A: speech into the app's mic (${SECS}s) at $(date +%T)"
date +%s > "$OUT/phaseA.start"
timeout "$SECS" pw-play --target spike_mic "$SPEECH" || true
date +%s > "$OUT/phaseA.end"

if [ -n "$PHONE_PLAY" ]; then
  echo "== phase B: phone talks, recording the app's playback (${SECS}s)"
  timeout "$SECS" pw-record -P "{ stream.capture.sink = true }" --target spike_spk --rate 48000 --channels 1 "$OUT/phoneB.wav" 2>/dev/null &
  REC=$!
  sleep 1; bash -c "$PHONE_PLAY" || true
  wait "$REC" || true
  level "$OUT/phoneB.wav"
fi

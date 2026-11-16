#!/usr/bin/env bash
# Records what the spike plays, without the real speakers: every WebKit playback
# stream is moved to a null sink "spike_spk" (the mover starts before the app,
# so nothing reaches the speakers), and the sink's monitor is recorded.
# Usage: scripts/playback-check.sh <outdir> <record-seconds> <headless-run seconds> <url>
#   e.g. scripts/playback-check.sh /tmp/o 20 40 "http://127.0.0.1:53682/?beep=30"
set -euo pipefail
OUT="$1"; REC="$2"; RUN="$3"; URL="$4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
MOD="$(pactl load-module module-null-sink sink_name=spike_spk sink_properties=device.description=spike_spk)"
ids() { pactl -f json list sink-inputs | python3 -c '
import json,sys
for s in json.load(sys.stdin):
    p=s.get("properties",{})
    blob=" ".join(str(p.get(k,"")) for k in ("application.process.binary","application.name","media.name"))
    v=s.get("volume",{}).get("front-left",{}).get("value_percent","?")
    if "WebKit" in blob or "penguin-zoom" in blob: print(s["index"], s.get("sink"), p.get("media.name","").replace(" ","_"), v)'; }
# WirePlumber restores a saved per-app volume (keyed by application.name); a
# stream that once ran at 0 is restored at 0. FORCE_VOLUME=1 sets 100% on each.
( while true; do ids | while read -r i _; do
    pactl move-sink-input "$i" spike_spk 2>/dev/null || true
    [ "${FORCE_VOLUME:-0}" = 1 ] && pactl set-sink-input-volume "$i" 100% 2>/dev/null || true
  done; sleep 0.2; done ) &
MOVER=$!
cleanup() { kill "$MOVER" 2>/dev/null || true; pactl unload-module "$MOD" 2>/dev/null || true; }
trap cleanup EXIT

"$ROOT/scripts/headless-run.sh" "$RUN" "$OUT" "$URL" >/dev/null 2>&1 &
HR=$!
# Wait until the app plays something (or 60 s), then record.
for _ in $(seq 120); do [ -n "$(ids)" ] && break; sleep 0.5; done
echo "streams: $(ids | tr '\n' ' ')"
date +%s > "$OUT/rec.start"
timeout "$REC" pw-record -P '{ stream.capture.sink = true }' --target spike_spk --rate 48000 --channels 1 "$OUT/play.wav" 2>/dev/null || true
echo "streams at end: $(ids | tr '\n' ' ')"
python3 -I - "$OUT/play.wav" <<'PY'
import sys, wave, numpy as np
w = wave.open(sys.argv[1]); sr = w.getframerate()
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
secs = [a[i:i+sr] for i in range(0, len(a) - sr + 1, sr)]
db = [20*np.log10(max(np.sqrt(np.mean(s*s)), 1e-6)) for s in secs]
print("per-second dBFS:", " ".join(f"{d:.0f}" for d in db))
if len(a) >= sr:
    f = np.abs(np.fft.rfft(a[:sr])); print("peak freq (first s):", int(np.argmax(f[20:]) + 20), "Hz")
PY
wait "$HR" || true

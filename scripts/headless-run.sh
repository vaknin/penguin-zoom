#!/usr/bin/env bash
# Runs the spike on a virtual Hyprland monitor far off-screen, so nothing appears
# on the real display. Screenshots come from `grim -o SPIKE`.
#
# Usage: scripts/headless-run.sh <seconds> <outdir> [url] [shot-at-seconds...]
#   e.g. scripts/headless-run.sh 25 /tmp/out "http://127.0.0.1:53682/?autotest=1" 10 20
# Extra env (ZOOM_SPIKE_*, ZOOM_PUBLIC_CLIENT_ID) is passed through to the app.
set -euo pipefail
SECS="$1"; OUT="$2"; URL="${3:-http://127.0.0.1:53682/}"; shift 3 || shift $#
SHOTS=("$@")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"

focused="$(hyprctl monitors -j | python3 -c 'import json,sys;print([m["name"] for m in json.load(sys.stdin) if m["focused"]][0])')"
created=0
if ! hyprctl monitors -j | grep -q '"name": "SPIKE"'; then
  hyprctl output create headless SPIKE >/dev/null
  created=1
fi
# Diagonally below-right of the focused monitor with a 40 px gap: the cursor
# can't reach it, and the share picker (which draws outputs to scale) still
# shows real previews. Far away (-20000x0) it shrank every output to a speck.
pos="$(hyprctl monitors -j | python3 -c '
import json,sys
m=[m for m in json.load(sys.stdin) if m["focused"]][0]
print("%dx%d" % (m["x"] + round(m["width"] / m["scale"]) + 40, m["y"] + round(m["height"] / m["scale"]) + 40))')"
hyprctl eval "hl.monitor({ output = \"SPIKE\", mode = \"1600x1000@30\", position = \"$pos\", scale = 1 })" >/dev/null
refocus() { hyprctl dispatch "hl.dsp.focus({ monitor = \"$focused\" })" >/dev/null 2>&1 || true; }
refocus
ws="$(hyprctl monitors -j | python3 -c 'import json,sys;print([m["activeWorkspace"]["id"] for m in json.load(sys.stdin) if m["name"]=="SPIKE"][0])')"
hyprctl eval "hl.window_rule({ name = \"zoom-spike-headless\", match = { class = \"penguin-zoom\" }, workspace = \"$ws silent\" })" >/dev/null

cleanup() {
  hyprctl eval 'hl.window_rule({ name = "zoom-spike-headless", enabled = false })' >/dev/null 2>&1 || true
  if [ "$created" = 1 ]; then hyprctl output remove SPIKE >/dev/null 2>&1 || true; fi
  refocus
}
trap cleanup EXIT

ZOOM_SPIKE_URL="$URL" timeout "$SECS" "$ROOT/target/debug/penguin-zoom" >"$OUT/app.log" 2>&1 &
APP=$!
start=$(date +%s)
for t in "${SHOTS[@]}"; do
  while [ $(( $(date +%s) - start )) -lt "$t" ]; do sleep 0.5; done
  grim -o SPIKE "$OUT/shot-${t}s.png" || true
done
wait "$APP" || true
hyprctl clients -j | python3 -c 'import json,sys;[print("client:",c["class"],c["workspace"]["name"]) for c in json.load(sys.stdin) if "zoom" in c["class"]]' || true
echo "log: $OUT/app.log"

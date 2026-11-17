#!/usr/bin/env bash
# Sends a real keypress to the off-screen spike window (a trusted user gesture,
# which getDisplayMedia requires), then gives focus back to the window that had it.
# Usage: scripts/spike-key.sh <wtype key name, e.g. F9>
set -euo pipefail
# DISABLED 2026-11-17: focuses windows and types into the owner's Hyprland
# session. Tests run in cage now (scripts/headless-run.sh); never use this.
echo "spike-key.sh: disabled, it takes the owner's focus and keyboard" >&2; exit 1
KEY="${1:-F9}"
prev="$(hyprctl activewindow -j | python3 -c 'import json,sys;print(json.load(sys.stdin).get("address",""))')"
# Only the test window on the off-screen SPIKE output, never the owner's own Penguin.
target="$(python3 - <<'PY'
import json,subprocess
mons={m["id"]:m["name"] for m in json.loads(subprocess.run(["hyprctl","monitors","-j"],capture_output=True,text=True).stdout)}
for c in json.loads(subprocess.run(["hyprctl","clients","-j"],capture_output=True,text=True).stdout):
    if c["class"]=="penguin-zoom" and mons.get(c["monitor"])=="SPIKE": print(c["address"]); break
PY
)"
[ -n "$target" ] || { echo "no test window on the SPIKE output"; exit 1; }
hyprctl dispatch "hl.dsp.focus({ window = \"address:$target\" })" >/dev/null
sleep 0.3
active="$(hyprctl activewindow -j | python3 -c 'import json,sys;print(json.load(sys.stdin).get("address",""))')"
[ "$active" = "$target" ] || { echo "could not focus the test window"; exit 1; }
wtype -k "$KEY"
echo "sent $KEY to the spike"
# The share picker (if any) opens now; callers give focus back after picking.
[ "${KEEP_FOCUS:-0}" = 1 ] || { sleep 0.2; [ -n "$prev" ] && hyprctl dispatch "hl.dsp.focus({ window = \"address:$prev\" })" >/dev/null || true; }

#!/bin/bash
# Live run of the real UI (ui/) against the phone's meeting ($S/meeting.txt),
# off-screen. Usage: live-test.sh <name> <secs> "<script steps>" [end: leave|close|none]
#   steps: comma-separated UI actions (data-action names) run every 6 s after
#   join; "say:<text>" sends a chat message. See ui/app.js (?autojoin).
# Screenshots: spike every 10 s ($S/<name>/shot-*.png), phone at 30/60/90 s.
S="${S:?set S to a work directory}"; D="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$D/../.." && pwd)"; NAME="$1"; SECS="$2"; STEPS="$3"; END="${4:-leave}"
OUT="$S/$NAME"; mkdir -p "$OUT"
read MID MPW < "$S/meeting.txt"
# Never touch the owner's own Penguin: if it is running, the test window would
# hand our link to it (single instance) and our keypresses could land in it.
if ss -ltn | grep -q '127.0.0.1:53682 '; then echo "Penguin is already running (the owner's?): not testing" >&2; exit 1; fi
# Test settings live in the work dir, never in ~/.config/penguin-zoom.
export XDG_CONFIG_HOME="$S/config"; mkdir -p "$XDG_CONFIG_HOME"
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=","))' "$1"; }
URL="http://127.0.0.1:53682/?m=$(enc "https://zoom.us/j/$MID?pwd=$MPW")&autojoin&name=$(enc "${TNAME:-Penguin test}")&script=$(enc "$STEPS")"
"$D/admit.sh" 60 > "$OUT/admit.log" 2>&1 &
shots=(); for t in $(seq 10 10 $((SECS-5))); do shots+=("$t"); done
"$ROOT/scripts/headless-run.sh" "$SECS" "$OUT" "$URL" "${shots[@]}" >/dev/null 2>&1 &
HR=$!
for t in 30 60 90; do
  [ "$t" -lt "$SECS" ] || break
  sleep $((t - ${prev:-0})); prev=$t
  "$D/ph.sh" shot "$NAME-phone-$t" >/dev/null
done
case "$END" in
  leave) sleep $((SECS - ${prev:-0} - 12)); "$ROOT/target/debug/penguin-zoom" --cmd leave; echo "sent leave" ;;
  close) sleep $((SECS - ${prev:-0} - 12)); hyprctl dispatch 'hl.dsp.window.close({ window = "class:penguin-zoom" })' >/dev/null 2>&1 \
           || hyprctl dispatch closewindow class:penguin-zoom; echo "sent close" ;;
esac
sleep 8; "$D/ph.sh" shot "$NAME-phone-end" >/dev/null
wait "$HR"
grep -E '^\[page:(test|error|warn)\]|\[sig\]|\[http\]|panicked' "$OUT/app.log" | cut -c1-300

#!/bin/bash
# Two-way screen-share test against the phone's meeting ($S/meeting.txt):
#   R: the phone shares its screen; spike screenshots show whether it renders.
#   S: the phone stops; the spike shares (real F9 keypress -> SDK "Share Screen"
#      -> portal picker on the headless output -> Tab (eDP-1 card) + Return);
#      phone screenshots show whether it arrives.
# DISABLED 2026-11-17: opens a picker and types into the owner's Hyprland
# session. two-way-test.sh covers sharing with ZOOM_SHARE_SOURCE=test in cage.
echo "share-test.sh: disabled, it takes the owner's focus and keyboard" >&2; exit 1
S="${S:?set S to a work directory}"; D="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$S/phone"
ROOT="$(cd "$D/../.." && pwd)"; P="$D/ph.sh"; OUT="$S/${1:-share}"
read MID MPW < "$S/meeting.txt"
log() { echo "$(date +%T) $*"; }
"$D/admit.sh" 50 > "$S/admit.log" 2>&1 &
"$ROOT/scripts/headless-run.sh" "${RUNSECS:-200}" "$OUT" "http://127.0.0.1:53682/?m=$MID&pwd=$MPW&autojoin=1&autoav=${AUTOAV:-both}&leaveafter=$(( ${RUNSECS:-200} - 6 ))&keyshare&workerlog&name=${NAME:-Linux%20spike}" >/dev/null 2>&1 &
HR=$!
t0=$SECONDS
until grep -q '"name":"Aviv"' "$OUT/app.log" 2>/dev/null; do sleep 2; [ $((SECONDS-t0)) -gt 90 ] && { log "spike not admitted"; break; }; done
log "spike in meeting"; sleep 8

if [ "${SKIP_R:-0}" != 1 ]; then
log "R: phone starts sharing"
"$P" shell "input tap 540 1200; sleep 1.0; input tap 724 2253"; sleep 2
"$P" tap 'Start share' >/dev/null; sleep 2
"$P" tap '^Screen$' >/dev/null; sleep 2
"$P" tap '^Share entire screen$' >/dev/null; sleep 2
"$P" tap '^Share screen$' >/dev/null; sleep 4
"$P" shell input keyevent KEYCODE_HOME; sleep 15
grim -o SPIKE "$OUT/R-spike.png"; log "R: spike screenshot $OUT/R-spike.png"
sleep 5
"$P" shell monkey -p us.zoom.videomeetings -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 3
"$P" tap '^Stop share' >/dev/null || "$P" tap 'Stop sharing' >/dev/null; sleep 4
log "R: phone stopped sharing"

fi
log "S: spike shares"
KEEP_FOCUS=1 "$ROOT/scripts/spike-key.sh" F9
# Hold focus as briefly as possible: the owner may be typing. No picker within
# 3 s (e.g. Zoom refused the share) -> give focus back at once.
picker=0
for _ in $(seq 12); do hyprctl layers -j | grep -q preview-share-picker && { picker=1; break; }; sleep 0.25; done
if [ "$picker" = 1 ]; then
  sleep 0.5; wtype -k Tab; sleep 0.3; wtype -k Return
else log "S: no picker appeared"; fi
hyprctl dispatch 'hl.dsp.focus({ monitor = "eDP-1" })' >/dev/null
grim -o SPIKE "$OUT/S-picker.png"
sleep 12
"$P" shot S-phone >/dev/null; log "S: phone screenshot $S/phone/S-phone.png"
grim -o SPIKE "$OUT/S-spike.png"
sleep 10
"$P" shot S-phone2 >/dev/null
wait "$HR"
log "done"
grep -E '^\[page:(worker|error|auto)\]|getDisplayMedia|share' "$OUT/app.log" | grep -v 5004 | cut -c1-260 | head -40

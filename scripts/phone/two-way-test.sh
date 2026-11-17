#!/bin/bash
# Two-way core test of the real UI against the phone's meeting ($S/meeting.txt).
# Penguin (P) runs in its own headless compositor (cage, scripts/headless-run.sh) and
# shares a test pattern (ZOOM_SHARE_SOURCE=test: no portal picker). The phone
# (Z) is driven over adb. This script never changes desktop focus or types.
#
#   P: unmute, mute, camera on (USB webcam), camera off, share, change, stop, chat
#   Z: mute, unmute, video off, video on, share, stop
# Evidence: $S/<name>/app.log ("users=" in the state lines is P's view of
# everyone: H host, C co-host, W waiting, M/m unmuted/muted, - no audio,
# V/v video on/off, S sharing), P screenshots $S/<name>/shot-*.png and phone
# screenshots $S/phone/<name>-*.png.
#
# Usage: S=<dir> two-way-test.sh [name]
S="${S:?set S to a work directory}"; export S ZOOM_SHARE_SOURCE=test
D="$(cd "$(dirname "$0")" && pwd)"; P="$D/ph.sh"; ZP="$D/zp"
NAME="${1:-twoway}"; OUT="$S/$NAME"
CAM="${CAM:-USB2.0 HD UVC WebCam}"
STEPS="wait,wait,wait,wait,mute,wait,mute,cam:$CAM,video,wait,video,share,wait,share-change,wait,share"
STEPS="$STEPS,wait,wait,wait,wait,wait,wait,wait,wait,wait,say:hello from penguin,wait,wait"
# Host: Z makes P host during steps 27-30, P hands it back at step 31.
STEPS="$STEPS,wait,wait,wait,wait,make-host:${ZNAME:-Aviv},wait,wait"
# NOSHARE=1: our share steps become waits (same timing). 2026-11-17: in cage
# (software rendering) WebKitWebProcess crashed 3 s into our share.
[ "${NOSHARE:-0}" = 1 ] && STEPS="$(sed -E 's/(^|,)(share|share-change)(,|$)/\1wait\3/g; s/(^|,)(share|share-change)(,|$)/\1wait\3/g' <<<"$STEPS")"
log() { echo "$(date +%T) $*"; }
nsteps() { local n; n=$(grep -c '\[page:test\] step ' "$OUT/app.log" 2>/dev/null); echo "${n:-0}"; }
at() { until [ "$(nsteps)" -ge "$1" ]; do sleep 0.3; kill -0 $LT 2>/dev/null || exit 1; done; }
users() { grep 'state screen' "$OUT/app.log" | tail -1 | sed -E 's/.*(users=.*) @[0-9]+$/\1/' | cut -c1-120; }
# Absolute path: the zp server's cwd is wherever it was first started.
zshot() { "$ZP" shot "$S/phone/$NAME-$1.png" >/dev/null; log "Z shot $1 | P sees $(users)"; }
# Phone actions: zp (zphone.py) reads the screen and confirms each step.
zp() { log "Z: $*"; "$ZP" "$@" 2>&1 | sed 's/^/    /'; }

( for i in $(seq 70); do "$P" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1; sleep 4; done ) &
WAKE=$!
"$D/live-test.sh" "$NAME" 255 "$STEPS" leave > "$S/$NAME.run" 2>&1 &
LT=$!
zp meeting

at 5;  sleep 4; zshot 01-P-unmuted
at 7;  sleep 4; zshot 02-P-muted
at 9;  sleep 5; zshot 03-P-camera-on
at 11; sleep 4; zshot 04-P-camera-off
at 12; sleep 5; zshot 05-P-sharing
at 14; sleep 5; zshot 06-P-share-changed
at 16; sleep 4; zshot 07-P-share-stopped
zp mic off;   sleep 4; zshot 08-Z-muted
zp mic on;    sleep 4; zshot 09-Z-unmuted
zp cam off;   sleep 4; zshot 10-Z-video-off
zp cam on;    sleep 4; zshot 11-Z-video-on
zp share;     zp home; sleep 10; log "P sees $(users)"
WAYLAND_DISPLAY="$(cat "$OUT/wayland-display")" grim "$OUT/P-sees-Z-share.png" 2>/dev/null; log "P screenshot of Z's share"
zp stop-share; sleep 3; zshot 12-Z-share-stopped
at 26; sleep 3; zshot 13-chat
at 27; zp make-host "${TNAME:-Penguin test}"; sleep 2; zshot 14-P-is-host
at 32; sleep 4; zshot 15-host-back-to-Z
wait $LT; kill $WAKE 2>/dev/null; "$ZP" quit
log "done"
grep -E 'step |share\]|screencast:|glue|useCamera|unhandled|console.error' "$OUT/app.log" | grep -v 'step wait' | cut -c1-170

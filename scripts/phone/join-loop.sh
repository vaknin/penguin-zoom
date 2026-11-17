#!/bin/bash
# Joins the phone's meeting ($S/meeting.txt) again and again with the camera on,
# to catch the joins where the SDK rejects join() during the waiting-room
# handover (PLAN §5.6) and see whether the phone still gets our picture.
# Usage: S=<dir> join-loop.sh <max joins> [prefix] [stop after this many reconnect joins]
# Per join: one line with reconnect=yes|no, our audio/video state, and the
# phone's picture colour at 30 s and 60 s (mean saturation x1000 of the middle
# of its screenshot: Zoom's grey avatar on black is ~0, a camera picture 50+).
# Phone screenshots: $S/phone/<prefix><i>-phone-{30,60}.png
S="${S:?set S to a work directory}"; export S
D="$(cd "$(dirname "$0")" && pwd)"
N="${1:-10}"; PFX="${2:-j}"; WANT="${3:-5}"
CAM="${CAM:-USB2.0 HD UVC WebCam}"
mkdir -p "$S/config/penguin-zoom"
printf '{"joinMuted":true,"joinCameraOff":false,"camera":"%s"}\n' "$CAM" > "$S/config/penguin-zoom/settings.json"
spread() { [ -f "$1" ] && magick "$1" -gravity center -crop 60%x30%+0+0 +repage -colorspace HSL -channel G -separate -format '%[fx:int(mean*1000)]' info: 2>/dev/null || echo -; }
refused=0
for i in $(seq "$N"); do
  name="$PFX$i"
  ( for _ in $(seq 20); do "$D/ph.sh" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1; sleep 4; done ) &
  "$D/live-test.sh" "$name" "${SECS:-75}" "${STEPS:-wait,wait,wait,wait,wait,wait,wait}" leave > "$S/$name.run" 2>&1
  wait
  log="$S/$name/app.log"
  # "reconnect": join() was rejected by the waiting-room handover (glue.js).
  r=no; grep -q 'join() rejected while Zoom reconnects' "$log" && { r=yes; refused=$((refused+1)); }
  hw=no; grep -q 'saw the hardware encoding refusal' "$log" && hw=yes
  st="$(grep 'state screen' "$log" | sed -n '12p' | grep -o 'users=[^@]*')"
  echo "$(date +%T) $name reconnect=$r hw-refusal=$hw colour30=$(spread "$S/phone/$name-phone-30.png") colour60=$(spread "$S/phone/$name-phone-60.png") $st"
  [ "$refused" -ge "$WANT" ] && break
  for _ in $(seq 20); do ss -ltn | grep -q '127.0.0.1:53682 ' || break; sleep 0.5; done
done
echo "joins through the reconnect path: $refused"

#!/bin/bash
# Starts a Zoom meeting on the phone (from the Zoom home or "Start a meeting"
# screen) and writes "ID PASSCODE" to $S/meeting.txt.
S="${S:?set S to a work directory}"; D="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$S/phone"
cd $S
ui() { "$D/ph.sh" ui; }
has() { ui | grep -qE "$1"; }
"$D/ph.sh" shell monkey -p us.zoom.videomeetings -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 3
if has "^'Meet'"; then "$D/ph.sh" tap '^Meet$' >/dev/null; sleep 3; fi
if has "btnStartMeeting"; then "$D/ph.sh" shell input tap 540 769; sleep 6; fi
if has "^'Start'"; then "$D/ph.sh" tap '^Start$' >/dev/null; sleep 8; fi
# Toolbar -> More -> Meeting info (toolbar auto-hides, so show and tap in one go).
for i in 1 2 3 4; do
  "$D/ph.sh" shell "input tap 540 1200; sleep 1.2; input tap 724 2253"; sleep 2
  "$D/ph.sh" tap '^Meeting info' >/dev/null && break
done
sleep 2
ui > phone/info.txt
id=$(grep -A1 "^'Meeting ID'" phone/info.txt | tail -1 | grep -oE "^'[0-9 ]+'" | tr -d "' ")
pw=$(grep -A1 "^'Passcode'" phone/info.txt | tail -1 | grep -oE "^'[^']+'" | tr -d "'")
"$D/ph.sh" tap '^Close$' >/dev/null
[ -n "$id" ] && echo "$id $pw" > meeting.txt && echo "meeting $id passcode $pw" || { echo "could not read meeting info"; exit 1; }

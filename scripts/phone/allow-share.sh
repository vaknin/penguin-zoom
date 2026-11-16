#!/bin/bash
# In the phone's running meeting (phone is host): Host tools -> Participants ->
# turn "Share screen" on if it is off (new meetings default to host-only, and
# a participant's share then fails with 6204). The switch's state is read from
# a screenshot (its colour), so a switch that is already on is left alone.
S="${S:?set S to a work directory}"; D="$(cd "$(dirname "$0")" && pwd)"; P="$D/ph.sh"
"$P" shell monkey -p us.zoom.videomeetings -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2
"$P" shell "input tap 540 1000; sleep 1.0; input tap 724 2253"; sleep 2
"$P" tap 'Host tools' >/dev/null || { echo "no Host tools (not host?)"; exit 1; }; sleep 2
"$P" tap '^Participants$' >/dev/null || { echo "no Participants page"; exit 1; }; sleep 2
"$P" ui >/dev/null
# The switch sits on the right of the "Share screen" row.
xy=$(python3 -I - "$S/phone/ui.xml" <<'PY'
import sys,re,xml.etree.ElementTree as E
for n in E.parse(sys.argv[1]).iter('node'):
    if (n.get('text') or '') == 'Share screen':
        a,b,c,d = map(int, re.findall(r'\d+', n.get('bounds'))); print(925, (b+d)//2); break
PY
)
[ -n "$xy" ] || { echo "no Share screen row"; exit 1; }
"$P" shot allow-share >/dev/null
on=$(python3 -I - "$S/phone/allow-share.png" $xy <<'PY'
import sys
from PIL import Image
x, y = int(sys.argv[2]), int(sys.argv[3])
r, g, b = Image.open(sys.argv[1]).convert('RGB').getpixel((x, y))
print('on' if b > 180 and b > r + 60 else 'off')   # the "on" switch is blue
PY
)
if [ "$on" = off ]; then "$P" shell input tap $xy; sleep 1; echo "participant sharing: turned on"; else echo "participant sharing: already on"; fi
"$P" shell input keyevent KEYCODE_BACK; sleep 0.5; "$P" shell input keyevent KEYCODE_BACK

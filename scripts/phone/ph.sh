#!/bin/bash
# phone helper: ph ui | ph tap "<text or desc regex>" | ph shot <name>
ADB="$HOME/Android/Sdk/platform-tools/adb"
# The serial changes whenever Wireless debugging restarts: take the first device.
A="$ADB -s $($ADB devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
P="${S:?set S to a work directory}/phone"; mkdir -p "$P"
case "$1" in
  ui) $A shell uiautomator dump /sdcard/ui.xml >/dev/null; $A shell cat /sdcard/ui.xml > $P/ui.xml
      python3 -I - $P/ui.xml <<'PY'
import sys,re,xml.etree.ElementTree as E
for n in E.parse(sys.argv[1]).iter('node'):
    t=n.get('text') or ''; d=n.get('content-desc') or ''; r=n.get('resource-id') or ''
    if t or d: print(f"{t!r:40} {d!r:40} {r.split('/')[-1]:30} {n.get('bounds')} {'C' if n.get('clickable')=='true' else ''}")
PY
  ;;
  tap) $A shell uiautomator dump /sdcard/ui.xml >/dev/null; $A shell cat /sdcard/ui.xml > $P/ui.xml
      xy=$(python3 -I - $P/ui.xml "$2" <<'PY'
import sys,re,xml.etree.ElementTree as E
pat=re.compile(sys.argv[2],re.I)
for n in E.parse(sys.argv[1]).iter('node'):
    if pat.search(n.get('text') or '') or pat.search(n.get('content-desc') or ''):
        a,b,c,d=map(int,re.findall(r'\d+',n.get('bounds'))); print((a+c)//2,(b+d)//2); break
PY
)
      [ -z "$xy" ] && { echo "not found: $2"; exit 1; }; echo "tap $2 at $xy"; $A shell input tap $xy ;;
  shot) $A exec-out screencap -p > $P/$2.png; magick $P/$2.png -resize 40% $P/$2s.png; echo $P/$2s.png ;;
  *) shift 0; $A "$@" ;;
esac

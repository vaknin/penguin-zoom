#!/bin/bash
# Join the phone meeting headlessly (audio only) and run scripts/audio-test.sh.
S="${S:?set S to a work directory}"; D="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$S/phone"
RUN=$1; AT=$2
read MID MPW < $S/meeting.txt
("$D/admit.sh" 50 > "$S/admit.log" 2>&1 &)
cd /home/kivan/Projects/zoom-client
scripts/headless-run.sh 170 $S/$RUN "http://127.0.0.1:53682/?m=$MID&pwd=$MPW&autojoin=1&autoav=audio" >/dev/null 2>&1 &
HR=$!
t0=$SECONDS
until grep -q '"me":{"audio":"computer"' $S/$RUN/app.log 2>/dev/null; do sleep 2; [ $((SECONDS-t0)) -gt 120 ] && { echo "audio never joined"; break; }; done
echo "audio joined after $((SECONDS-t0))s"
( sleep 24; "$D/ph.sh" shot ${AT}A >/dev/null; "$D/ph.sh" ui > $S/phone/ui${AT}A.txt ) &
scripts/audio-test.sh $S/$AT 15
wait $HR
echo "phaseA $(cat $S/$AT/phaseA.start)-$(cat $S/$AT/phaseA.end)"
grep "active-speaker" $S/$RUN/app.log | cut -c1-120

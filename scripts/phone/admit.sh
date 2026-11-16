#!/bin/bash
# Taps "Admit" on the phone whenever the waiting-room prompt shows, for $1 seconds.
# Goes through zp (one command at a time on its server, so it never collides
# with the test's other phone actions); a check costs ~0.2 s.
D="$(cd "$(dirname "$0")" && pwd)"
end=$((SECONDS+$1))
while [ $SECONDS -lt $end ]; do
  "$D/zp" tap '^Admit$' 0.5 2>/dev/null | grep -q '^tapped' && echo "admitted at $SECONDS"
  sleep 1
done

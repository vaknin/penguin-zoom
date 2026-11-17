#!/usr/bin/env bash
# Put the Marketplace app's webhook Secret Token on the VM as ZOOM_WEBHOOK_SECRET
# and restart the signer. Prompts without echo; the token goes over SSH stdin
# only (never on a command line, in a local file, or in shell history).
#
#   signer/deploy/set-webhook-secret.sh [ssh-target]   (default ubuntu@82.70.221.64)
set -euo pipefail
target=${1:-ubuntu@82.70.221.64}
read -rsp "Secret Token (Marketplace app > Features > Access): " tok; echo
[[ -n $tok && $tok =~ ^[A-Za-z0-9_-]+$ ]] || { echo "that doesn't look like a token" >&2; exit 1; }

# Runs on the VM; reads the token from stdin.
remote=$(cat <<'EOF'
set -euo pipefail
IFS= read -r tok
f=/etc/penguin-signer.env
{ sudo grep -v '^ZOOM_WEBHOOK_SECRET=' "$f" || true; printf 'ZOOM_WEBHOOK_SECRET=%s\n' "$tok"; } |
  sudo sh -c 'umask 077; cat > /etc/penguin-signer.env.new'
sudo chown root:root "$f.new"; sudo chmod 600 "$f.new"; sudo mv "$f.new" "$f"
sudo systemctl restart penguin-signer; sleep 1; systemctl is-active penguin-signer
EOF
)
printf '%s\n' "$tok" | ssh "$target" "bash -c $(printf %q "$remote")"

# Check as Zoom does: a signed endpoint.url_validation request.
body='{"event":"endpoint.url_validation","payload":{"plainToken":"check"},"event_ts":0}'
ts=$(date +%s)
sig=$(printf 'v0:%s:%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$tok" -hex | sed 's/^.* //')
unset tok
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -H "x-zm-request-timestamp: $ts" -H "x-zm-signature: v0=$sig" -d "$body" \
  https://penguin.kitah.co.il/v1/zoom-webhook)
echo "webhook check: HTTP $code (200 = ready for Zoom; 401 = token mismatch; 503 = secret not picked up)"

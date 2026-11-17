#!/usr/bin/env bash
# Store regenerated Marketplace client secrets. Prompts without echo; secrets go
# over stdin only (never on a command line, in a local file, or in shell history).
#   - Development secret: VM /etc/penguin-signer.env as ZOOM_SDK_SECRET (signer
#     restarted) and the local keyring (service penguin-zoom, key client-secret).
#   - Production secret (optional, Enter skips): local keyring only
#     (key client-secret-production), for the switch at approval.
#
#   signer/deploy/set-sdk-secret.sh [ssh-target]   (default ubuntu@82.70.221.64)
set -euo pipefail
target=${1:-ubuntu@82.70.221.64}
read -rsp "Development Client Secret: " dev; echo
[[ -n $dev && $dev =~ ^[A-Za-z0-9_-]+$ ]] || { echo "that doesn't look like a client secret" >&2; exit 1; }
read -rsp "Production Client Secret (Enter to skip): " prod; echo
[[ -z $prod || $prod =~ ^[A-Za-z0-9_-]+$ ]] || { echo "that doesn't look like a client secret" >&2; exit 1; }

# Runs on the VM; reads the secret from stdin.
remote=$(cat <<'EOF'
set -euo pipefail
IFS= read -r s
f=/etc/penguin-signer.env
{ sudo grep -v '^ZOOM_SDK_SECRET=' "$f" || true; printf 'ZOOM_SDK_SECRET=%s\n' "$s"; } |
  sudo sh -c 'umask 077; cat > /etc/penguin-signer.env.new'
sudo chown root:root "$f.new"; sudo chmod 600 "$f.new"; sudo mv "$f.new" "$f"
sudo systemctl restart penguin-signer; sleep 1; systemctl is-active penguin-signer
EOF
)
printf '%s\n' "$dev" | ssh "$target" "bash -c $(printf %q "$remote")"

printf '%s' "$dev" | secret-tool store --label='Penguin for Zoom client secret (Development)' \
  service penguin-zoom key client-secret
[[ -z $prod ]] || printf '%s' "$prod" | secret-tool store \
  --label='Penguin for Zoom client secret (Production)' service penguin-zoom key client-secret-production
unset dev prod
echo "keyring updated; signer: $(curl -s https://penguin.kitah.co.il/healthz)"

#!/usr/bin/env bash
# Build and (re)install penguin-signer on the VM. Idempotent: run it for the
# first install and for every update.
#
#   signer/deploy/deploy.sh ubuntu@203.0.113.7
#   PENGUIN_HOSTS="penguin.example.org, 203-0-113-7.sslip.io" signer/deploy/deploy.sh ubuntu@203.0.113.7
#
# PENGUIN_HOSTS: the public names Caddy serves (signing API + site/ pages) and
# gets certificates for, comma-separated. Default for an IPv4 target:
# <ip-with-dashes>.sslip.io. Secrets are never handled here; put them in
# /etc/penguin-signer.env on the VM (README.md).
#
# Caddy: our config goes to /etc/caddy/penguin.caddy and the main Caddyfile only
# gets an `import penguin.caddy` line, so other sites in it are kept.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <ssh-target, e.g. ubuntu@203.0.113.7>" >&2
  exit 64
fi
target=$1
host_part=${target#*@}

if [[ -z ${PENGUIN_HOSTS:-} ]]; then
  if [[ $host_part =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    PENGUIN_HOSTS="${host_part//./-}.sslip.io"
  else
    echo "set PENGUIN_HOSTS (the public HTTPS names), e.g. PENGUIN_HOSTS=penguin.example.org" >&2
    exit 64
  fi
fi
IFS=',' read -ra _hosts <<<"$PENGUIN_HOSTS"
for h in "${_hosts[@]}"; do
  h=${h// /}
  if [[ ! $h =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    echo "not a host name in PENGUIN_HOSTS: '$h'" >&2
    exit 64
  fi
done

src=$(cd "$(dirname "$0")/.." && pwd)
remote_dir=penguin-signer-src

site=$(cd "$src/../site" && pwd)

echo "==> syncing $src to $target:$remote_dir"
rsync -az --delete --exclude /target/ --exclude .git/ -e ssh "$src/" "$target:$remote_dir/"
echo "==> syncing $site to $target:penguin-site"
rsync -az --delete --exclude .nojekyll -e ssh "$site/" "$target:penguin-site/"

echo "==> building and installing on $target (PENGUIN_HOSTS=$PENGUIN_HOSTS)"
# shellcheck disable=SC2087  # expand PENGUIN_HOSTS locally, the rest remotely
ssh "$target" "PENGUIN_HOSTS='$PENGUIN_HOSTS' REMOTE_DIR='$remote_dir' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/$REMOTE_DIR"

if [[ ! -f /var/lib/penguin-signer/cloud-init.done ]]; then
  echo "cloud-init has not finished (or was not used); see README.md" >&2
  exit 1
fi

# Toolchain (cloud-init installs it; this covers a VM set up by hand).
if [[ ! -x $HOME/.cargo/bin/cargo ]]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
export PATH=$HOME/.cargo/bin:$PATH
rustup update stable --no-self-update >/dev/null

cargo build --release --locked

# Service user (cloud-init creates it; idempotent fallback).
id signer >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin signer

# Binary: atomic replace.
sudo install -m 0755 -o root -g root target/release/penguin-signer /usr/local/bin/penguin-signer.new
sudo mv -f /usr/local/bin/penguin-signer.new /usr/local/bin/penguin-signer

# systemd unit.
sudo install -m 0644 -o root -g root deploy/penguin-signer.service /etc/systemd/system/penguin-signer.service

# Public pages.
sudo install -d -m 0755 /srv/penguin-site
sudo rsync -a --delete --chown=root:root --chmod=D0755,F0644 "$HOME/penguin-site/" /srv/penguin-site/

# Caddy: our own file, imported from the main Caddyfile (other sites kept).
sudo install -m 0644 -o root -g root deploy/penguin.caddy /etc/caddy/penguin.caddy
# sudo tee, not `install` from stdin: that fails over SSH on Ubuntu.
printf 'PENGUIN_HOSTS=%s\n' "$PENGUIN_HOSTS" | sudo tee /etc/caddy/penguin.env >/dev/null
sudo chmod 0644 /etc/caddy/penguin.env
if [[ ! -f /etc/caddy/Caddyfile ]]; then
  sudo install -m 0644 -o root -g root deploy/Caddyfile.main /etc/caddy/Caddyfile
elif ! sudo grep -qE '^[[:space:]]*import[[:space:]]+(/etc/caddy/)?penguin\.caddy' /etc/caddy/Caddyfile; then
  if sudo grep -q 'SIGNER_HOST' /etc/caddy/Caddyfile; then
    echo "!! /etc/caddy/Caddyfile still has the old {\$SIGNER_HOST} site block." >&2
    echo "!! Remove that block, then run this again (it adds 'import penguin.caddy')." >&2
    exit 1
  fi
  sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  printf '\nimport penguin.caddy\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null
fi
sudo install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/penguin.env\n' |
  sudo tee /etc/systemd/system/caddy.service.d/penguin.conf >/dev/null

# Firewall (idempotent).
sudo bash deploy/open-web-ports.sh

sudo systemctl daemon-reload
sudo systemctl enable penguin-signer.service >/dev/null

# The env file must stay root-only.
if sudo test -f /etc/penguin-signer.env; then
  sudo chown root:root /etc/penguin-signer.env
  sudo chmod 600 /etc/penguin-signer.env
  sudo systemctl restart penguin-signer.service
else
  echo
  echo "!! /etc/penguin-signer.env is missing: the service will not start until you"
  echo "!! create it (README.md, 'Put the secrets in place'), then run:"
  echo "!!   sudo systemctl restart penguin-signer"
fi

sudo PENGUIN_HOSTS="$PENGUIN_HOSTS" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

sleep 1
if systemctl is-active --quiet penguin-signer; then
  printf 'local health: '; curl -fsS http://127.0.0.1:8080/healthz; echo
else
  echo "penguin-signer is not running: sudo journalctl -u penguin-signer -n 50"
fi
REMOTE

echo "==> done. Check from here: curl https://${_hosts[0]// /}/healthz"

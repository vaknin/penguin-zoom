#!/usr/bin/env bash
# Build and (re)install penguin-signer on the VM. Idempotent: run it for the
# first install and for every update.
#
#   signer/deploy/deploy.sh ubuntu@203.0.113.7
#   SIGNER_HOST=signer.example.org signer/deploy/deploy.sh ubuntu@203.0.113.7
#
# SIGNER_HOST is the public name Caddy serves and gets a certificate for.
# Default for an IPv4 target: <ip-with-dashes>.sslip.io. Secrets are never
# handled here; put them in /etc/penguin-signer.env on the VM (README.md).
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <ssh-target, e.g. ubuntu@203.0.113.7>" >&2
  exit 64
fi
target=$1
host_part=${target#*@}

if [[ -z ${SIGNER_HOST:-} ]]; then
  if [[ $host_part =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SIGNER_HOST="${host_part//./-}.sslip.io"
  else
    echo "set SIGNER_HOST (the public HTTPS name), e.g. SIGNER_HOST=203-0-113-7.sslip.io" >&2
    exit 64
  fi
fi
if [[ ! $SIGNER_HOST =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "SIGNER_HOST does not look like a host name: $SIGNER_HOST" >&2
  exit 64
fi

src=$(cd "$(dirname "$0")/.." && pwd)
remote_dir=penguin-signer-src

echo "==> syncing $src to $target:$remote_dir"
rsync -az --delete --exclude /target/ --exclude .git/ -e ssh "$src/" "$target:$remote_dir/"

echo "==> building and installing on $target (SIGNER_HOST=$SIGNER_HOST)"
# shellcheck disable=SC2087  # expand SIGNER_HOST locally, the rest remotely
ssh "$target" "SIGNER_HOST='$SIGNER_HOST' REMOTE_DIR='$remote_dir' bash -s" <<'REMOTE'
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

# Caddy: site config plus the SIGNER_HOST it reads.
sudo install -m 0644 -o root -g root deploy/Caddyfile /etc/caddy/Caddyfile
printf 'SIGNER_HOST=%s\n' "$SIGNER_HOST" | sudo install -m 0644 -o root -g root /dev/stdin /etc/caddy/penguin.env
sudo install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/penguin.env\n' |
  sudo install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/caddy.service.d/penguin.conf

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

sudo SIGNER_HOST="$SIGNER_HOST" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

sleep 1
if systemctl is-active --quiet penguin-signer; then
  printf 'local health: '; curl -fsS http://127.0.0.1:8080/healthz; echo
else
  echo "penguin-signer is not running: sudo journalctl -u penguin-signer -n 50"
fi
REMOTE

echo "==> done. Check from here: curl https://$SIGNER_HOST/healthz"

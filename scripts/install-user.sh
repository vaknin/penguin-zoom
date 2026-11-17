#!/usr/bin/env bash
# Install (or update) Penguin for Zoom for the current user only, from this
# source tree. No sudo, no pacman:
#   ~/.local/bin/penguin-zoom                      the program
#   ~/.local/share/penguin-zoom/{ui,web,assets}    its files and Zoom's SDK
#   ~/.local/share/applications/penguin-zoom.desktop + icon
# ~/.local/bin comes before /usr/bin on PATH and a launcher in
# ~/.local/share/applications hides a system one with the same name, so this
# copy wins over an installed pacman package.
#
#   scripts/install-user.sh            build and install
#   scripts/install-user.sh --remove   remove the per-user install
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
SHARE="$DATA/penguin-zoom"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor/scalable/apps"

if [[ ${1:-} == --remove ]]; then
  rm -f "$BIN/penguin-zoom" "$APPS/penguin-zoom.desktop" "$ICONS/penguin-zoom.svg"
  rm -rf "$SHARE"
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
  echo "removed the per-user install (settings in ~/.config/penguin-zoom are kept)"
  exit 0
fi

# Running copy: replacing files under a running app is fine on Linux (it keeps
# the old ones open), but it only picks up the new version after a restart.
pgrep -x penguin-zoom >/dev/null && echo "note: Penguin is running; restart it to use the new version"

echo "==> building (release)"
(cd "$ROOT" && RUSTC_WRAPPER= cargo build --release --locked)

ver="$(cat "$ROOT/assets/zoom-sdk/VERSION" 2>/dev/null || echo 6.10.0)"
if [[ ! -f "$ROOT/assets/zoom-sdk/VERSION" ]]; then
  echo "==> fetching Zoom's Meeting SDK $ver"
  "$ROOT/scripts/fetch-sdk.sh" "$ver"
fi

echo "==> installing to $SHARE"
stage="$(mktemp -d "$DATA/.penguin-zoom.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/assets"
cp -r "$ROOT/ui" "$ROOT/web" "$stage/"
cp -r "$ROOT/assets/zoom-sdk" "$stage/assets/"
# The spike page and its script stay out, as in the package. So do the
# diagnostic pages that are sometimes copied into ui/ for tests.
rm -f "$stage/web/index.html" "$stage/web/spike.js" "$stage"/ui/_*.html
old="$SHARE.old.$$"
[[ -d $SHARE ]] && mv "$SHARE" "$old"
mv "$stage" "$SHARE"
rm -rf "$old"
trap - EXIT

mkdir -p "$BIN" "$APPS" "$ICONS"
install -m755 "$ROOT/target/release/penguin-zoom" "$BIN/penguin-zoom.new"
mv -f "$BIN/penguin-zoom.new" "$BIN/penguin-zoom"
install -m644 "$ROOT/packaging/penguin-zoom.svg" "$ICONS/penguin-zoom.svg"
# Absolute Exec: launchers started outside a login shell may not have ~/.local/bin on PATH.
sed "s|^Exec=penguin-zoom|Exec=$BIN/penguin-zoom|" "$ROOT/packaging/penguin-zoom.desktop" > "$APPS/penguin-zoom.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
# Zoom links open Penguin (the handler is per user anyway).
xdg-mime default penguin-zoom.desktop x-scheme-handler/zoommtg x-scheme-handler/zoomus

echo "==> installed: $BIN/penguin-zoom (data $SHARE)"
[[ "$(command -v penguin-zoom)" == "$BIN/penguin-zoom" ]] || echo "note: another penguin-zoom comes first on PATH: $(command -v penguin-zoom)"

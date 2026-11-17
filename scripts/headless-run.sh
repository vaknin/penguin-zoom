#!/usr/bin/env bash
# Runs the app inside its own headless compositor (cage), never in the owner's
# Hyprland session: cage gets no DRM, no input devices and no GPU (pixman), so
# it can't take the owner's keyboard, mouse, focus or screen. (2026-11-17: a
# virtual monitor inside the owner's Hyprland froze their desktop for ~5 min.)
# Screenshots come from grim on cage's own socket (written to $OUT/wayland-display).
#
# Usage: scripts/headless-run.sh <seconds> <outdir> [url] [shot-at-seconds...]
#   e.g. scripts/headless-run.sh 25 /tmp/out "http://127.0.0.1:53682/?nomedia" 10 20
# Extra env (ZOOM_SPIKE_*, ZOOM_SHARE_SOURCE, ZOOM_PUBLIC_CLIENT_ID) is passed through.
# CAGE_RENDERER=gles2 gives cage (and WebKit) the GPU; still headless, no input
# devices. Default pixman. The owner allowed GPU runs on 2026-11-17.
# Tests don't use the owner's saved Zoom sign-in (PENGUIN_NO_KEYRING=1) unless
# USE_KEYRING=1 is set, for a sign-in test the owner asked for.
# NICE=<n> sets the priority (default 15; 0 for measuring video send quality).
# BIN=<path> runs another build (e.g. the packaged one, with PENGUIN_ZOOM_DATA).
set -euo pipefail
SECS="$1"; OUT="$2"; URL="${3:-http://127.0.0.1:53682/}"; shift 3 || shift $#
SHOTS=("$@")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
command -v cage >/dev/null || { echo "headless-run.sh: cage is not installed" >&2; exit 1; }
rm -f "$OUT/wayland-display"

# Strip everything that points at the owner's session: no Wayland/X socket to
# nest into, no Hyprland instance for hyprctl (the app calls it to raise itself).
# The app's own children (screen share, pactl) still see this env.
NK=(PENGUIN_NO_KEYRING=1); [ -n "${USE_KEYRING:-}" ] && NK=(-u PENGUIN_NO_KEYRING)
ZOOM_SPIKE_URL="$URL" timeout "$SECS" \
  env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u HYPRLAND_CMD \
      WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER="${CAGE_RENDERER:-pixman}" \
      WLR_HEADLESS_OUTPUTS=1 \
      "${NK[@]}" \
  nice -n "${NICE:-15}" cage -- sh -c 'echo "$WAYLAND_DISPLAY" > "$0/wayland-display"; exec "$1"' "$OUT" "${BIN:-$ROOT/target/debug/penguin-zoom}" \
  >"$OUT/app.log" 2>&1 &
APP=$!
cleanup() { kill "$APP" 2>/dev/null || true; }
trap cleanup EXIT

start=$(date +%s)
for _ in $(seq 50); do [ -s "$OUT/wayland-display" ] && break; sleep 0.1; done
SOCK="$(cat "$OUT/wayland-display" 2>/dev/null || true)"
[ -n "$SOCK" ] || echo "headless-run.sh: cage did not start (see $OUT/app.log)" >&2
for t in "${SHOTS[@]}"; do
  while [ $(( $(date +%s) - start )) -lt "$t" ]; do sleep 0.5; kill -0 "$APP" 2>/dev/null || break 2; done
  [ -n "$SOCK" ] && WAYLAND_DISPLAY="$SOCK" grim "$OUT/shot-${t}s.png" 2>/dev/null || true
done
wait "$APP" || true
echo "log: $OUT/app.log"

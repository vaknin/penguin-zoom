#!/usr/bin/env bash
# Vendors Zoom's Meeting SDK for Web into assets/zoom-sdk (gitignored: Zoom's terms
# govern redistribution, so the SDK is fetched, never committed).
set -euo pipefail
VERSION="${1:-6.10.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/assets/zoom-sdk"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" && npm pack "@zoom/meetingsdk@$VERSION" --ignore-scripts --silent >/dev/null && tar xzf ./*.tgz)
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$TMP/package/dist/." "$DEST/"
cp "$TMP/package/LICENSE.md" "$DEST/"
echo "$VERSION" > "$DEST/VERSION"
echo "Zoom Meeting SDK $VERSION -> $DEST"

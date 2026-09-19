#!/bin/bash
# Package MacPuffin.app into a distributable disk image.
#
#   ./make-dmg.sh             -> ./dist/MacPuffin.dmg
#   ./make-dmg.sh /some/dir   -> /some/dir/MacPuffin.dmg
#
# Builds the app first, so the image always matches the current source.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$SRC/dist}"
VERSION="$(node -p "require('$SRC/package.json').version")"
STAGE="$SRC/native/build/dmg-stage"
DMG="$OUT_DIR/MacPuffin.dmg"

mkdir -p "$OUT_DIR"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"

echo "==> Building the app for packaging"
"$SRC/build-app.sh" "$STAGE" >/dev/null

# Fail loudly rather than shipping a single-architecture build by accident.
ARCHS="$(lipo -archs "$STAGE/MacPuffin.app/Contents/MacOS/MacPuffin")"
case "$ARCHS" in
  *arm64*) ;;
  *) echo "refusing to package: no arm64 slice ($ARCHS)"; exit 1 ;;
esac
case "$ARCHS" in
  *x86_64*) ;;
  *) echo "refusing to package: no x86_64 slice ($ARCHS)"; exit 1 ;;
esac
echo "--> universal binary verified: $ARCHS"

# A drop target, so the window reads "drag this there" with no instructions.
ln -s /Applications "$STAGE/Applications"

cat > "$STAGE/Read me first.txt" <<'TXT'
MacPuffin
========

1. Drag MacPuffin.app into the Applications folder.

2. The first time you open it, right-click the app and choose "Open", then
   confirm. macOS shows a warning because this build is signed ad-hoc rather
   than with a paid Apple Developer ID. A normal double-click will be blocked;
   right-click -> Open is the one-time way through.

   If macOS says the app "is damaged", the quarantine flag needs clearing:

       xattr -dr com.apple.quarantine /Applications/MacPuffin.app

3. MacPuffin needs Node.js 20 or newer:

       brew install node

   It will tell you if Node is missing.

Everything runs on this Mac. The app makes no outbound network connections.
Source: https://github.com/veraplot/MacPuffin
TXT

echo "==> Creating $DMG"
hdiutil create \
  -volname "MacPuffin $VERSION" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$DMG" >/dev/null

rm -rf "$STAGE"

SIZE="$(du -h "$DMG" | cut -f1 | tr -d ' ')"
echo "==> Done: $DMG ($SIZE)"
shasum -a 256 "$DMG" | tee "$DMG.sha256"

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
=========

INSTALLING

  1. Drag MacPuffin into the Applications folder, next to this note.

  2. Open your Applications folder and double-click MacPuffin.

  3. The first time only, macOS will say it "cannot be opened because Apple
     cannot check it for malicious software". This is expected. Click Done,
     then:

        Apple menu  ->  System Settings
        Privacy & Security
        scroll to the bottom
        next to "MacPuffin was blocked", click Open Anyway

     Enter your password, and MacPuffin opens. You only do this once.

WHY THAT STEP EXISTS

  Apple charges a yearly fee to developers so their apps open without this
  message. MacPuffin is free and has no company behind it, so it has not paid
  that fee. macOS therefore asks you to confirm, once, that you meant to open
  it. It is not a virus warning, and nothing is wrong with the download.

  If you would rather not, you can build MacPuffin yourself from the source
  code - the instructions are on the page below, and a build you make yourself
  opens with no warning at all.

NOTHING ELSE TO INSTALL

  Everything MacPuffin needs is inside the app. No other downloads, no
  Terminal, no setup.

WHAT IT DOES WITH YOUR FILES

  It reads them to measure them, and that is all. Nothing is uploaded, and
  nothing is ever deleted: anything you remove goes to the Trash, where you can
  put it back. Space is only freed once you empty the Trash.

Source code and help: https://github.com/veraplot/MacPuffin
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

# ── Notarisation ──────────────────────────────────────────────────────────────
# Apple checks the image and issues a ticket; stapling attaches that ticket so
# the app opens even on a Mac that is offline. Skipped unless a notary profile
# is named, and skipped with a warning if the build was only ad-hoc signed,
# because Apple rejects anything not signed with a Developer ID.
if [ -n "${NOTARY_PROFILE:-}" ]; then
  if [ "${SIGN_IDENTITY:--}" = "-" ]; then
    echo "!!  NOTARY_PROFILE is set but SIGN_IDENTITY is not."
    echo "!!  Apple only notarises builds signed with a Developer ID Application"
    echo "!!  certificate; an ad-hoc signature is always rejected. Skipping."
  else
    echo "==> Notarising (this usually takes a few minutes)"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    echo "    stapled — this image opens on a double-click, even offline"
  fi
fi

SIZE="$(du -h "$DMG" | cut -f1 | tr -d ' ')"
echo "==> Done: $DMG ($SIZE)"
echo "    self-contained: the Node runtime is inside the app, nothing to install"
shasum -a 256 "$DMG" | tee "$DMG.sha256"

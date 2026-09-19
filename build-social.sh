#!/bin/bash
# Render the GitHub social preview card: docs/social-preview.png, 1280x640.
#
# GitHub has no convention for a logo file in the repository root — that is a
# GitLab behaviour. The nearest equivalent is the social preview, uploaded once
# under Settings -> General -> Social preview. This script regenerates the image
# whenever the icon or the wording changes.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$SRC/docs/social-preview.png"

[ -x "$CHROME" ] || { echo "Google Chrome is needed to render the card"; exit 1; }

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1280,640 --screenshot="$OUT" \
  "file://$SRC/native/social-preview.html" >/dev/null 2>&1

SIZE_BYTES=$(stat -f%z "$OUT")
if [ "$SIZE_BYTES" -gt 1000000 ]; then
  echo "refusing: $OUT is $((SIZE_BYTES / 1000)) kB, over GitHub's 1 MB limit"
  exit 1
fi

# The root logo tracks the same artwork, for mirrors and tools that look for it.
sips -Z 512 "$SRC/native/icon.png" --out "$SRC/logo.png" >/dev/null

echo "==> docs/social-preview.png  ($(du -h "$OUT" | cut -f1))"
echo "==> logo.png                 ($(du -h "$SRC/logo.png" | cut -f1))"
echo
echo "Upload the card once at:"
echo "  https://github.com/veraplot/MacPuffin/settings  ->  Social preview  ->  Edit"

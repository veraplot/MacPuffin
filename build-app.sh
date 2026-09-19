#!/bin/bash
# Build MacPuffin.app — a native WKWebView shell that boots the bundled server.
#
#   ./build-app.sh              -> builds to ~/Desktop/MacPuffin.app
#   ./build-app.sh /Applications -> builds into another folder
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${1:-$HOME/Desktop}"
APP="$DEST_DIR/MacPuffin.app"
BUILD="$SRC/native/build"
# Single source of truth for the version: package.json.
VERSION="$(node -p "require('$SRC/package.json').version")"

echo "==> Building $APP (v$VERSION)"
rm -rf "$APP"; mkdir -p "$BUILD"
mkdir -p "$BUILD" "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ── 1. Compile the Swift parts as universal binaries ──────────────────────────
# Both architectures, so one download runs on Apple Silicon and on Intel.
# macOS 11 is the floor: it is the first release that exists on arm64 at all.
DEPLOY_TARGET="11.0"
ARCHS=(arm64 x86_64)

build_universal() {          # $1 = source file, $2 = output path, $3… = extra flags
  local src="$1" out="$2"; shift 2
  local slices=()
  for arch in "${ARCHS[@]}"; do
    local slice="$BUILD/$(basename "$out")-$arch"
    xcrun swiftc -O -target "$arch-apple-macosx$DEPLOY_TARGET" "$@" -o "$slice" "$src"
    slices+=("$slice")
  done
  lipo -create "${slices[@]}" -output "$out"
  rm -f "${slices[@]}"
}

echo "--> compiling MacPuffin.swift (arm64 + x86_64)"
build_universal "$SRC/native/MacPuffin.swift" "$APP/Contents/MacOS/MacPuffin" \
  -framework Cocoa -framework WebKit

# The trash helper: FileManager.trashItem, so items get proper "Put Back".
# Built into native/build for terminal runs and copied into the bundle below.
echo "--> compiling mptrash.swift (arm64 + x86_64)"
build_universal "$SRC/native/mptrash.swift" "$BUILD/mptrash"
cp "$BUILD/mptrash" "$APP/Contents/Resources/mptrash"

# ── 2. Icon ───────────────────────────────────────────────────────────────────
# native/icon.png is the committed 1024 master, composed by native/compose-icon.py
# from the generated puffin artwork. Slicing it needs only sips and iconutil.
ICONSET="$BUILD/MacPuffin.iconset"
MASTER="$SRC/native/icon.png"
mkdir -p "$ICONSET"

if [ -f "$MASTER" ]; then
  echo "--> slicing icon"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$MASTER" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$MASTER" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
else
  echo "--> WARNING: native/icon.png missing, app will use the generic icon"
fi

# ── 3. Bundle the Node runtime ────────────────────────────────────────────────
# Shipping Node inside the app is what makes it a normal Mac download: the user
# drags it to Applications and opens it. No Homebrew, no terminal, no install
# step. It costs about 70 MB compressed, which is the right trade.
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
NODE_CACHE="$BUILD/node-cache/$NODE_VERSION"
NODE_OUT="$APP/Contents/Resources/node"

fetch_node_slice() {                     # $1 = darwin arch name
  local arch="$1"
  local dest="$NODE_CACHE/$arch/node"
  [ -f "$dest" ] && return 0
  mkdir -p "$NODE_CACHE/$arch"
  echo "    downloading node $NODE_VERSION ($arch)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$arch.tar.gz" \
    | tar xz -C "$NODE_CACHE/$arch" --strip-components=2 "node-$NODE_VERSION-darwin-$arch/bin/node"
}

echo "--> bundling node $NODE_VERSION"
fetch_node_slice arm64
fetch_node_slice x64
lipo -create "$NODE_CACHE/arm64/node" "$NODE_CACHE/x64/node" -output "$NODE_OUT"
strip -S "$NODE_OUT" 2>/dev/null || true
chmod +x "$NODE_OUT"
NODE_ARCHS="$(lipo -archs "$NODE_OUT")"
case "$NODE_ARCHS" in *arm64*) ;; *) echo "bundled node has no arm64 slice"; exit 1 ;; esac
case "$NODE_ARCHS" in *x86_64*) ;; *) echo "bundled node has no x86_64 slice"; exit 1 ;; esac
echo "    node is universal: $NODE_ARCHS  ($(du -h "$NODE_OUT" | cut -f1))"

# ── 4. Bundle the server ──────────────────────────────────────────────────────
echo "--> copying server"
mkdir -p "$APP/Contents/Resources/app"
cp -R "$SRC/server.js" "$SRC/package.json" "$SRC/lib" "$SRC/public" "$APP/Contents/Resources/app/"

# ── 5. Info.plist ─────────────────────────────────────────────────────────────
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MacPuffin</string>
  <key>CFBundleDisplayName</key><string>MacPuffin</string>
  <key>CFBundleExecutable</key><string>MacPuffin</string>
  <key>CFBundleIdentifier</key><string>local.macpuffin.app</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Local tool. Runs entirely on this Mac.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>NSAppleEventsUsageDescription</key>
  <string>MacPuffin asks Finder to empty the Trash when you choose Empty Trash.</string>
</dict>
PLIST
echo '</plist>' >> "$APP/Contents/Info.plist"

# ── 6. Sign ───────────────────────────────────────────────────────────────────
# Nested executables must be signed individually: --deep does not reach binaries
# in Resources, and lipo plus strip invalidate the signature Node ships with, so
# an unsigned node is killed on sight by the kernel. Inner code first, then the
# bundle that contains it.
#
# Set SIGN_IDENTITY to a "Developer ID Application: …" identity to produce a
# build that can be notarised. Without it the build is ad-hoc signed, and the
# user has to approve it once in System Settings.
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")

if [ "$SIGN_IDENTITY" != "-" ]; then
  # Notarisation requires the hardened runtime; Node needs these relaxations to
  # keep working under it.
  cat > "$BUILD/entitlements.plist" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
ENT
  SIGN_ARGS=(--force --timestamp --options runtime
             --entitlements "$BUILD/entitlements.plist" --sign "$SIGN_IDENTITY")
fi

echo "--> signing with identity: $SIGN_IDENTITY"
codesign "${SIGN_ARGS[@]}" "$APP/Contents/Resources/node"
codesign "${SIGN_ARGS[@]}" "$APP/Contents/Resources/mptrash"
codesign "${SIGN_ARGS[@]}" "$APP/Contents/MacOS/MacPuffin"
codesign "${SIGN_ARGS[@]}" "$APP"

# A binary the kernel refuses to run is worse than no binary at all, so prove
# each one is valid and actually executable before the build is called done.
codesign --verify --strict "$APP/Contents/Resources/node"
codesign --verify --strict "$APP"
BUNDLED_NODE_VERSION="$("$APP/Contents/Resources/node" --version)" || {
  echo "    the bundled node will not run"; exit 1; }
echo "    bundled node runs: $BUNDLED_NODE_VERSION"

# Refresh the icon cache so Finder shows the new artwork immediately.
touch "$APP"
echo "==> Done: $APP"

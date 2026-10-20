#!/bin/sh
# Build and sign "MCU Input.app" into ~/.local/share/mac-computer-use-input. Signed with your Apple
# Development identity when there is one, so rebuilds keep the Accessibility permission; an ad-hoc
# signature loses it on every rebuild.
set -e
cd "$(dirname "$0")"
OUT="$HOME/.local/share/mac-computer-use-input"
APP="$OUT/MCU Input.app"
mkdir -p "$OUT"
rm -rf "$APP.new" && mkdir -p "$APP.new/Contents/MacOS"
swiftc -O -o "$APP.new/Contents/MacOS/mcu-input" main.swift
cat > "$APP.new/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.mac-computer-use.input</string>
  <key>CFBundleName</key><string>MCU Input</string>
  <key>CFBundleExecutable</key><string>mcu-input</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: .*\)"/\1/p' | head -1)
codesign --force --sign "${IDENTITY:--}" --identifier local.mac-computer-use.input "$APP.new"
rm -rf "$APP" && mv "$APP.new" "$APP"
pkill -f "MCU Input.app/Contents/MacOS/mcu-input" || true  # the next request launches the new build
echo "built $APP (signed: ${IDENTITY:-ad-hoc})"

#!/bin/sh
# sidehand installer for macOS: links the MCP server command into ~/.local/bin, freezes the Codex
# Computer Use runtime from your Codex install and builds the MCU Input helper.
# Safe to re-run after `git pull`.
set -e
cd "$(dirname "$0")"
REPO=$(pwd)
BIN="$HOME/.local/bin/mac-computer-use"

[ "$(uname)" = Darwin ] || { echo "sidehand's installer is for macOS (the Windows version lives in windows/)." >&2; exit 1; }
[ -d "$HOME/.codex/plugins/cache/openai-bundled/unified-computer-use" ] || {
  echo "Codex's Computer Use plugin was not found. Install the Codex app, open it and turn on Computer Use first (see README)." >&2
  exit 1
}
command -v swiftc >/dev/null || { echo "swiftc not found: run 'xcode-select --install' first." >&2; exit 1; }

mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/mac/mac-computer-use" "$BIN"
echo "linked $BIN -> $REPO/mac/mac-computer-use"

if [ -f "$HOME/.local/share/mac-computer-use/mcp.json" ]; then
  echo "Codex runtime already frozen (re-freeze with: mac-computer-use --snapshot)"
else
  "$BIN" --snapshot
fi

"$REPO/mac/input/build.sh"
open -g -j "$HOME/.local/share/mac-computer-use-input/MCU Input.app"

cat <<EOF

Done. Next steps:
  1. If macOS asks, allow "MCU Input" in System Settings > Privacy & Security > Accessibility
     (needed only for clicking windows behind full-screen apps or on other desktops).
  2. Add the MCP server to your client, e.g. Claude Code:
       claude mcp add --scope user mac-computer-use $BIN
EOF

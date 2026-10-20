# sidehand

**Let any AI agent use your Mac's apps, even while you work in a full-screen app.**

sidehand turns the Computer Use engine that ships with OpenAI's Codex app into a standard
[MCP](https://modelcontextprotocol.io) server. Claude Code, Claude Desktop, OpenCode, Hermes, Pi or any
other MCP client can then read and operate native macOS apps: accessibility tree, screenshots, clicks,
typing, scrolling, dragging.

It also fixes the thing that breaks most computer-use setups: the agent keeps working when the app it's
driving sits behind your full-screen window or on another desktop. Your cursor doesn't move, your
focus isn't stolen and your Space doesn't switch.

## Why sidehand

- **Works with any MCP client.** Codex asks for approval before every app action and expects the client
  to remember "always". sidehand answers those prompts for you. Codex's own app policy still blocks
  apps it forbids.
- **Background control.** Clicks, double and right clicks, drags and scrolls reach windows on other
  Spaces or behind full-screen apps, through a small helper (MCU Input) that sends the events straight
  to the target app. Element-based actions, typing and screenshots already worked there.
- **Codex updates can't break it.** It runs a frozen private copy of the Codex runtime; you re-freeze
  when you choose.
- **No telemetry.** Codex's own analytics opt-out is switched on, so your actions aren't reported.

## Requirements

- macOS 14 or later.
- **The Codex desktop app with Computer Use turned on.** Codex is a free download from OpenAI.
  sidehand contains no OpenAI code; it uses the copy installed on your Mac.
- Xcode Command Line Tools (`xcode-select --install`), to build MCU Input. They also provide Python 3.

## First-time setup

1. **Install Codex and turn on Computer Use.** Install and open the Codex app, then use Computer Use
   once (for example ask Codex to open Calculator and do a sum). Allow the Accessibility and
   Screen Recording prompts for **Codex Computer Use**; sidehand reuses those permissions. Check that
   the plugin is there:

   ```bash
   ls ~/.codex/plugins/cache/openai-bundled/unified-computer-use
   ```

2. **Clone and install.**

   ```bash
   git clone https://github.com/maccagnit/sidehand.git ~/sidehand
   ~/sidehand/install.sh
   ```

   This links `~/.local/bin/mac-computer-use`, freezes the Codex runtime into
   `~/.local/share/mac-computer-use` and builds MCU Input.

3. **Allow MCU Input.** macOS asks to let "MCU Input" control your computer: open System Settings >
   Privacy & Security > Accessibility and switch it on. It's only needed for background clicks, drags
   and scrolls.

4. **Add the server to your MCP client.** Claude Code:

   ```bash
   claude mcp add --scope user mac-computer-use ~/.local/bin/mac-computer-use
   ```

   Claude Desktop, OpenCode and other clients take a stdio server entry with the full path:

   ```json
   {
     "mcpServers": {
       "mac-computer-use": { "command": "/Users/<you>/.local/bin/mac-computer-use" }
     }
   }
   ```

5. **Try it.** Ask your agent: *"Use mac-computer-use to compute 37 × 23 in Calculator."*

## Using it

Everything goes through one tool, `js`, which runs JavaScript against the Computer Use API:

```js
globalThis.app = await cua.getApp("com.apple.calculator"); // returns the API docs and the app's UI
await app.click(24);                // click element 24 of the accessibility tree
await app.typeText("+2=");
await app.getAXState();             // what changed since the last look
```

Apps can be named by display name (which may be localized) or bundle id. Coordinate actions such as
`app.click([x, y])` use screenshot pixels.

## Updating

```bash
cd ~/sidehand && git pull && ./install.sh   # sidehand itself
mac-computer-use --snapshot                 # re-freeze from a newer Codex (previous copy kept in .prev)
```

## How background control works

Codex's helper does coordinate input with the real cursor, so when the target window isn't on your
current Space it refuses with `noWindowsAvailable`. sidehand catches that and:

- **scrolls by element** with the element's own accessibility scroll action, with no extra permission;
- **clicks, drags and scrolls by coordinate** through MCU Input, which posts the mouse events directly
  to the app's process, tagged with the target window.

Details and findings are in [docs/how-it-works.md](docs/how-it-works.md).

## Limitations

- After a background click, Codex's helper waits up to about 5 seconds before its next read of that
  app, because it treats input it didn't send as you touching the app. The model's thinking time
  usually hides it.
- Some apps may ignore input sent to them in the background. Element-index actions stay the most
  reliable.
- macOS only for now. A Windows version is coming to `windows/`.

## Security

- sidehand approves Codex's per-app prompts automatically: the agent can operate any app Codex's
  policy allows without asking you. Only connect it to agents you trust. Approvals are logged to
  `~/.codex/log/mac-computer-use.log`.
- MCU Input holds the Accessibility permission. It only accepts requests over a socket that only your
  user can open, and only from the frozen Codex runtime (checked by process path).

## What it installs

| Path | What |
|---|---|
| `~/.local/bin/mac-computer-use` | Link to `mac/mac-computer-use` in this repo |
| `~/.local/share/mac-computer-use/` | Frozen Codex runtime (and `.prev`) |
| `~/.local/share/mac-computer-use-input/` | `MCU Input.app` and its socket |
| `~/.codex/log/mac-computer-use.log` | Approval log |

To uninstall, delete those, remove the server from your MCP client and remove MCU Input from
System Settings > Privacy & Security > Accessibility.

## Disclaimer

sidehand is an independent project, not affiliated with or endorsed by OpenAI. It contains no OpenAI
code: Codex and its Computer Use component belong to OpenAI and are used from your own installation,
under OpenAI's terms. Use at your own risk.

## License

[MIT](LICENSE)

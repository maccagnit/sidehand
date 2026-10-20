# sidehand

**Let any AI agent use your Mac's or PC's apps, faster than Codex does it.**

sidehand turns the Computer Use engine that ships with OpenAI's Codex app into a standard
[MCP](https://modelcontextprotocol.io) server. Claude Code, Claude Desktop, OpenCode, Hermes, Pi or any
other MCP client can then read and operate native apps: accessibility tree, screenshots, clicks,
typing, scrolling, dragging. It works on **macOS** and **Windows**.

| | macOS ([`mac/`](mac)) | Windows ([`windows/`](windows)) |
|---|---|---|
| MCP servers | `mac-computer-use` | `windows-computer-use`, `windows-browser` |
| Tools | `js` (Codex's JavaScript API) | 13 typed tools, including `batch` |
| Background control | Clicks, drags and scrolls reach windows behind full-screen apps or on other Spaces | Screenshots and accessibility actions work on covered windows |
| Install | `./install.sh` | `windows\install.ps1` |

On the Mac it also fixes the thing that breaks most computer-use setups: the agent keeps working when
the app it's driving sits behind your full-screen window or on another desktop. Your cursor doesn't
move, your focus isn't stolen and your Space doesn't switch.

On Windows it talks to Codex's native helper directly, and its `batch` tool runs a whole sequence of
actions plus the follow-up screenshot in one call, so driving a UI costs far fewer model round trips.

# macOS

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

## Requirements (macOS)

- macOS 14 or later.
- **The Codex desktop app with Computer Use turned on.** Codex is a free download from OpenAI.
  sidehand contains no OpenAI code; it uses the copy installed on your Mac.
- Xcode Command Line Tools (`xcode-select --install`), to build MCU Input. They also provide Python 3.

## First-time setup (macOS)

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

## Using it (macOS)

Everything goes through one tool, `js`, which runs JavaScript against the Computer Use API:

```js
globalThis.app = await cua.getApp("com.apple.calculator"); // returns the API docs and the app's UI
await app.click(24);                // click element 24 of the accessibility tree
await app.typeText("+2=");
await app.getAXState();             // what changed since the last look
```

Apps can be named by display name (which may be localized) or bundle id. Coordinate actions such as
`app.click([x, y])` use screenshot pixels.

## Updating (macOS)

```bash
cd ~/sidehand && git pull && ./install.sh   # sidehand itself
mac-computer-use --snapshot                 # re-freeze from a newer Codex (previous copy kept in .prev)
```

## How background control works (macOS)

Codex's helper does coordinate input with the real cursor, so when the target window isn't on your
current Space it refuses with `noWindowsAvailable`. sidehand catches that and:

- **scrolls by element** with the element's own accessibility scroll action, with no extra permission;
- **clicks, drags and scrolls by coordinate** through MCU Input, which posts the mouse events directly
  to the app's process, tagged with the target window.

Details and findings are in [docs/how-it-works.md](docs/how-it-works.md).

## Limitations (macOS)

- After a background click, Codex's helper waits up to about 5 seconds before its next read of that
  app, because it treats input it didn't send as you touching the app. The model's thinking time
  usually hides it.
- Some apps may ignore input sent to them in the background. Element-index actions stay the most
  reliable.
## Security (macOS)

- sidehand approves Codex's per-app prompts automatically: the agent can operate any app Codex's
  policy allows without asking you. Only connect it to agents you trust. Approvals are logged to
  `~/.codex/log/mac-computer-use.log`.
- MCU Input holds the Accessibility permission. It only accepts requests over a socket that only your
  user can open, and only from the frozen Codex runtime (checked by process path).

## What it installs (macOS)

| Path | What |
|---|---|
| `~/.local/bin/mac-computer-use` | Link to `mac/mac-computer-use` in this repo |
| `~/.local/share/mac-computer-use/` | Frozen Codex runtime (and `.prev`) |
| `~/.local/share/mac-computer-use-input/` | `MCU Input.app` and its socket |
| `~/.codex/log/mac-computer-use.log` | Approval log |

To uninstall, delete those, remove the server from your MCP client and remove MCU Input from
System Settings > Privacy & Security > Accessibility.

# Windows

## Why sidehand on Windows

- **Fast.** Codex's helper answers input in 20 to 70 ms; almost all the time in a computer-use task
  goes into model round trips. The `batch` tool runs several actions and the follow-up observation
  in a single call (for example click a field, type, press Enter, wait, screenshot: one call instead
  of five). It stops at the first failing action and still observes, so the model always sees where
  it stopped.
- **Typed tools instead of a REPL.** `windows-computer-use` speaks to `codex-computer-use.exe`
  directly over its JSON protocol and exposes plain MCP tools: `list_apps`, `list_windows`,
  `launch_app`, `get_window_state`, `click`, `type_text`, `press_key`, `scroll`, `drag`, `set_value`,
  `perform_secondary_action`, `activate_window` and `batch`. Screenshots come back as MCP images,
  the accessibility tree as text.
- **Works with any MCP client.** Codex's per-app approval prompts are answered from your sidehand
  config, or turned into MCP elicitation prompts in clients that support them. Codex's own app policy
  still blocks apps it forbids.
- **No lingering overlay.** Codex ends every turn with `end_turn`, which hides the "is using your
  computer" overlay. MCP has no turns, so sidehand ends the turn itself after 5 seconds of inactivity
  and when the client disconnects.
- **Browser control too.** `windows-browser` exposes Codex's browser API (the ChatGPT browser
  extension in Edge or Chrome) to any MCP client, with your signed-in browser profile.
- **Codex updates can't break it.** It runs a frozen private copy of the Codex runtime; you re-freeze
  when you choose.

## Requirements (Windows)

- Windows 10 or 11.
- **The Codex desktop app, signed in, with Computer Use turned on.** sidehand contains no OpenAI
  code; it freezes a copy of the runtime installed on your PC, and the helper still asks your Codex
  install for its sign-in. Node.js is not needed: sidehand runs on the Node that ships with Codex.
- For `windows-browser`: the ChatGPT browser extension in Edge or Chrome, set up from Codex (its
  native messaging host is registered by Codex).

## First-time setup (Windows)

1. **Install Codex and turn on Computer Use.** Install and open the Codex app, sign in, then use
   Computer Use once (for example ask Codex to open Calculator and do a sum). Check that the runtime
   is there:

   ```powershell
   dir $env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\*\bin\node_modules\@oai\sky\bin\windows
   ```

2. **Clone and install.**

   ```powershell
   git clone https://github.com/maccagnit/sidehand.git $HOME\sidehand
   powershell -ExecutionPolicy Bypass -File $HOME\sidehand\windows\install.ps1
   ```

   This freezes the Codex runtime and CLI into `%LOCALAPPDATA%\sidehand`, writes the default config
   and prints the commands to register the servers.

3. **Add the servers to your MCP client.** Claude Code (use the exact paths the installer printed):

   ```powershell
   claude mcp add --scope user windows-computer-use -- "$env:LOCALAPPDATA\sidehand\runtime\node.exe" "$HOME\sidehand\windows\computer-use\server.mjs"
   claude mcp add --scope user windows-browser -- "$env:LOCALAPPDATA\sidehand\runtime\node.exe" "$HOME\sidehand\windows\browser\server.mjs"
   ```

   Claude Desktop, OpenCode and other clients take stdio server entries with full paths:

   ```json
   {
     "mcpServers": {
       "windows-computer-use": {
         "command": "C:\\Users\\<you>\\AppData\\Local\\sidehand\\runtime\\node.exe",
         "args": ["C:\\Users\\<you>\\sidehand\\windows\\computer-use\\server.mjs"]
       }
     }
   }
   ```

4. **Try it.** Ask your agent: *"Use windows-computer-use to compute 37 × 23 in Calculator."*

## Using it (Windows)

The workflow is: `list_apps` or `list_windows`, pick a window, `get_window_state`, act, observe again.
Prefer `element_index` actions (accessibility); coordinates are relative to the window screenshot.
When the next steps are predictable, use `batch`:

```json
{
  "window_id": 1234,
  "actions": [
    { "action": "click", "element_index": 5 },
    { "action": "type_text", "text": "37*23" },
    { "action": "press_key", "key": "Return" },
    { "action": "wait", "ms": 200 }
  ],
  "observe": "screenshot"
}
```

`observe` is `none`, `screenshot` (default), `text` (accessibility tree) or `both`.

`windows-browser` has one main tool, `js`, which runs JavaScript against Codex's browser API. Its first
call returns the API documentation. A typical start:

```js
var tab = await cua.createBrowserTab("edge", "https://example.com", { sessionName: "Task" });
```

## Updating (Windows)

```powershell
cd $HOME\sidehand; git pull                        # sidehand itself
powershell -ExecutionPolicy Bypass -File windows\install.ps1 --snapshot   # re-freeze from a newer Codex (previous copy kept in .prev)
```

Quit the MCP clients that use sidehand before re-freezing: Windows can't replace a runtime that is in use.

## Limitations (Windows)

- Input (`click` by coordinate, `type_text`, `press_key`, `scroll`, `drag`) brings the target window
  to the front and uses the real pointer and keyboard. Screenshots, the accessibility tree and
  element actions such as `set_value` work on covered windows.
- Pressing the physical Escape key stops Computer Use for the current turn; a new turn starts after
  60 seconds of inactivity.
- The Windows key and its shortcuts are not supported.
- `windows-browser` needs the browser extension backend; Codex's in-app browser only exists inside the
  Codex app. If Codex's browser stack rejects the app version sidehand reports, set
  `BROWSER_USE_CODEX_APP_VERSION` to your Codex version.

## Security (Windows)

- By default `%LOCALAPPDATA%\sidehand\config.json` holds `"allowedApps": ["*"]`, so Codex's per-app
  prompts are approved automatically, as on the Mac. Only connect it to agents you trust. Set it to
  `[]` to be asked per app (in clients that support MCP elicitation), or list specific app ids.
  Approvals are logged to `%LOCALAPPDATA%\sidehand\approvals.log`.
- Codex's own policy stays in force: apps and sites it blocks stay blocked.

## What it installs (Windows)

| Path | What |
|---|---|
| `%LOCALAPPDATA%\sidehand\runtime\` | Frozen Codex Computer Use runtime (and `.prev`) |
| `%LOCALAPPDATA%\sidehand\codex-cli\` | Frozen Codex CLI, which the helper uses to reach your Codex sign-in |
| `%LOCALAPPDATA%\sidehand\config.json` | App approvals |
| `%LOCALAPPDATA%\sidehand\approvals.log` | Approval log |

To uninstall, delete `%LOCALAPPDATA%\sidehand` and remove the servers from your MCP client.

Settings can be overridden with environment variables in the server entry: `SIDEHAND_HOME`,
`SIDEHAND_RUNTIME`, `SIDEHAND_CODEX_CLI`, `SIDEHAND_HELPER`, `SIDEHAND_CONFIG`, `CODEX_HOME`,
`SIDEHAND_TURN_IDLE_MS`, `SIDEHAND_OVERLAY_IDLE_MS`, `BROWSER_USE_AVAILABLE_BACKENDS`.

How it works on both platforms: [docs/how-it-works.md](docs/how-it-works.md).

## Disclaimer

sidehand is an independent project, not affiliated with or endorsed by OpenAI. It contains no OpenAI
code: Codex and its Computer Use component belong to OpenAI and are used from your own installation,
under OpenAI's terms. Use at your own risk.

## License

[MIT](LICENSE)

# How sidehand works

# macOS

## The pieces

```
MCP client (Claude Code, Claude Desktop, OpenCode, Hermes, Pi, ...)
   │ stdio
   ▼
mac/mac-computer-use            sidehand's proxy (Python)
   │  answers Codex's per-app approval prompts, replaces its instructions,
   │  turns analytics off, installs the background fallback into the snapshot
   ▼
cua-repl                        Codex's MCP server (Node), frozen copy in ~/.local/share/mac-computer-use
   │  `js` tool → node_repl (sandboxed) → trusted "sky" service
   │                                        └─ mac client, wrapped by mcu_fallback.js
   ▼
Codex Computer Use.app          OpenAI's native helper: accessibility tree, screenshots, input
   ▼
your apps   ◄── CGEventPostToPid ── MCU Input.app   (only when the helper can't reach the window)
```

Everything from `cua-repl` down to `Codex Computer Use.app` is OpenAI's and comes from your Codex
install. `mac-computer-use --snapshot` clones it (APFS clones, no extra disk) with a private
`CODEX_HOME`, so it needs no Codex login and Codex updates don't affect it.

## Why the agent failed behind full-screen apps

The helper performs coordinate input with the real cursor. When the target window isn't on the current
Space (a full-screen app is in front, or the window is on another desktop), it refuses coordinate
clicks, drags and **every** scroll, even scroll-by-element, with
`Computer Use server error -10005: noWindowsAvailable`.

Everything that doesn't need the cursor keeps working in the background: the accessibility tree,
screenshots (ScreenCaptureKit captures off-screen windows), element-index clicks, `typeText`,
`pressKey`, `setValue`, `selectText` and secondary actions.

## The fallback

`mac/input/mcu_fallback.js` wraps the sky mac client. The proxy copies it next to every
`targets/mac/create_client.js` in the snapshot and rewires that module's export, on every start and
after `--snapshot`. It only steps in on `noWindowsAvailable`, which the helper reports after its policy
check and app approval, so blocked apps stay blocked.

- **Scroll by element:** perform the element's accessibility action `Scroll Down` / `Up` / `Left` /
  `Right`, walking up to the nearest ancestor that exposes it.
- **Coordinate click / drag / scroll:** map the screenshot pixel to a global point (the screenshot is
  the window at its display's backing scale), then ask MCU Input to post the events to the app.
  Coordinate scrolls first try the accessibility page-scroll action under the point, then wheel events.

### Posting input to a background process

`CGEventPostToPid` delivers events straight to an app's queue, without moving the cursor or activating
the app. AppKit only accepts a posted mouse event when **CGEvent field 51** (the window number) is set
to the target window. The public "window under the mouse pointer" fields 91/92 alone are silently
dropped. MCU Input also sets the window-local location (`CGEventSetWindowLocation`). Verified on
Calculator (SwiftUI) and TextEdit: click, right-click, double-click, drag-select, wheel and
accessibility scroll.

### MCU Input

A small Swift app (`mac/input/main.swift`, `LSUIElement`), launched on demand and quitting after 15 idle
minutes. It serves one JSON request per connection on `~/.local/share/mac-computer-use-input/input.sock`
(mode 0600, 2-second read timeout), and only to clients whose executable lives in the snapshot's
`cua_node/bin/`. Operations:

| op | does |
|---|---|
| `ping` | version and whether it has the Accessibility permission |
| `windows` | the app's windows, including those on other Spaces (CoreGraphics window list) |
| `post` | mouse and scroll events with arbitrary integer fields, posted to the app's pid |
| `axAt` | accessibility hit test at a point, optionally performing an action |

Window choice, coordinate mapping and event sequences live in JavaScript, so the signed binary (and its
Accessibility grant) rarely needs to change. `build.sh` signs it with your Apple Development identity
when you have one, which keeps the grant across rebuilds.

### node_repl's sandbox

The JavaScript runs under an OS sandbox: there is no `process` global, connecting to a Unix socket fails
with `EPERM` and file writes are blocked. The trusted service reaches the helper through the host's
bridge, `nodeRepl.nativePipe.createConnection(path)`, whose `write()` only accepts bytes, and so does
the fallback.

## The 5-second wait

The helper has a user-interaction monitor: a click it didn't send (ours included; a mouse move alone
doesn't count) marks the app as touched by the user. For about 5 seconds after that, its next call on
that app waits, then demands a re-query (`The user changed '...'. Re-query the latest state`).
Spoofing the event's source pid or state id doesn't evade it. sidehand limits the cost:

- once an app is known to be off-screen, coordinate input skips the helper and goes straight to
  MCU Input (still through Codex's policy and approval check);
- a helper action refused that way right after our input re-reads the state once and retries, and the
  changes from that read are shown with the model's next state, so its diff stays complete.

The result is at most one wait per batch of actions, usually hidden by the model's thinking time.

# Windows

## The pieces

```
MCP client (Claude Code, Claude Desktop, OpenCode, Hermes, Pi, ...)
   │ stdio                                   │ stdio
   ▼                                         ▼
windows/computer-use/server.mjs          windows/browser/server.mjs
   │  MCP server (Node): typed tools,        │  proxy: injects Codex turn metadata,
   │  batch, approvals, turn handling        │  hides Codex-internal tools
   │ stdio, JSON lines                       ▼
   ▼                                     cua-repl (Codex's MCP server, browser surface only)
codex-computer-use.exe                       │  `js` tool → node_repl (sandboxed)
   │  OpenAI's native helper from @oai/sky:  ▼
   │  UI Automation, SendInput,           ChatGPT browser extension in Edge or Chrome
   │  Windows.Graphics.Capture
   ▼
your apps
```

Everything below sidehand's two scripts is OpenAI's and comes from your Codex install.
`install.ps1` copies Codex's Computer Use runtime
(`%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\bin`: Node, `node_repl.exe`, `@oai/sky`,
`@oai/cua-repl`, `@oai/browser-desktop`) and the Codex CLI (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>`)
into `%LOCALAPPDATA%\sidehand`, so Codex updates don't affect it. The servers run on the frozen
runtime's own `node.exe`.

## Talking to the helper directly

On macOS sidehand keeps Codex's JavaScript REPL in the middle. On Windows the server spawns
`codex-computer-use.exe --parent-pid <pid>` and speaks its own protocol, one JSON object per line:

```
-> {"id":1,"method":"list_windows","params":{},"meta":{"session_id":"…","turn_id":"…","x-oai-cua-request-budget-ms":10000}}
<- {"id":1,"ok":true,"result":[…]}
<- {"id":2,"ok":false,"approvalRequest":{"app":"notepad.exe","displayName":"Notepad",…}}
```

An `approvalRequest` is answered by sending the same request again with
`meta["x-oai-cua-approved-app"]`. sidehand does that when the app is allowed by `config.json`
(`"*"` allows all) or when the user accepts an MCP elicitation prompt; "always allow" answers are
saved to the config. The request is only re-sent after the helper's own policy check, so apps Codex
blocks stay blocked.

The helper reads its configuration and your sign-in through `codex app-server`, which is why the Codex
CLI is frozen alongside the runtime and `CODEX_HOME` (`~/.codex`) must be the one Codex uses.

## Where the time goes

Measured on a desktop PC: clicks, keys and typing take 20 to 70 ms in the helper; the first screenshot
of a window about 350 ms, later ones 20 to 50 ms; starting the helper about 400 ms. A model round trip
takes seconds, so the number of tool calls decides the speed of a task.

`batch` takes one window and a list of actions (`click`, `type_text`, `press_key`, `scroll`, `drag`,
`set_value`, `perform_secondary_action`, `activate_window`, `wait`), runs them in order through the
same code as the single tools, and ends with an observation (`none`, `screenshot`, `text` or `both`).
It stops at the first failure, reports which step failed and still observes, so the model can recover
from the real state. Element indexes and coordinates must come from the observation before the batch,
so it suits steps whose outcome is predictable: focus a field, type, confirm, wait for the UI.

## Turns and the overlay

Codex groups tool calls into turns (`session_id`, `turn_id` in every request). The helper shows an
"is using your computer" overlay while a turn is active and hides it on `end_turn`, which the Codex app
sends when the model finishes answering. MCP has no turn boundary, so sidehand:

- sends `end_turn` after 5 seconds without calls (`SIDEHAND_OVERLAY_IDLE_MS`) and when the client
  closes stdin, so the overlay doesn't linger;
- starts a new turn after 60 seconds of inactivity (`SIDEHAND_TURN_IDLE_MS`);
- when the user presses the physical Escape key, the helper stops the turn; sidehand refuses further
  calls in that turn and tells the model to stop.

## The browser proxy

`cua-repl` is the MCP server the Codex app uses for browser control. It refuses calls that don't carry
Codex turn metadata (`_meta["x-codex-turn-metadata"]` with `session_id` and `turn_id`), which only the
Codex app sends. `windows/browser/server.mjs` launches it from the frozen runtime with only the browser
surface enabled, adds that metadata to every `tools/call`, hides Codex-internal tools, marks `js` as
non-read-only, and drops a result field that duplicates every screenshot as base64. The JavaScript
still runs in Codex's Windows sandbox, and the browser backend is the ChatGPT extension in Edge or
Chrome with its native messaging host, both set up by Codex.

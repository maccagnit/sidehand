# How sidehand works

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

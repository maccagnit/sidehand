#!/usr/bin/env node
// windows-browser: sidehand's stdio proxy in front of Codex's `cua_repl` (browser surface only).
//
// cua_repl is the MCP server the Codex desktop app uses for browser control. It refuses
// to work unless every tools/call carries Codex turn metadata (session_id / turn_id),
// which only the Codex app sends. This proxy launches cua_repl from the runtime frozen by
// install.ps1 and injects that metadata, so any MCP client can drive it.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SIDEHAND_HOME =
  process.env.SIDEHAND_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "sidehand");
const RUNTIME = process.env.SIDEHAND_RUNTIME ?? path.join(SIDEHAND_HOME, "runtime");
const CODEX_CLI = process.env.SIDEHAND_CODEX_CLI ?? path.join(SIDEHAND_HOME, "codex-cli", "codex.exe");
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const NODE = path.join(RUNTIME, "node.exe");
const MODULES = path.join(RUNTIME, "node_modules");
// A new "turn" starts after this much idle time. Codex scopes interrupts to a turn.
const TURN_IDLE_MS = Number(process.env.SIDEHAND_TURN_IDLE_MS ?? 120_000);
const HIDDEN_TOOLS = new Set(["turn_ended", "js_add_node_module_dir"]);

for (const required of [NODE, path.join(RUNTIME, "node_repl.exe"), CODEX_CLI]) {
  if (!existsSync(required)) {
    console.error(`windows-browser: missing ${required}: run windows\\install.ps1 from the sidehand repo first`);
    process.exit(1);
  }
}

const child = spawn(NODE, [path.join(MODULES, "@oai", "cua-repl", "bin", "cua-repl.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
  env: {
    ...process.env,
    CODEX_HOME,
    CODEX_CLI_PATH: CODEX_CLI,
    CUA_REPL_NODE_REPL_PATH: path.join(RUNTIME, "node_repl.exe"),
    CUA_REPL_ENABLED_SURFACES: "browser",
    NODE_REPL_NODE_PATH: NODE,
    NODE_REPL_NODE_MODULE_DIRS: MODULES,
    NODE_REPL_TRUSTED_CODE_PATHS: [CODEX_HOME, MODULES].join(";"),
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: "@oai/browser-desktop/service" }),
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    // "iab" is the browser embedded in the Codex app; only the extension backend works standalone.
    BROWSER_USE_AVAILABLE_BACKENDS: process.env.BROWSER_USE_AVAILABLE_BACKENDS ?? "chrome",
    BROWSER_USE_TINYSKY_ENABLED: "1",
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
    BROWSER_USE_CODEX_APP_VERSION: process.env.BROWSER_USE_CODEX_APP_VERSION ?? "26.924.51851",
  },
});

const sessionId = `claude-${randomUUID()}`;
let turnId = randomUUID();
let lastCallAt = 0;
const toolListIds = new Set();

function turnMetadata() {
  const now = Date.now();
  if (lastCallAt !== 0 && now - lastCallAt > TURN_IDLE_MS) turnId = randomUUID();
  lastCallAt = now;
  return { session_id: sessionId, turn_id: turnId };
}

function fromClient(message) {
  if (message.method === "tools/list" && message.id != null) toolListIds.add(message.id);
  if (message.method === "tools/call" && message.params != null) {
    const meta = { ...(message.params._meta ?? {}) };
    meta["x-codex-turn-metadata"] = { ...turnMetadata(), ...(meta["x-codex-turn-metadata"] ?? {}) };
    message.params._meta = meta;
  }
  return message;
}

function fromServer(message) {
  if (message.id != null && toolListIds.delete(message.id) && Array.isArray(message.result?.tools)) {
    message.result.tools = message.result.tools
      .filter((tool) => !HIDDEN_TOOLS.has(tool.name))
      .map((tool) =>
        // cua_repl marks `js` read-only, but it drives a real browser.
        tool.name === "js"
          ? { ...tool, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }
          : tool,
      );
  }
  // Codex-only result metadata duplicates every screenshot as base64; drop it.
  if (Array.isArray(message.result?.content)) delete message.result._meta;
  if (message.result?.serverInfo != null) {
    message.result.serverInfo = { name: "windows-browser", version: "1.0.0" };
  }
  return message;
}

function pump(source, sink, rewrite) {
  let buffer = "";
  source.setEncoding("utf8");
  source.on("data", (chunk) => {
    buffer += chunk;
    for (let newline; (newline = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let out = line;
      try {
        out = JSON.stringify(rewrite(JSON.parse(line)));
      } catch {
        // Not JSON: forward untouched.
      }
      sink.write(`${out}\n`);
    }
  });
}

pump(process.stdin, child.stdin, fromClient);
pump(child.stdout, process.stdout, fromServer);

process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill());

#!/usr/bin/env node
// sidehand installer for Windows (run it through install.ps1). Freezes Codex's Computer Use
// runtime and CLI from your Codex install into %LOCALAPPDATA%\sidehand and writes the default
// config. Safe to re-run; with --snapshot it re-freezes from a newer Codex (previous copy kept in .prev).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const HOME = process.env.SIDEHAND_HOME ?? path.join(LOCAL, "sidehand");
const CODEX = path.join(LOCAL, "OpenAI", "Codex");
const HELPER = path.join("node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
const resnapshot = process.argv.includes("--snapshot");

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Codex keeps each runtime in a hash-named folder; take the most recent one that has `probe`.
function newest(parent, probe) {
  if (!existsSync(parent)) return null;
  return (
    readdirSync(parent)
      .map((name) => path.join(parent, name))
      .filter((dir) => existsSync(path.join(dir, probe)))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

function freeze(source, name) {
  const target = path.join(HOME, name);
  const staging = `${target}.new`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  try {
    if (existsSync(target)) {
      rmSync(`${target}.prev`, { recursive: true, force: true });
      renameSync(target, `${target}.prev`);
    }
    renameSync(staging, target);
  } catch (error) {
    fail(`could not replace ${target} (${error.code}): quit the MCP clients that use sidehand, then re-run.`);
  }
  console.log(`froze ${source} -> ${target}`);
}

if (process.platform !== "win32") fail("This installer is for Windows (the macOS version is install.sh at the repo root).");

const runtimeSource = newest(path.join(CODEX, "runtimes", "cua_node"), path.join("bin", HELPER));
const cliSource = newest(path.join(CODEX, "bin"), "codex.exe");
if (runtimeSource == null || cliSource == null) {
  fail("Codex's Computer Use runtime was not found. Install the Codex app, sign in and use Computer Use once (see README).");
}

mkdirSync(HOME, { recursive: true });
if (resnapshot || !existsSync(path.join(HOME, "runtime", HELPER))) {
  freeze(path.join(runtimeSource, "bin"), "runtime");
  freeze(cliSource, "codex-cli");
  const sky = JSON.parse(readFileSync(path.join(HOME, "runtime", "node_modules", "@oai", "sky", "package.json"), "utf8"));
  writeFileSync(
    path.join(HOME, "snapshot.json"),
    `${JSON.stringify({ frozenAt: new Date().toISOString(), runtime: runtimeSource, cli: cliSource, sky: sky.version }, null, 2)}\n`,
  );
} else {
  console.log("Codex runtime already frozen (re-freeze with: install.ps1 --snapshot)");
}

const configPath = path.join(HOME, "config.json");
if (!existsSync(configPath)) {
  // Like the macOS version, approve Codex's per-app prompts automatically. Use [] to be asked per app.
  writeFileSync(configPath, `${JSON.stringify({ allowedApps: ["*"] }, null, 2)}\n`);
  console.log(`wrote ${configPath}`);
}

const node = path.join(HOME, "runtime", "node.exe");
const computerUse = path.join(REPO, "windows", "computer-use", "server.mjs");
const browser = path.join(REPO, "windows", "browser", "server.mjs");
console.log(`
Done. Add the servers to your MCP client, e.g. Claude Code:
  claude mcp add --scope user windows-computer-use -- "${node}" "${computerUse}"
  claude mcp add --scope user windows-browser -- "${node}" "${browser}"
`);

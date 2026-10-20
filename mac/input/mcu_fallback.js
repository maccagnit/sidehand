// mac-computer-use background fallbacks.
//
// Installed by ~/.local/bin/mac-computer-use into the frozen Codex runtime, next to every
// targets/mac/create_client.js, which is patched to wrap its client with wrapClient().
//
// Codex's helper drives the real cursor, so coordinate clicks, drags and every scroll fail
// with "noWindowsAvailable" when the target window is not on the current Space (the user has
// a full-screen app in front, or is on another desktop). Only then do we step in:
//   - scroll by element: the element's own accessibility scroll action ("Scroll Down", ...),
//     which needs no extra permission.
//   - coordinate click / drag / scroll: "MCU Input", a tiny helper that posts mouse events
//     straight to the target process, so the user's Space, cursor and focus stay put.
// Every fallback runs after Codex's own policy check and app approval, so blocked apps stay blocked.
//
// Codex's helper treats input it didn't send as the user touching the app: for ~5 s afterwards
// its next call on that app waits, then demands a re-query ("The user changed ..."). So once an
// app is known to be off-screen, coordinate input skips the helper entirely, and a helper action
// refused that way right after our input re-reads the state once and retries.
import { Buffer } from "node:buffer";
import fs from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withComputerUsePolicy } from "./computer-use-policy.js";

const DIR = `${homedir()}/.local/share/mac-computer-use-input`; // node_repl has no `process` global
const SOCK = `${DIR}/input.sock`;
const APP = `${DIR}/MCU Input.app`;
const OFFSCREEN = "Computer Use server error -10005: noWindowsAvailable";
const OFFSCREEN_HINT =
  "The window is not on the current Space (the user likely has a full-screen app in front or is on another desktop), " +
  "so the real mouse can't reach it. Element-index clicks, setValue, selectText, performSecondaryAction, typeText, " +
  "pressKey and screenshots still work in the background.";
const BACKGROUND_TTL = 60000; // how long an app stays known as off-screen / recently touched by us
const SCROLL_ACTIONS = { up: "Scroll Up", down: "Scroll Down", left: "Scroll Left", right: "Scroll Right" };
const BUTTONS = { left: "left", l: "left", 0: "left", right: "right", r: "right", 1: "right", middle: "other", m: "other", 2: "other" };

const shots = new Map(); // app -> {w, h} of its latest screenshot, to map screenshot pixels to points
const offscreen = new Map(); // app -> when the helper last reported its window off-screen
const touched = new Map(); // app -> when we last sent it background input
const pending = new Map(); // app -> state diffs we read on the model's behalf, shown with its next state
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recent = (map, app) => Date.now() - (map.get(app) ?? 0) < BACKGROUND_TTL;
const isOffscreen = (e) => String(e?.message ?? e).includes("noWindowsAvailable");

function hint(original, detail) {
  const e = new Error(`${original.message}. ${OFFSCREEN_HINT}${detail ? ` ${detail}` : ""}`);
  e.code = original.code;
  return e;
}

function remember(app, state) {
  try {
    const url = state?.screenshot?.url;
    if (!url?.startsWith("file:")) return;
    const fd = fs.openSync(fileURLToPath(url), "r");
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    if (head.readUInt32BE(0) === 0x89504e47) shots.set(app, { w: head.readUInt32BE(16), h: head.readUInt32BE(20) });
  } catch {}
}

function connect() {
  // node_repl's OS sandbox blocks socket connects (EPERM); its host bridges them, as for Codex's own helper
  const pipe = globalThis.nodeRepl?.nativePipe;
  if (typeof pipe?.createConnection === "function") return pipe.createConnection(SOCK);
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function rpc(req) {
  const s = await connect();
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { s.end(); reject(new Error("MCU Input timed out")); }, 10000);
    s.on("data", (d) => {
      buf += Buffer.from(d).toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      s.end();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
    s.write(Buffer.from(JSON.stringify(req) + "\n")); // the native pipe only takes bytes
  });
}

// Ask MCU Input, launching it on first use (it exits by itself after 15 idle minutes).
async function helper(req, original) {
  let res;
  try {
    res = await rpc(req);
  } catch (e) {
    if (!fs.existsSync(APP)) throw hint(original, "(Background mouse input is unavailable: MCU Input is not installed.)");
    let last = e;
    spawn("/usr/bin/open", ["-g", "-j", APP], { stdio: "ignore", detached: true }).unref();
    for (let i = 0; i < 60 && res == null; i++) {
      await sleep(50);
      res = await rpc(req).catch((e) => { last = e; return null; });
    }
    if (res == null) throw hint(original, `(MCU Input is not reachable: ${last?.message ?? last})`);
  }
  if (!res.ok) throw hint(original, `(Background mouse input failed: ${res.error})`);
  return res;
}

// Map screenshot pixel coordinates to global and window-local points.
async function locate(app, x, y, original) {
  const { windows } = await helper({ op: "windows", app }, original);
  const wins = windows.filter((w) => w.w > 1 && w.h > 50 && w.alpha > 0);
  const shot = shots.get(app);
  const fits = (w) => shot && Math.abs(w.w * w.scale - shot.w) <= 4 && Math.abs(w.h * w.scale - shot.h) <= 4;
  const win = wins.find(fits) ?? wins[0];
  if (win == null) throw hint(original, "(No window found for background input.)");
  if (win.onscreen) offscreen.delete(app); // back on the user's Space: the helper can drive it again
  else offscreen.set(app, Date.now());
  const scale = fits(win) ? shot.w / win.w : win.scale;
  const lx = x / scale, ly = y / scale;
  return { id: win.id, x: win.x + lx, y: win.y + ly, lx, ly, h: win.h };
}

// AppKit routes a posted event by its window number (field 51); 91/92 are the public
// "window under the mouse" fields. Without 51 the target app silently drops the event.
const windowFields = (id) => ({ 51: id, 91: id, 92: id });

function mouse(kind, at, extra = {}) {
  return { kind, x: at.x, y: at.y, windowLocal: [at.lx, at.ly], fields: { ...windowFields(at.id), ...extra.fields }, delayMs: extra.delayMs };
}

async function post(a, events, original) {
  await helper({ op: "post", app: a.app, events }, original);
  touched.set(a.app, Date.now());
}

async function backgroundClick(c, a, original) {
  const at = await locate(a.app, a.x, a.y, original);
  const button = BUTTONS[String(a.mouse_button ?? "left").toLowerCase()] ?? "left";
  const events = [mouse("move", at, { delayMs: 10 })];
  for (let n = 1; n <= (a.click_count ?? 1); n++) {
    events.push(mouse(`${button}Down`, at, { fields: { 1: n }, delayMs: 30 }), mouse(`${button}Up`, at, { fields: { 1: n }, delayMs: 30 }));
  }
  await post(a, events, original);
}

async function backgroundDrag(c, a, original) {
  const from = await locate(a.app, a.from_x, a.from_y, original);
  const to = await locate(a.app, a.to_x, a.to_y, original);
  const steps = 12;
  const events = [mouse("move", from, { delayMs: 10 }), mouse("leftDown", from, { fields: { 1: 1 }, delayMs: 40 })];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, lerp = (k) => from[k] + (to[k] - from[k]) * t;
    events.push(mouse("leftDrag", { id: from.id, x: lerp("x"), y: lerp("y"), lx: lerp("lx"), ly: lerp("ly") }, { fields: { 1: 1 }, delayMs: 15 }));
  }
  events.push(mouse("leftUp", to, { fields: { 1: 1 } }));
  await post(a, events, original);
}

// The element itself or its nearest ancestor exposing the scroll action, from a fresh full tree.
async function scrollableAncestor(c, app, index, action) {
  const text = (await c.get_app_state({ app, disableDiff: true })).text;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\t*${index} `).test(l));
  if (at < 0) return null;
  let depth = lines[at].match(/^\t*/)[0].length;
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    const d = lines[i].match(/^\t*/)[0].length;
    if (d >= depth) continue;
    depth = d;
    if (lines[i].includes(action)) return Number(lines[i].trim().split(" ")[0]);
  }
  return null;
}

async function backgroundScroll(c, a, original) {
  const dir = { u: "up", d: "down", l: "left", r: "right" }[a.direction?.[0]?.toLowerCase()] ?? "down";
  const pages = Math.max(1, Math.ceil(a.pages ?? 1));
  if (a.element_index != null) {
    const action = SCROLL_ACTIONS[dir];
    let target = a.element_index;
    for (let i = 0; i < pages; i++) {
      try {
        await act(c, "perform_secondary_action", { app: a.app, element_index: target, action });
      } catch (e) {
        if (i > 0 || !/not a valid secondary action/.test(e.message)) throw hint(original, `(Accessibility scroll failed: ${e.message})`);
        target = await scrollableAncestor(c, a.app, a.element_index, action);
        if (target == null) throw hint(original, `(Neither element ${a.element_index} nor its ancestors expose "${action}".)`);
        i--;
      }
    }
    return;
  }
  const at = await locate(a.app, a.x, a.y, original);
  // Prefer the accessibility page scroll under the point: it reports failure, wheel events don't.
  const axAction = `AXScroll${dir[0].toUpperCase()}${dir.slice(1)}ByPage`;
  const ax = await rpc({ op: "axAt", app: a.app, x: at.x, y: at.y, perform: axAction }).catch(() => null);
  if (ax?.ok) {
    for (let i = 1; i < pages; i++) await rpc({ op: "axAt", app: a.app, x: at.x, y: at.y, perform: axAction });
    touched.set(a.app, Date.now());
    return;
  }
  const total = Math.round(at.h * 0.8 * pages), step = 120, events = [mouse("move", at, { delayMs: 10 })];
  for (let done = 0; done < total; done += step) {
    const px = Math.min(step, total - done);
    const dy = dir === "up" ? px : dir === "down" ? -px : 0, dx = dir === "left" ? px : dir === "right" ? -px : 0;
    events.push({ kind: "scroll", x: at.x, y: at.y, windowLocal: [at.lx, at.ly], dy, dx, fields: windowFields(at.id), delayMs: 8 });
  }
  await post(a, events, original);
}

// A helper action; if the helper blames "the user" right after our own input, re-read the state
// (keeping its diff for the model's next get_app_state) and retry once.
async function act(c, name, a) {
  try {
    return await c[name](a);
  } catch (e) {
    if (!/The user changed/.test(e?.message) || !recent(touched, a.app)) throw e;
    const state = await c.get_app_state({ app: a.app });
    remember(a.app, state);
    pending.set(a.app, [pending.get(a.app), state.text].filter(Boolean).join("\n"));
    return c[name](a);
  }
}

const ACTIONS = ["click", "drag", "paste", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"];
const FALLBACKS = { click: backgroundClick, drag: backgroundDrag, scroll: backgroundScroll };
const usesCoordinates = (name, a) => name in FALLBACKS && (name === "drag" || a.element_index == null);

export function wrapClient(c) {
  const wrapped = Object.assign({}, c, {
    async get_app_state(a) {
      const state = await c.get_app_state(a);
      remember(a.app, state);
      const earlier = pending.get(a.app);
      pending.delete(a.app);
      return earlier && !a.disableDiff ? { ...state, text: `${earlier}\n${state.text}` } : state;
    },
  });
  for (const name of ACTIONS) {
    if (typeof c[name] !== "function") continue;
    const run = FALLBACKS[name];
    wrapped[name] = async (a) => {
      // Known off-screen: go straight to MCU Input (after the policy check), sparing the helper's wait.
      if (usesCoordinates(name, a) && recent(offscreen, a.app)) {
        return withComputerUsePolicy(name, a, () => run(c, a, new Error(OFFSCREEN)));
      }
      try {
        return await act(c, name, a);
      } catch (e) {
        if (run == null || !isOffscreen(e)) throw e;
        offscreen.set(a.app, Date.now());
        if (name !== "scroll" && a.element_index != null) throw hint(e);
        return run(c, a, e);
      }
    };
  }
  return wrapped;
}

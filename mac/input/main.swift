// MCU Input: background mouse input for mac-computer-use.
//
// Codex's helper moves the real cursor, so coordinate clicks/scrolls/drags fail with
// "noWindowsAvailable" when the target window isn't on the current Space (e.g. the user
// has a full-screen app in front). This helper posts mouse events straight to the target
// process instead, which leaves the user's Space, cursor and focus alone.
//
// It only exposes primitives over a Unix socket (one JSON request per connection); window
// selection, coordinate mapping and event sequences live in JS (mcu_fallback.js), so the
// signed binary — and its Accessibility grant — rarely needs to change.
import Cocoa
import ApplicationServices

let version = 2
let dir = NSHomeDirectory() + "/.local/share/mac-computer-use-input"
let sockPath = dir + "/input.sock"
// Only the frozen Codex runtime that mac-computer-use runs may use this socket.
let allowedClientDir = NSHomeDirectory() + "/.local/share/mac-computer-use/cua_node/bin/"
let idleExit: TimeInterval = 15 * 60
var lastRequest = Date()

typealias SetField = @convention(c) (CGEvent, UInt32, Int64) -> Void
typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
let handle = dlopen(nil, RTLD_NOW)
let setField = unsafeBitCast(dlsym(handle, "CGEventSetIntegerValueField"), to: SetField.self)
let setWindowLocation: SetWindowLocation? = dlsym(handle, "CGEventSetWindowLocation").map { unsafeBitCast($0, to: SetWindowLocation.self) }

func onMain<T>(_ f: () -> T) -> T { Thread.isMainThread ? f() : DispatchQueue.main.sync(execute: f) }

func resolvePid(_ app: String) -> pid_t? {
  if let pid = Int32(app) { return pid }
  let key = app.lowercased()
  return onMain {
    let apps = NSWorkspace.shared.runningApplications
    let match = apps.first { $0.bundleIdentifier?.lowercased() == key }
      ?? apps.first { $0.localizedName?.lowercased() == key }
      ?? apps.first { $0.bundleURL?.path.lowercased() == key }
      ?? apps.first { $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == key }
    return match?.processIdentifier
  }
}

func screenScale(_ r: CGRect) -> CGFloat {
  onMain {
    // CG window bounds are top-left based; NSScreen frames are bottom-left based.
    let mainH = NSScreen.screens.first?.frame.height ?? 0
    let flipped = CGRect(x: r.minX, y: mainH - r.maxY, width: r.width, height: r.height)
    let s = NSScreen.screens.max { $0.frame.intersection(flipped).area < $1.frame.intersection(flipped).area }
    return s?.backingScaleFactor ?? 2
  }
}

extension CGRect { var area: CGFloat { isNull ? 0 : width * height } }

func windows(_ pid: pid_t) -> [[String: Any]] {
  let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.compactMap { w in
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0 else { return nil }
    let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    return ["id": w[kCGWindowNumber as String] as? Int ?? 0, "title": w[kCGWindowName as String] as? String ?? "",
            "x": r.minX, "y": r.minY, "w": r.width, "h": r.height, "scale": screenScale(r),
            "onscreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false, "alpha": w[kCGWindowAlpha as String] as? Double ?? 1]
  }
}

let mouseTypes: [String: (CGEventType, CGMouseButton)] = [
  "move": (.mouseMoved, .left),
  "leftDown": (.leftMouseDown, .left), "leftUp": (.leftMouseUp, .left), "leftDrag": (.leftMouseDragged, .left),
  "rightDown": (.rightMouseDown, .right), "rightUp": (.rightMouseUp, .right), "rightDrag": (.rightMouseDragged, .right),
  "otherDown": (.otherMouseDown, .center), "otherUp": (.otherMouseUp, .center), "otherDrag": (.otherMouseDragged, .center),
]

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func post(_ pid: pid_t, _ events: [[String: Any]]) throws {
  let src = CGEventSource(stateID: .privateState)
  for e in events {
    let kind = e["kind"] as? String ?? ""
    let p = CGPoint(x: num(e["x"]) ?? 0, y: num(e["y"]) ?? 0)
    let ev: CGEvent?
    if let (type, button) = mouseTypes[kind] {
      ev = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    } else if kind == "scroll" {
      ev = CGEvent(scrollWheelEvent2Source: src, units: (e["units"] as? String) == "line" ? .line : .pixel, wheelCount: 2,
                   wheel1: Int32(num(e["dy"]) ?? 0), wheel2: Int32(num(e["dx"]) ?? 0), wheel3: 0)
      ev?.location = p
    } else {
      throw NSError(domain: "mcu", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown event kind \(kind)"])
    }
    guard let ev else { throw NSError(domain: "mcu", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create \(kind) event"]) }
    for (k, v) in e["fields"] as? [String: Any] ?? [:] {
      if let f = UInt32(k), let n = num(v) { setField(ev, f, Int64(n)) }
    }
    if let wl = e["windowLocal"] as? [Double], wl.count == 2 { setWindowLocation?(ev, CGPoint(x: wl[0], y: wl[1])) }
    if let flags = num(e["flags"]) { ev.flags = CGEventFlags(rawValue: UInt64(flags)) }
    ev.postToPid(pid)
    if let d = num(e["delayMs"]), d > 0 { usleep(useconds_t(d * 1000)) }
  }
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v as? String : nil
}

func axActions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(el, &names) == .success ? (names as? [String] ?? []) : []
}

// Hit-test the app's own UI at a global point; optionally perform an action on the
// element or its nearest ancestor that supports it.
func axAt(_ pid: pid_t, _ x: Double, _ y: Double, _ perform: String?) -> [String: Any] {
  var el: AXUIElement?
  let err = AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(x), Float(y), &el)
  guard err == .success, var cur = el else { return ["ok": false, "error": "AX hit test failed (\(err.rawValue))"] }
  let hit: [String: Any] = ["role": axString(cur, kAXRoleAttribute) ?? "", "title": axString(cur, kAXTitleAttribute) ?? "",
                            "description": axString(cur, kAXDescriptionAttribute) ?? "", "actions": axActions(cur)]
  guard let perform else { return ["ok": true, "hit": hit] }
  for _ in 0..<8 {
    if axActions(cur).contains(perform) {
      let r = AXUIElementPerformAction(cur, perform as CFString)
      return ["ok": r == .success, "hit": hit, "performedOn": axString(cur, kAXRoleAttribute) ?? "", "axError": r.rawValue]
    }
    var parent: CFTypeRef?
    guard AXUIElementCopyAttributeValue(cur, kAXParentAttribute as CFString, &parent) == .success, let p = parent else { break }
    cur = p as! AXUIElement
  }
  return ["ok": false, "hit": hit, "error": "no element at that point supports \(perform)"]
}

func handle(_ req: [String: Any]) -> [String: Any] {
  let op = req["op"] as? String ?? ""
  if op == "ping" { return ["ok": true, "version": version, "trusted": AXIsProcessTrusted(), "windowLocation": setWindowLocation != nil] }
  guard AXIsProcessTrusted() else {
    return ["ok": false, "error": "MCU Input has no Accessibility permission. Grant it in System Settings > Privacy & Security > Accessibility."]
  }
  guard let app = req["app"] as? String, let pid = resolvePid(app) else { return ["ok": false, "error": "app is not running"] }
  switch op {
  case "windows": return ["ok": true, "pid": pid, "windows": windows(pid)]
  case "post":
    do { try post(pid, req["events"] as? [[String: Any]] ?? []); return ["ok": true] }
    catch { return ["ok": false, "error": error.localizedDescription] }
  case "axAt": return axAt(pid, num(req["x"]) ?? 0, num(req["y"]) ?? 0, req["perform"] as? String)
  default: return ["ok": false, "error": "unknown op \(op)"]
  }
}

func peerPath(_ fd: Int32) -> String? {
  var pid: pid_t = 0
  var len = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 else { return nil }
  var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
}

func serve(_ c: Int32) {
  defer { close(c) }
  var data = Data()
  var chunk = [UInt8](repeating: 0, count: 65536)
  while !data.contains(10) {
    let n = read(c, &chunk, chunk.count)
    if n <= 0 { return }
    data.append(chunk, count: n)
  }
  var resp: [String: Any]
  if let path = peerPath(c), path.hasPrefix(allowedClientDir) {
    let line = data.prefix { $0 != 10 }
    if let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { resp = handle(req) }
    else { resp = ["ok": false, "error": "bad request"] }
  } else {
    resp = ["ok": false, "error": "client not allowed"]
  }
  var out = (try? JSONSerialization.data(withJSONObject: resp)) ?? Data("{\"ok\":false}".utf8)
  out.append(10)
  _ = out.withUnsafeBytes { write(c, $0.baseAddress, out.count) }
}

func listen() -> Int32 {
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    _ = sockPath.withCString { strncpy(raw.baseAddress!.assumingMemoryBound(to: CChar.self), $0, raw.count - 1) }
  }
  let size = socklen_t(MemoryLayout<sockaddr_un>.size)
  let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) } }
  if bound != 0 {
    // Socket file exists: exit if another instance answers, otherwise it's stale.
    let probe = socket(AF_UNIX, SOCK_STREAM, 0)
    let alive = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, size) } } == 0
    close(probe)
    if alive { exit(0) }
    unlink(sockPath)
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) } }
  }
  chmod(sockPath, 0o600)
  Foundation.listen(fd, 16)
  return fd
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
if !AXIsProcessTrusted() {
  _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
}
let server = listen()
Thread.detachNewThread {
  while true {
    let c = accept(server, nil, nil)
    if c < 0 { continue }
    // a client that connects but never sends a line must not block everyone else
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    lastRequest = Date()
    serve(c)
  }
}
Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
  if Date().timeIntervalSince(lastRequest) > idleExit { unlink(sockPath); exit(0) }
}
app.run()

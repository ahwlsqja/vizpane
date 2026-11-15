// viz-render: draws one Mermaid diagram to a PNG with an offscreen WKWebView, or reports the
// terminal's cell size. Built once by `vizpane renderer` (swiftc), run by the Claude Code mod.
//
//   viz-render <render.html> <source.mmd> <out.png> <dark|light>
//     prints {"ok":true,"width":<css px>,"height":<css px>} or {"ok":false,"error":"..."}
//   viz-render --cell [tty-path]
//     asks the terminal at tty-path (default: the nearest ancestor's) and prints
//     {"ok":true,"cellWidth":<points>,"cellAspect":<height/width>,"columns":N,"rows":N}
//     or {"ok":false,"error":"..."}
import AppKit
import Darwin
import WebKit

func finish(_ json: String, _ code: Int32) -> Never { print(json); exit(code) }

func jsonString(_ s: String) -> String {
  let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
  let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
  return String(text.dropFirst().dropLast())
}
func failure(_ message: String) -> String { "{\"ok\":false,\"error\":\(jsonString(message))}" }

// MARK: --cell

// The mod's process has no terminal of its own, so the nearest ancestor that has one is asked.
func controllingTTY() -> String? {
  var pid = getppid()
  for _ in 0..<12 where pid > 1 {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-o", "ppid=,tty=", "-p", String(pid)]
    let pipe = Pipe()
    ps.standardOutput = pipe
    ps.standardError = FileHandle.nullDevice
    guard (try? ps.run()) != nil else { return nil }
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    ps.waitUntilExit()
    let parts = out.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
    guard parts.count >= 1, let parent = Int32(parts[0]) else { return nil }
    if parts.count >= 2, parts[1] != "??", parts[1] != "-" { return parts[1] }
    pid = parent
  }
  return nil
}

// A given path (the Codex hook passes the pane's terminal) is used as it is. It is opened only
// to read the window size: read-only, without becoming a controlling terminal.
func cellMode(_ given: String?) -> Never {
  guard let path = given ?? controllingTTY().map({ "/dev/\($0)" }) else { finish(failure("no controlling terminal"), 1) }
  let fd = open(path, O_RDONLY | O_NONBLOCK | O_NOCTTY)
  guard fd >= 0 else { finish(failure("cannot open terminal"), 1) }
  defer { close(fd) }
  guard isatty(fd) == 1 else { finish(failure("not a terminal"), 1) }
  var size = winsize()
  guard ioctl(fd, TIOCGWINSZ, &size) == 0 else { finish(failure("cannot read terminal size"), 1) }
  guard size.ws_col > 0, size.ws_row > 0, size.ws_xpixel > 0, size.ws_ypixel > 0 else {
    finish(failure("terminal does not report pixel size"), 1)
  }
  let scale = Double(NSScreen.main?.backingScaleFactor ?? 2)
  let cellW = Double(size.ws_xpixel) / Double(size.ws_col)
  let cellH = Double(size.ws_ypixel) / Double(size.ws_row)
  finish("{\"ok\":true,\"cellWidth\":\(cellW / scale),\"cellAspect\":\(cellH / cellW),\"columns\":\(size.ws_col),\"rows\":\(size.ws_row)}", 0)
}

// MARK: render

// Diagram source is untrusted: no network load of any kind, whatever the diagram asks for.
// WebKit's url-filter has no alternation, so each scheme pair is its own rule.
let blockNetwork = "[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}},"
  + "{\"trigger\":{\"url-filter\":\"^wss?://\"},\"action\":{\"type\":\"block\"}}]"

// The compiled list is kept in WebKit's per-user store. Several renders start at once (one per
// diagram of a reply), and compiling the same list from several processes at the same moment
// fails now and then. So: use the stored list when there is one, compile only when there is
// not, and try again a few times. The name carries a hash of the rules, so a build with other
// rules never picks up this list.
func stableHash(_ text: String) -> String {
  var h: UInt64 = 0xcbf29ce484222325
  for byte in text.utf8 { h = (h ^ UInt64(byte)) &* 0x100000001b3 }
  return String(h, radix: 16)
}
let ruleListName = "viz-no-network-" + stableHash(blockNetwork)

func withBlockList(attempt: Int = 0, _ use: @escaping (WKContentRuleList) -> Void) {
  guard let store = WKContentRuleListStore.default() else { finish(failure("cannot block network: no rule store"), 1) }
  store.lookUpContentRuleList(forIdentifier: ruleListName) { stored, _ in
    if let stored = stored { use(stored); return }
    store.compileContentRuleList(forIdentifier: ruleListName, encodedContentRuleList: blockNetwork) { list, error in
      if let list = list { use(list); return }
      guard attempt < 5 else { finish(failure("cannot block network: \(error?.localizedDescription ?? "unknown")"), 1) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05 * Double(attempt + 1)) { withBlockList(attempt: attempt + 1, use) }
    }
  }
}

final class Renderer: NSObject, WKNavigationDelegate {
  let page: URL
  let source: String
  let outPath: String
  let scheme: String
  // PNG pixels per CSS pixel. A picture is never shown larger than its CSS size, so this is
  // all a 2x display can use; more only costs memory in the terminal.
  let scale: CGFloat = 2
  var web: WKWebView!
  var window: NSWindow!

  init(page: URL, source: String, outPath: String, scheme: String) {
    self.page = page; self.source = source; self.outPath = outPath; self.scheme = scheme
    super.init()
  }

  func start() {
    // No page is opened before the block list is in place.
    withBlockList { list in
      let cfg = WKWebViewConfiguration()
      cfg.userContentController.add(list)
      self.web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1200), configuration: cfg)
      self.web.setValue(false, forKey: "drawsBackground")
      // An offscreen window: WebKit lays out and paints only for a view that is in a window.
      self.window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1600, height: 1200),
                             styleMask: [.borderless], backing: .buffered, defer: false)
      self.window.isReleasedWhenClosed = false
      self.window.contentView = self.web
      self.web.navigationDelegate = self
      // render.html sits in <state root>/inline/ and loads ../vendor and ../viz-core.js.
      let root = self.page.deletingLastPathComponent().deletingLastPathComponent()
      self.web.loadFileURL(self.page, allowingReadAccessTo: root)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.callAsyncJavaScript("return await window.vizRender(src, scheme)", arguments: ["src": source, "scheme": scheme],
                                in: nil, in: .page) { result in
      guard case .success(let value) = result, let text = value as? String,
            let data = text.data(using: .utf8),
            let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        finish(failure("script failed"), 1)
      }
      guard (info["ok"] as? Bool) == true, let w = info["width"] as? Double, let h = info["height"] as? Double else {
        finish(text, 1)
      }
      let rect = NSRect(x: 0, y: 0, width: w, height: h)
      webView.frame = rect
      self.window.setContentSize(rect.size)
      let snap = WKSnapshotConfiguration()
      snap.rect = rect
      // snapshotWidth is in points, and the snapshot has backingScaleFactor pixels per point.
      let backing = max(1, self.window.backingScaleFactor)
      snap.snapshotWidth = NSNumber(value: Double(w * Double(self.scale / backing)))
      // One runloop turn so the resized view has painted.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
        webView.takeSnapshot(with: snap) { image, error in
          guard let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:]) else {
            finish(failure("snapshot failed"), 1)
          }
          do { try png.write(to: URL(fileURLWithPath: self.outPath)) } catch { finish(failure("cannot write png"), 1) }
          finish(text, 0)
        }
      }
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    finish(failure("page failed to load"), 1)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    finish(failure("page failed to load"), 1)
  }
}

let args = CommandLine.arguments
if args.count >= 2 && args.count <= 3 && args[1] == "--cell" { cellMode(args.count == 3 ? args[2] : nil) }
guard args.count == 5 else {
  finish(failure("usage: viz-render <render.html> <source.mmd> <out.png> <dark|light> | viz-render --cell [tty-path]"), 2)
}
guard let source = try? String(contentsOfFile: args[2], encoding: .utf8) else { finish(failure("cannot read source"), 1) }

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)   // no Dock icon, never takes focus
let renderer = Renderer(page: URL(fileURLWithPath: args[1]), source: source, outPath: args[3], scheme: args[4] == "light" ? "light" : "dark")
renderer.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { finish(failure("timeout"), 1) }
app.run()

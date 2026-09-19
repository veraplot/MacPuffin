// MacPuffin.app — a thin native shell around the local MacPuffin server.
//
// It boots `node server.js` from the bundle's Resources, waits for the port to
// answer, and shows the UI in a WKWebView. Quitting the app stops the server.

import Cocoa
import WebKit

let defaultPort = 4780

/// The only host this app ever contacts besides 127.0.0.1. Public, unauthenticated,
/// and read-only: the latest release of the project's own repository.
let releaseAPI = "https://api.github.com/repos/veraplot/MacPuffin/releases/latest"

// MARK: - Locating node

/// CPU types this Mach-O binary contains, read straight from its header.
///
/// Apple is winding down Intel support, and an Intel-only helper would make the
/// whole app an "Intel-based app" in the system's eyes even though our own
/// binary is universal. Reading the header needs no Xcode tools, which `lipo`
/// and `file` would.
func machoArchitectures(of path: String) -> Set<UInt32> {
    guard let handle = FileHandle(forReadingAtPath: path),
          let head = try? handle.read(upToCount: 4096) else { return [] }
    defer { try? handle.close() }
    guard head.count >= 8 else { return [] }

    func be32(_ o: Int) -> UInt32 {
        UInt32(head[o]) << 24 | UInt32(head[o + 1]) << 16 | UInt32(head[o + 2]) << 8 | UInt32(head[o + 3])
    }
    func le32(_ o: Int) -> UInt32 {
        UInt32(head[o + 3]) << 24 | UInt32(head[o + 2]) << 16 | UInt32(head[o + 1]) << 8 | UInt32(head[o])
    }

    let magic = be32(0)
    // Universal binary: a big-endian table of (cputype, …) entries.
    if magic == 0xCAFE_BABE || magic == 0xCAFE_BABF {
        let count = Int(be32(4))
        var archs = Set<UInt32>()
        let stride = magic == 0xCAFE_BABE ? 20 : 32
        for i in 0..<min(count, 16) {
            let offset = 8 + i * stride
            if offset + 4 <= head.count { archs.insert(be32(offset)) }
        }
        return archs
    }
    // Thin binary: cputype follows the magic, in the file's own endianness.
    if magic == 0xFEED_FACF || magic == 0xFEED_FACE { return [be32(4)] }
    if le32(0) == 0xFEED_FACF || le32(0) == 0xFEED_FACE { return [le32(4)] }
    return []
}

let CPU_ARM64: UInt32 = 0x0100_000C
let CPU_X86_64: UInt32 = 0x0100_0007

/// The architecture this app is executing as.
var hostArchitecture: UInt32 {
    #if arch(arm64)
    return CPU_ARM64
    #else
    return CPU_X86_64
    #endif
}

/// Every node we can find, native builds first.
///
/// On an Apple Silicon Mac with both an Intel Homebrew (/usr/local) and a
/// native one (/opt/homebrew), picking the Intel binary would run the server
/// under Rosetta — slower, and squarely in the path of Apple's deprecation.
func findNode() -> String? {
    // The copy inside the bundle is the one this app was built and tested
    // against, and it is always the right architecture. Everything after it is
    // a fallback for running from a source checkout.
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("node").path,
       FileManager.default.isExecutableFile(atPath: bundled) {
        return bundled
    }

    var candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "\(NSHomeDirectory())/.volta/bin/node",
    ]

    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
    shell.arguments = ["-lc", "command -v node"]
    let pipe = Pipe()
    shell.standardOutput = pipe
    shell.standardError = Pipe()
    try? shell.run()
    shell.waitUntilExit()
    let fromShell = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !fromShell.isEmpty { candidates.append(fromShell) }

    let usable = candidates.filter { FileManager.default.isExecutableFile(atPath: $0) }
    // A binary with no readable header still counts: it may be a shim or a
    // script, and refusing to run it would be worse than running it.
    if let native = usable.first(where: {
        let archs = machoArchitectures(of: $0)
        return archs.isEmpty || archs.contains(hostArchitecture)
    }) {
        return native
    }
    return usable.first
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var port = defaultPort
    var updateChecked = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        start()
    }

    // MARK: Window

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1420, height: 940)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "MacPuffin"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0.047, green: 0.043, blue: 0.039, alpha: 1)
        window.minSize = NSSize(width: 1000, height: 680)
        window.center()
        window.setFrameAutosaveName("MacPuffinWindow")

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        if webView.responds(to: Selector(("setInspectable:"))) {
            webView.setValue(true, forKey: "inspectable")
        }

        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Server lifecycle

    private func start() {
        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("app") else {
            fail("The app bundle is missing its Resources/app folder.")
            return
        }

        // Try a small range: adopt our own server if one is already up, skip
        // past anything else holding a port, and start on the first free one.
        // Insisting on a single port means one stale process blocks the app.
        settle(from: defaultPort, attemptsLeft: 10, resources: resources)
    }

    private func settle(from candidate: Int, attemptsLeft: Int, resources: URL) {
        guard attemptsLeft > 0 else {
            // Every preferred port is busy. Rather than refuse to open, ask the
            // kernel for any free port at all — it will always have one, so
            // there is no arrangement of other software that can lock us out.
            guard let node = findNode() else {
                fail("The bundled Node runtime is missing.\n\nRe-downloading MacPuffin should fix it.")
                return
            }
            spawn(node: node, cwd: resources, port: 0)
            return
        }
        probe(port: candidate) { state in
            switch state {
            case .usable:
                self.port = candidate
                self.load()
            case .free:
                guard let node = findNode() else {
                    self.fail("The bundled Node runtime is missing and no system Node was found.\n\n"
                             + "Re-downloading MacPuffin should fix it.")
                    return
                }
                self.spawn(node: node, cwd: resources, port: candidate)
            case .occupied:
                // Something else owns this port — a stale instance, or an
                // unrelated program. Never adopt it; move along.
                self.settle(from: candidate + 1, attemptsLeft: attemptsLeft - 1, resources: resources)
            }
        }
    }

    /// Start the server. `port` of 0 means "any free port"; the server prints
    /// the one it received and that is read back here.
    private func spawn(node: String, cwd: URL, port requested: Int) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = ["server.js"]
        proc.currentDirectoryURL = cwd
        var env = ProcessInfo.processInfo.environment
        env["NO_OPEN"] = "1"
        env["PORT"] = String(requested)
        proc.environment = env

        // The pipe must be drained continuously: the server logs every action,
        // and a full pipe buffer would block it mid-scan.
        let output = Pipe()
        proc.standardOutput = output
        var announced = false
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty, !announced,
                  let text = String(data: chunk, encoding: .utf8) else { return }
            for line in text.split(separator: "\n") where line.hasPrefix("MACPUFFIN_PORT=") {
                let value = Int(line.dropFirst("MACPUFFIN_PORT=".count).trimmingCharacters(in: .whitespaces))
                if let value {
                    announced = true
                    DispatchQueue.main.async { self.port = value }
                }
            }
        }

        port = requested == 0 ? 0 : requested
        do {
            try proc.run()
        } catch {
            fail("Could not start the MacPuffin server.\n\n\(error.localizedDescription)")
            return
        }
        server = proc

        // Wait for the port, then show the UI. 20 s is generous: the server
        // only reads hardware facts before it listens.
        waitForServer(deadline: Date().addingTimeInterval(25)) { ready in
            if ready {
                self.load()
            } else {
                self.fail("The MacPuffin server did not start in time.\n\nCheck ~/Library/Logs/MacPuffin/macpuffin.log for details.")
            }
        }
    }

    /// What is on a port, from this app's point of view.
    enum PortState {
        case free          // nothing listening: we can start here
        case usable        // a MacPuffin of this version, serving properly
        case occupied      // something else, or a broken instance: leave it alone
    }

    /// Decide whether a port can be adopted.
    ///
    /// Answering `/api/hardware` is not enough. A previous instance whose bundle
    /// has since been replaced keeps answering that from memory while every file
    /// request fails, and adopting it shows the user a bare `not found`. So the
    /// version must match this build *and* the interface itself must load.
    private func probe(port: Int, completion: @escaping (PortState) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/hardware")!)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData

        URLSession.shared.dataTask(with: request) { data, response, error in
            let finish: (PortState) -> Void = { s in DispatchQueue.main.async { completion(s) } }

            if let error = error as NSError?,
               error.domain == NSURLErrorDomain,
               error.code == NSURLErrorCannotConnectToHost || error.code == NSURLErrorNetworkConnectionLost {
                return finish(.free)
            }
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let version = json["version"] as? String,
                  version == (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
            else { return finish(.occupied) }

            // It claims to be this build; confirm it can still serve the page.
            var page = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
            page.timeoutInterval = 1.5
            page.cachePolicy = .reloadIgnoringLocalCacheData
            URLSession.shared.dataTask(with: page) { _, pageResponse, _ in
                let ok = (pageResponse as? HTTPURLResponse)?.statusCode == 200
                finish(ok ? .usable : .occupied)
            }.resume()
        }.resume()
    }

    private func waitForServer(deadline: Date, completion: @escaping (Bool) -> Void) {
        // While the port is still 0 the server has not announced itself yet.
        guard port != 0 else {
            if Date() > deadline { return completion(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.waitForServer(deadline: deadline, completion: completion)
            }
            return
        }
        probe(port: port) { state in
            if state == .usable { return completion(true) }
            if Date() > deadline { return completion(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                self.waitForServer(deadline: deadline, completion: completion)
            }
        }
    }

    private func load() {
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "MacPuffin cannot start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: Web view policy

    /// Anything that is not our own localhost UI opens in the default browser.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.host == "127.0.0.1" || url.host == "localhost" || url.isFileURL {
            return decisionHandler(.allow)
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    /// WKWebView refuses `window.open` and `target="_blank"` unless the UI
    /// delegate answers this. Returning nil means "no new web view", and the
    /// link is handed to the default browser instead — which is what a link to
    /// GitHub should do from a local tool.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.host == "127.0.0.1" || url.host == "localhost" {
                webView.load(navigationAction.request)   // keep our own UI in this window
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    @objc func reload() { webView.reload() }

    // MARK: Update check

    /// Ask GitHub, once per launch, whether a newer release exists.
    ///
    /// Deliberately best-effort: no identifiers are sent, the request is
    /// anonymous, a short timeout applies, and every failure path — offline,
    /// DNS failure, rate limit, malformed JSON — is swallowed. The app is fully
    /// usable with no network at all; this only ever adds a dismissible banner.
    /// Set `defaults write local.macpuffin.app disableUpdateCheck -bool YES` to
    /// switch it off entirely.
    func checkForUpdate() {
        if UserDefaults.standard.bool(forKey: "disableUpdateCheck") { return }
        guard let url = URL(string: releaseAPI) else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("MacPuffin", forHTTPHeaderField: "User-Agent")

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 6
        config.timeoutIntervalForResource = 10
        config.httpCookieStorage = nil

        URLSession(configuration: config).dataTask(with: request) { data, _, _ in
            guard
                let data,
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let tag = json["tag_name"] as? String
            else { return }   // offline or unexpected payload: stay quiet

            let latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
            guard isNewer(latest, than: current) else { return }

            let page = (json["html_url"] as? String)
                ?? "https://github.com/veraplot/MacPuffin/releases/latest"
            DispatchQueue.main.async { self.announceUpdate(version: latest, page: page) }
        }.resume()
    }

    private func announceUpdate(version: String, page: String) {
        let payload: [String: String] = ["version": version, "url": page]
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else { return }
        // The page decides how to present it; the shell only delivers the fact.
        webView.evaluateJavaScript("window.macpuffinUpdate && window.macpuffinUpdate(\(json))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !updateChecked else { return }
        updateChecked = true
        checkForUpdate()
    }

    // MARK: Menu

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About MacPuffin", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide MacPuffin", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit MacPuffin", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

/// Numeric semver comparison: "1.10.0" is newer than "1.9.3".
func isNewer(_ candidate: String, than current: String) -> Bool {
    let a = candidate.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
    let b = current.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
    for i in 0..<max(a.count, b.count) {
        let x = i < a.count ? a[i] : 0
        let y = i < b.count ? b[i] : 0
        if x != y { return x > y }
    }
    return false
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

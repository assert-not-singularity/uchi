import QtQuick
import Quickshell
import Quickshell.Io

// Spawns or connects to the uchi core over its Unix socket and exposes cached
// connection state to `omarchy shell uchi ping`. Owns no ranking/grammar logic —
// see docs/design.md's "Architecture: core + wrappers".
Item {
  id: root

  visible: false
  width: 0
  height: 0

  property var shell: null
  property var manifest: null

  // Not manifest.__sourceDir: the host strips that field before injecting the
  // manifest into any third-party service instance (see shell.qml's
  // publicPluginManifest — only first-party plugins keep it), so it's always
  // empty here. Qt.resolvedUrl(".") resolves against this file's own location
  // instead, which the host can't strip.
  readonly property string pluginDir: {
    var dir = decodeURIComponent(String(Qt.resolvedUrl(".")).replace(/^file:\/\//, ""))
    return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir
  }

  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property bool runtimeDirMissing: root.runtimeDir === ""
  readonly property string socketPath: root.runtimeDir + "/uchi.sock"
  readonly property string lockPath: root.runtimeDir + "/uchi.lock"

  readonly property var activeSocket: socketLoader.item
  readonly property bool connected: !!(activeSocket && activeSocket.connected)
  property var handshakeOk: null
  property int nextId: 1
  property int helloRequestId: -1

  property int crashAttempts: 0
  property bool suppressSpawn: false
  property bool spawnScheduled: false
  property bool coreFailed: false

  // Omarchy's plugin installer runs no install hooks (no `npm install` on a
  // fresh git clone), so this checks for core/'s vendored-at-install-time
  // dependency once per load and installs it itself if missing — the same
  // lazy, first-run pattern quickshell.spotify's DaemonManager uses for its
  // own backend.
  property bool depsChecked: false
  property bool depsReady: false
  property bool installBusy: false

  Component.onCompleted: {
    if (root.runtimeDirMissing)
      console.error("uchi: XDG_RUNTIME_DIR is not set — cannot locate the core socket/lock")
  }

  // Takes the socket explicitly rather than reading root.activeSocket
  // (Loader.item): a freshly created Socket's connected:true can complete and
  // fire onConnectionStateChanged synchronously during its own construction,
  // before the Loader has finished assigning `item` to point at it — so
  // root.activeSocket can still read the old (torn-down) value at that exact
  // instant even though `this` inside the handler is already the right object.
  function sendHello(socket) {
    if (!socket || !socket.connected) return
    root.helloRequestId = root.nextId++
    var request = {
      id: root.helloRequestId,
      method: "hello",
      params: { client: "uchi-service", protocol: 1 }
    }
    socket.write(JSON.stringify(request) + "\n")
    socket.flush()
  }

  function handleLine(line) {
    var message = null
    try { message = JSON.parse(line) } catch (e) { return }
    if (!message || typeof message !== "object") return
    if ("event" in message) return
    if (message.id === root.helloRequestId) root.handshakeOk = !!message.result
  }

  function scheduleSpawn(delayMs) {
    root.spawnScheduled = true
    spawnTimer.interval = delayMs
    spawnTimer.restart()
  }

  function spawnCore() {
    if (root.runtimeDirMissing || coreProcess.running) return
    coreProcess.command = [
      "flock", "-n", "-E", "75", root.lockPath,
      "node", root.pluginDir + "/core/index.mjs"
    ]
    coreProcess.running = true
  }

  // The gate every spawn attempt goes through instead of calling spawnCore()
  // directly: checks once per load whether core/node_modules is present,
  // installs it via the vendored package.json/package-lock.json if not, and
  // only then spawns the actual core.
  function ensureDependencies() {
    if (root.runtimeDirMissing || coreProcess.running || root.installBusy || depsCheckProcess.running) return
    if (!root.depsChecked) {
      depsCheckProcess.command = ["test", "-e", root.pluginDir + "/core/node_modules/homey-api/package.json"]
      depsCheckProcess.running = true
      return
    }
    if (root.depsReady) {
      root.spawnCore()
      return
    }
    root.installBusy = true
    // Not `npm ci --prefix <dir>`: npm's own workspace-root detection under
    // --prefix gets confused when <dir> is reached through a symlink (exactly
    // how a locally-installed Omarchy plugin is laid out) and fails with a
    // spurious "Missing: core@ from lock file" EUSAGE error. Plain `cd` first
    // does not have this problem.
    installProcess.command = ["sh", "-c", "cd \"$1\" && exec npm ci --omit=dev", "sh", root.pluginDir + "/core"]
    installProcess.running = true
  }

  // flock releases its lock automatically on any exit, so an exit code alone
  // tells us who failed and how: 75 is flock itself refusing (someone else
  // already holds the lock, or the lock path is unusable); 78/69 are node's
  // own documented "not set up yet" / "Homey unreachable" codes; 0 is the
  // core's own clean idle-exit; anything else is a genuine crash.
  function handleCoreExit(exitCode) {
    var code = Number(exitCode)
    if (code === 75) {
      var reason = String(coreStderr.text || "").trim()
      if (reason) console.error("uchi: flock could not acquire the core lock: " + reason)
      // Someone else holds the lock right now, so don't spawn on every 2s
      // reconnectTimer tick — but that holder (including a core that idle-exits
      // cleanly) can disappear without us ever having connected to it, so still
      // retry a spawn on the same 30s cadence as the 78/69 paths rather than
      // suppressing forever.
      root.suppressSpawn = true
      scheduleSpawn(30000)
      return
    }
    if (code === 78 || code === 69) {
      root.crashAttempts = 0
      root.suppressSpawn = false
      scheduleSpawn(30000)
      return
    }
    if (code === 0) {
      root.crashAttempts = 0
      root.suppressSpawn = false
      return
    }
    root.crashAttempts += 1
    var crashReason = String(coreStderr.text || "").trim()
    console.error("uchi: core exited " + code + (crashReason ? (": " + crashReason) : "") + " (attempt " + root.crashAttempts + ")")
    if (root.crashAttempts > 5) {
      root.coreFailed = true
      console.error("uchi: core crashed repeatedly (exit " + code + ") — reload the plugin to retry")
      return
    }
    scheduleSpawn(Math.min(30000, 1000 * Math.pow(2, root.crashAttempts - 1)))
  }

  Component {
    id: socketComponent
    Socket {
      path: root.socketPath
      connected: true
      parser: SplitParser {
        splitMarker: "\n"
        onRead: function(line) { root.handleLine(line) }
      }
      onConnectionStateChanged: {
        if (connected) {
          root.suppressSpawn = false
          root.spawnScheduled = false
          root.crashAttempts = 0
          root.sendHello(this)
        } else {
          root.handshakeOk = null
        }
      }
    }
  }

  // A failed connect leaves Quickshell's Socket holding a dead QLocalSocket.
  // Setting connected=true again is a no-op, so each retry creates a new Socket.
  Loader {
    id: socketLoader
    active: !root.runtimeDirMissing
    sourceComponent: socketComponent
  }

  Timer {
    id: reconnectTimer
    interval: 2000
    repeat: true
    running: !root.runtimeDirMissing && !root.coreFailed
    triggeredOnStart: true
    onTriggered: {
      if (root.connected) return
      socketLoader.active = false
      socketLoader.active = true
      if (!root.suppressSpawn && !root.spawnScheduled) root.ensureDependencies()
    }
  }

  // 78/69 (settings not ready / Homey unreachable) and a genuine crash's
  // backoff both go through this timer alone — without spawnScheduled gating
  // reconnectTimer's own spawn attempt above, the intended 30s/backoff cadence
  // would collapse into a spawn/exit loop as tight as reconnectTimer's 2s tick.
  Timer {
    id: spawnTimer
    repeat: false
    onTriggered: {
      root.spawnScheduled = false
      if (!root.connected) root.ensureDependencies()
    }
  }

  Process {
    id: coreProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: false }
    stderr: StdioCollector { id: coreStderr; waitForEnd: true }
    onExited: function(exitCode) { root.handleCoreExit(exitCode) }
  }

  Process {
    id: depsCheckProcess
    running: false
    command: []
    onExited: function(exitCode) {
      root.depsChecked = true
      root.depsReady = Number(exitCode) === 0
      root.ensureDependencies()
    }
  }

  Process {
    id: installProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: false }
    stderr: StdioCollector { id: installStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root.installBusy = false
      if (Number(exitCode) === 0) {
        root.depsReady = true
        root.ensureDependencies()
        return
      }
      var reason = String(installStderr.text || "").trim()
      console.error("uchi: failed to install core dependencies (npm ci exited " + exitCode + ")" + (reason ? ": " + reason : ""))
      // Not a crash of our own code — retry on the same slow, indefinite
      // cadence as missing settings / unreachable Homey, not the bounded
      // crash backoff, since a transient network/npm hiccup shouldn't need a
      // manual reload to recover from.
      scheduleSpawn(30000)
    }
  }

  IpcHandler {
    target: "uchi"

    function ping(): string {
      if (root.connected && root.handshakeOk === true) return "ok"
      return "error: not connected to uchi core"
    }
  }
}

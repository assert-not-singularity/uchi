import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Services.Pipewire
import Quickshell.Services.Mpris

// Spawns or connects to the uchi core over its Unix socket, owns the live
// request/response + push-event connection `BarWidget.qml`/`Panel.qml` read
// from, and forwards desktop context (mic/idle/media/machineRoom) the core
// can't see on its own. Owns no ranking/grammar logic — see docs/design.md's
// "Architecture: core + wrappers".
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

  // id -> callback, for the generic request/response layer below. A plain
  // object rather than a Map: only ever mutated from within this file's own
  // functions, never bound to from QML, so no reactivity is needed.
  property var pendingRequests: ({})

  // The last state.get result — BarWidget.qml/Panel.qml's actual data
  // source. Refreshed once right after handshake and again on every
  // incoming state.changed push (see handleEvent below). Named coreState,
  // not state: QQuickItem already has a built-in `state` property (the QML
  // States system) that this would otherwise silently shadow.
  property var coreState: null

  // 78/69 remembered past the process exit that produced them, so
  // connectionStatus can still distinguish "never connected because not set
  // up" from "never connected because Homey's unreachable" while a later
  // reconnect attempt is in flight — connected/handshakeOk alone can't, since
  // all three states present as connected: false, handshakeOk: null.
  property int lastCoreExitCode: -1

  readonly property string connectionStatus: {
    if (root.connected && root.handshakeOk === true) return "connected"
    if (root.lastCoreExitCode === 78) return "not-set-up"
    if (root.lastCoreExitCode === 69) return "unreachable"
    return "connecting"
  }

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

  // Generic request/response layer: mints an id, stashes `callback` against
  // it, writes the line. handleLine below dispatches a reply back to
  // whichever caller sent it, matched by id — the same per-connection
  // request/response shape docs/design.md's Protocol section describes.
  // Takes the socket explicitly rather than reading root.activeSocket
  // (Loader.item): a freshly created Socket's connected:true can complete and
  // fire onConnectionStateChanged synchronously during its own construction,
  // before the Loader has finished assigning `item` to point at it — so
  // root.activeSocket can still read the old (torn-down) value at that exact
  // instant even though `this` inside the handler is already the right object.
  function sendRequest(socket, method, params, callback) {
    if (!socket || !socket.connected) {
      if (callback) callback({ error: { message: "not connected" } })
      return
    }
    var id = root.nextId++
    if (callback) root.pendingRequests[id] = callback
    var request = { id: id, method: method, params: params || {} }
    socket.write(JSON.stringify(request) + "\n")
    socket.flush()
  }

  function sendHello(socket) {
    root.sendRequest(socket, "hello", { client: "uchi-service", protocol: 1 }, function(message) {
      root.handshakeOk = !!message.result
      if (message.result) {
        root.fetchState()
        root.scheduleContextSend()
      }
    })
  }

  function handleLine(line) {
    var message = null
    try { message = JSON.parse(line) } catch (e) { return }
    if (!message || typeof message !== "object") return
    if ("event" in message) { root.handleEvent(message); return }
    var callback = root.pendingRequests[message.id]
    if (!callback) return
    delete root.pendingRequests[message.id]
    callback(message)
  }

  function handleEvent(message) {
    // The wrapper re-fetches what changed rather than trusting the push
    // payload as authoritative data, per docs/design.md's Protocol section —
    // sections is informational only, not consulted here.
    if (message.event === "state.changed") root.fetchState()
  }

  function fetchState() {
    root.sendRequest(root.activeSocket, "state.get", {}, function(message) {
      if (message && message.result) root.coreState = message.result
    })
  }

  function resolve(text, callback) {
    root.sendRequest(root.activeSocket, "prompt.resolve", { text: text }, callback)
  }

  // run/pinRoom/unpinRoom re-fetch state.get themselves on success, not just
  // on the server's own state.changed push — the socket is local, so there's
  // no real latency cost, and it means the caller's own action reflects
  // immediately without waiting on a round trip through the core's broadcast.
  function run(line, callback) {
    root.sendRequest(root.activeSocket, "prompt.run", { line: line }, function(message) {
      if (message && message.result && message.result.ok) root.fetchState()
      if (callback) callback(message)
    })
  }

  function pinRoom(zoneId, callback) {
    root.sendRequest(root.activeSocket, "room.pin", { zone: zoneId }, function(message) {
      if (message && !message.error) root.fetchState()
      if (callback) callback(message)
    })
  }

  function unpinRoom(callback) {
    root.sendRequest(root.activeSocket, "room.unpin", {}, function(message) {
      if (message && !message.error) root.fetchState()
      if (callback) callback(message)
    })
  }

  // machineRoom is wrapper-local config (docs/design.md's Config section) —
  // BarWidget.qml is the only file with a settings object to read it from,
  // so it forwards the value in here rather than this file reading it itself.
  property string machineRoom: ""

  function setMachineRoom(zoneId) {
    var value = zoneId || ""
    if (value === root.machineRoom) return
    root.machineRoom = value
    root.scheduleContextSend()
  }

  // Mic/media/idle are all plain Quickshell QML types — the same tier of
  // access as any other Quickshell import, gated by nothing Omarchy-specific
  // (unlike bar.shell.firstPartyServiceFor, which only a plugin's own
  // service, or a full "bar"-kind replacement, can actually read from).
  readonly property var micSource: Pipewire.defaultAudioSource
  readonly property bool micMuted: micSource && micSource.audio ? micSource.audio.muted : true
  readonly property var micNodes: Pipewire.nodes ? Pipewire.nodes.values : []
  readonly property var micActiveStreams: {
    var list = []
    for (var i = 0; i < micNodes.length; i++) {
      var node = micNodes[i]
      if (node && node.isStream && node.isSink === false && !node.audio?.muted) list.push(node)
    }
    return list
  }
  readonly property bool micLive: micActiveStreams.length > 0 && !micMuted

  readonly property var mprisPlayers: Mpris.players ? Mpris.players.values : []
  readonly property bool mediaPlaying: {
    for (var j = 0; j < mprisPlayers.length; j++) {
      if (mprisPlayers[j] && mprisPlayers[j].isPlaying) return true
    }
    return false
  }

  readonly property bool isIdle: idleMonitor.isIdle

  onMicLiveChanged: root.scheduleContextSend()
  onMediaPlayingChanged: root.scheduleContextSend()
  onIsIdleChanged: root.scheduleContextSend()

  function scheduleContextSend() {
    contextDebounce.restart()
  }

  // context.set never triggers the core's own broadcast (only writes/
  // notifications do), so the caller re-fetches state.get itself, the same
  // self-refresh run/pinRoom/unpinRoom already do.
  function sendContext() {
    if (!root.connected || root.handshakeOk !== true) return
    root.sendRequest(root.activeSocket, "context.set", {
      mic: root.micLive,
      idle: root.isIdle,
      media: root.mediaPlaying,
      machineRoom: root.machineRoom || null
    }, function() { root.fetchState() })
  }

  Timer {
    id: contextDebounce
    interval: 250
    repeat: false
    onTriggered: root.sendContext()
  }

  PwObjectTracker { objects: root.micSource ? [root.micSource] : [] }

  // This plugin's own idle detection, not the shell's screensaver/lock
  // timeout (that config value is one of the fields
  // bar.shell.firstPartyServiceFor("omarchy.idle") would gate off from a
  // third-party plugin anyway) — 5 minutes is a plain, undocumented default,
  // not read from anywhere.
  IdleMonitor {
    id: idleMonitor
    enabled: true
    timeout: 300
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
    root.lastCoreExitCode = code
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
          // Whatever's still pending will never get a reply on this socket —
          // drop it rather than leak callbacks across reconnects.
          root.pendingRequests = ({})
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

  // Panel open/close/toggle are hooked in by BarWidget.qml once it's loaded
  // — only one IpcHandler can own a given target, and this one already owns
  // "uchi" for ping(), so BarWidget.qml's own lifecycle methods are reached
  // through these callback properties rather than a second IpcHandler
  // duplicating the target (which Quickshell silently drops one of).
  property var _openPanel: null
  property var _closePanel: null
  property var _togglePanel: null

  IpcHandler {
    target: "uchi"

    function ping(): string {
      if (root.connected && root.handshakeOk === true) return "ok"
      return "error: not connected to uchi core"
    }

    function open(): void { if (root._openPanel) root._openPanel() }
    function close(): void { if (root._closePanel) root._closePanel() }
    function show(): void { if (root._openPanel) root._openPanel() }
    function hide(): void { if (root._closePanel) root._closePanel() }
    function toggle(): void { if (root._togglePanel) root._togglePanel() }
  }
}

import QtQuick
import qs.Commons
import qs.Ui

// The bar pill: five states from uchi's connection status plus unseen Recent
// activity, and the host for the prompt panel. Owns the panel's lifecycle
// the way omarchy.clock's BarWidget.qml owns its calendar popup's — Panel.qml
// has no manifest entry point of its own, it's loaded internally below.
BarWidget {
  id: root
  moduleName: "uchi"

  readonly property var uchi: bar && bar.shell ? bar.shell.serviceFor("uchi") : null

  readonly property string connectionStatus: uchi ? uchi.connectionStatus : "connecting"
  readonly property var recentRows: uchi && uchi.coreState && uchi.coreState.recent ? uchi.coreState.recent : []
  // ts, not id: core/log.mjs mints a numeric id for capability rows but keeps
  // Homey's own (non-numeric-guaranteed) id for notification rows, so
  // comparing ids across row kinds can compare a number against a string.
  readonly property real newestRecentTs: recentRows.length > 0 ? recentRows[0].ts : 0

  // Session-only, not persisted across restarts.
  property real highestSeenTs: 0
  readonly property bool hasUnseen: newestRecentTs > highestSeenTs

  readonly property string pillState: connectionStatus !== "connected"
    ? connectionStatus
    : (hasUnseen ? "active" : "idle")

  readonly property color pillColor: {
    if (pillState === "not-set-up") return Color.muted
    if (pillState === "unreachable") return Color.urgent
    if (pillState === "connecting" || pillState === "active") return Color.accent
    return Color.foreground
  }

  readonly property string pillTooltip: {
    if (pillState === "not-set-up") return "uchi: not set up — run `uchi setup`"
    if (pillState === "unreachable") return "uchi: Homey unreachable"
    if (pillState === "connecting") return "uchi: connecting…"
    if (pillState === "active") return "uchi: new activity"
    return "uchi"
  }

  // machineRoom is this plugin's own settings (docs/design.md's Config
  // section), so this file is the one that reads it and pushes it into
  // Service.qml — Service.qml has no settings object of its own.
  readonly property string machineRoomSetting: setting("machineRoom", "")

  function syncMachineRoom() {
    if (uchi && typeof uchi.setMachineRoom === "function") uchi.setMachineRoom(root.machineRoomSetting)
  }

  // Service.qml's own IpcHandler already owns the "uchi" target (for
  // ping()) — a second IpcHandler here would collide, so open/close/toggle
  // are reached through these callback hooks instead.
  function syncIpcHooks() {
    if (!uchi) return
    uchi._openPanel = root.open
    uchi._closePanel = root.close
    uchi._togglePanel = root.toggle
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("uchi" in target) target.uchi = root.uchi
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }

  // Clears "active" back to "idle" on every open, IPC-triggered or clicked
  // — and keeps clearing it continuously while the panel stays open, not
  // just at the moment it opens: an action taken while already looking at
  // an open panel produces a new Recent row too, and it shouldn't read as
  // "unseen" just because it arrived a moment after open() rather than
  // before it.
  onOpenedChanged: if (root.opened) root.highestSeenTs = root.newestRecentTs
  onNewestRecentTsChanged: if (root.opened) root.highestSeenTs = root.newestRecentTs

  onUchiChanged: { syncMachineRoom(); syncIpcHooks(); injectPanel() }
  onMachineRoomSettingChanged: syncMachineRoom()
  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "●"
    active: true
    activeColor: root.pillColor
    tooltipText: root.pillTooltip
    // bar.shell.toggle/summon are for a *different* plugin summoning this
    // one by id — a click on our own pill toggles our own panel directly.
    onPressed: function(b) { if (b === Qt.LeftButton) root.toggle() }
  }
}

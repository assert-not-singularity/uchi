import QtQuick
import qs.Commons
import qs.Ui

// The prompt + resting body (Hero/Recent/Here, Attention/Habits placeholders).
// No manifest entry point of its own — BarWidget.qml loads this internally
// via a Loader, the same shape omarchy.clock's Panel.qml uses for its
// calendar popup. State/IPC lifecycle comes from the base Panel type; actual
// on-screen chrome is qs.Ui's KeyboardPanel below.
Panel {
  id: root
  moduleName: "uchi"
  ipcTarget: "uchi"
  manageIpc: false

  property var uchi: null
  property var anchorItem: null
  // The bar's popout coordinator tracks the widget mounted in its slot
  // (BarWidget.qml), not this nested panel — see docs/phase-3-plan.md.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Named coreState, not state: QQuickItem already has a built-in `state`
  // property (the QML States system) that this would otherwise shadow.
  readonly property var coreState: uchi && uchi.coreState ? uchi.coreState : null
  readonly property var hero: coreState ? coreState.hero : null
  readonly property var heroRoom: hero ? hero.room : null
  readonly property var heroDevices: heroRoom && heroRoom.devices ? heroRoom.devices : []
  readonly property var recentRows: coreState && coreState.recent ? coreState.recent : []
  readonly property var hereRoom: coreState ? coreState.here : null
  readonly property var hereDevices: hereRoom && hereRoom.devices ? hereRoom.devices : []

  property string promptText: ""
  property var candidateMatches: []
  property var candidateRoom: null
  // Whatever of the prompt an ambiguous match couldn't apply (core/
  // grammar.mjs's `rest`) — needed to reconstruct "<label> <zone> <rest>"
  // when a candidate with no `line` of its own (still ambiguous) gets
  // selected; see activateCursor.
  property string candidateRest: ""
  readonly property bool showingCandidates: promptText.length > 0

  function refreshCandidates() {
    var requestText = root.promptText
    if (!uchi || requestText.length === 0) {
      root.candidateMatches = []
      root.candidateRoom = null
      root.candidateRest = ""
      root.cursorIndex = 0
      return
    }
    uchi.resolve(requestText, function(message) {
      if (requestText !== root.promptText) return // stale — prompt moved on
      var result = message && message.result ? message.result : {}
      root.candidateRoom = result.room || null
      root.candidateMatches = result.matches || []
      root.candidateRest = result.rest || ""
      root.cursorIndex = 0
    })
  }
  onPromptTextChanged: refreshCandidates()

  // One flat, cursor-navigable list: the live candidates while the prompt
  // holds text, else the resting body's rows in section order. A row's
  // `kind` also drives the inline section header the Repeater below draws
  // whenever it changes from the previous entry.
  readonly property var activeRows: {
    if (root.showingCandidates) {
      if (root.candidateRoom) return [{ kind: "room", room: root.candidateRoom }]
      var matchRows = []
      for (var m = 0; m < root.candidateMatches.length; m++) matchRows.push({ kind: "match", row: root.candidateMatches[m] })
      return matchRows
    }
    var rows = []
    for (var h = 0; h < root.heroDevices.length; h++) rows.push({ kind: "hero", row: root.heroDevices[h] })
    for (var r = 0; r < root.recentRows.length; r++) rows.push({ kind: "recent", row: root.recentRows[r] })
    for (var k = 0; k < root.hereDevices.length; k++) rows.push({ kind: "here", row: root.hereDevices[k] })
    return rows
  }

  property int cursorIndex: 0
  readonly property var cursorEntry: root.cursorIndex >= 0 && root.cursorIndex < root.activeRows.length
    ? root.activeRows[root.cursorIndex] : null

  onActiveRowsChanged: {
    if (root.cursorIndex > root.activeRows.length - 1) root.cursorIndex = Math.max(0, root.activeRows.length - 1)
    if (root.cursorIndex < 0) root.cursorIndex = 0
  }

  function moveCursor(delta) {
    if (root.activeRows.length === 0) return
    root.cursorIndex = Math.max(0, Math.min(root.activeRows.length - 1, root.cursorIndex + delta))
  }

  // Clears the prompt after a real action (room pin or line run) succeeds,
  // not eagerly and not after an inert activation (an informational row
  // with no line) — the resting body is where the effect of the action is
  // actually visible, and it never renders while the prompt still holds
  // text, but a failed pin/run (socket down, rejected zone, a write that
  // errored) must leave the query in place rather than silently discard it.
  function activateCursor() {
    var entry = root.cursorEntry
    if (!entry || !uchi) return
    if (entry.kind === "room") {
      uchi.pinRoom(entry.room.id, function(message) {
        if (message && !message.error) root.promptText = ""
      })
      return
    }
    var row = entry.row
    if (!row) return
    if (row.line) {
      uchi.run(row.line, function(message) {
        if (message && message.result && message.result.ok) root.promptText = ""
      })
      return
    }
    // Still ambiguous (no line of its own — there's no single valid
    // grammar line for "the ambiguous set"). The zone qualifier is the
    // only thing that can turn this specific candidate into a resolvable
    // line, so reconstruct "<label> <zone> <rest>" and run that instead of
    // doing nothing. A candidate with no zone (e.g. the rare zone-vs-device
    // name tie) can't be qualified this way and stays inert.
    if (row.zone) {
      var qualifiedLine = row.label + " " + row.zone + (root.candidateRest ? " " + root.candidateRest : "")
      uchi.run(qualifiedLine, function(message) {
        if (message && message.result && message.result.ok) root.promptText = ""
      })
    }
  }

  function sectionTitle(kind) {
    if (kind === "hero") return root.heroRoom ? root.heroRoom.name : "Hero"
    if (kind === "recent") return "Recent"
    if (kind === "here") return root.hereRoom ? root.hereRoom.name + " (Here)" : "Here"
    if (kind === "match") return "Matches"
    if (kind === "room") return "Room"
    return ""
  }

  function escapeMarkup(text) {
    return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  // Rich-text markup, not a plain string: any row carrying a `.zone` field
  // (Recent, an ambiguous match, a dead end) gets the same dimmed suffix —
  // one style for every kind, not a per-kind rule. Hero/Here rows never
  // carry `.zone` (they're already grouped under a room's own section
  // header, so it'd be redundant), so this never fires for them.
  function rowMarkup(entry) {
    if (entry.kind === "room") return escapeMarkup(entry.room.name)
    var row = entry.row
    if (!row) return ""
    var text = escapeMarkup(row.label)
    if (row.zone) {
      text += " <font color=\"" + Color.muted + "\">" + escapeMarkup(row.zone) + "</font>"
    }
    // A transition's own "→ ..." already reads as a separator — stacking
    // it after an em dash ("— → on") is redundant. Only Recent's
    // transition-style why (core/recent.mjs's formatTransitionWhy) ever
    // starts with it; a current-value why (Hero/Here) or a resolve-time
    // why ("ambiguous — pick one") keeps the em dash, having no arrow.
    if (row.why) text += (row.why.indexOf("→") === 0 ? " " : " — ") + escapeMarkup(row.why)
    return text
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(bodyColumn.implicitHeight, Style.space(520))

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          if (root.promptText.length > 0) root.promptText = ""
          else root.close()
          event.accepted = true
          return
        }
        if (event.key === Qt.Key_Up) { root.moveCursor(-1); event.accepted = true; return }
        if (event.key === Qt.Key_Down) { root.moveCursor(1); event.accepted = true; return }
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          root.activateCursor(); event.accepted = true; return
        }
        if (event.key === Qt.Key_Backspace) {
          if (root.promptText.length > 0) root.promptText = root.promptText.slice(0, -1)
          event.accepted = true
          return
        }
        // No single-letter hotkeys reserved at all, "a" included: any of
        // them blocks typing a real device/zone name starting with that
        // letter ("Anrichte", "Arbeitszimmer", ...) for a shortcut that
        // isn't essential. See docs/phase-3-plan.md's scope gaps.
        if (event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127
            && (event.modifiers === Qt.NoModifier || event.modifiers === Qt.ShiftModifier)) {
          root.promptText += event.text
          event.accepted = true
        }
      }

      Flickable {
        id: bodyScroll
        anchors.fill: parent
        clip: true
        contentWidth: width
        contentHeight: bodyColumn.implicitHeight
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: bodyColumn
          width: bodyScroll.width
          spacing: Style.space(6)

          Text {
            width: parent.width
            text: root.promptText.length > 0 ? root.promptText : "type a prompt…"
            color: root.promptText.length > 0 ? Color.foreground : Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }

          Text {
            visible: !root.showingCandidates
            width: parent.width
            text: root.heroRoom ? "" : (root.hero ? root.hero.summary : "")
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          Repeater {
            model: root.activeRows

            Column {
              id: rowDelegate
              required property var modelData
              required property int index
              width: bodyColumn.width

              Text {
                visible: rowDelegate.index === 0
                  || root.activeRows[rowDelegate.index - 1].kind !== rowDelegate.modelData.kind
                width: rowDelegate.width
                text: root.sectionTitle(rowDelegate.modelData.kind)
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
              }

              Rectangle {
                width: rowDelegate.width
                height: rowText.implicitHeight + Style.space(4)
                color: rowDelegate.index === root.cursorIndex ? Color.menu.selectedBackground : "transparent"

                Text {
                  id: rowText
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.StyledText
                  text: root.rowMarkup(rowDelegate.modelData)
                  color: rowDelegate.modelData.kind === "recent" && rowDelegate.modelData.row && rowDelegate.modelData.row.in
                    ? Color.accent : Color.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
              }
            }
          }

          Text {
            visible: !root.showingCandidates
            width: parent.width
            text: "Attention — nothing yet"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          Text {
            visible: !root.showingCandidates
            width: parent.width
            text: "Habits — nothing yet"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }
        }
      }
    }
  }
}

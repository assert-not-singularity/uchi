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
  // (BarWidget.qml), not this nested panel.
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
  // core/grammar.mjs's `?` result — { label, list } for the single device
  // "<label>?" resolved to, `list` the words that apply to it. Mutually
  // exclusive with candidateRoom/candidateMatches: a trailing "?" is its
  // own branch in resolve(), never combined with an ordinary match.
  property var candidateWords: null
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
      root.candidateWords = null
      root.candidateRest = ""
      root.cursorIndex = 0
      return
    }
    uchi.resolve(requestText, function(message) {
      if (requestText !== root.promptText) return // stale — prompt moved on
      var result = message && message.result ? message.result : {}
      root.candidateRoom = result.room || null
      root.candidateWords = result.words || null
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
      if (root.candidateWords) {
        var wordRows = []
        for (var w = 0; w < root.candidateWords.list.length; w++) {
          wordRows.push({ kind: "word", word: root.candidateWords.list[w] })
        }
        return wordRows
      }
      var matchRows = []
      for (var m = 0; m < root.candidateMatches.length; m++) matchRows.push({ kind: "match", row: root.candidateMatches[m] })
      return matchRows
    }
    var rows = []
    for (var h = 0; h < root.heroDevices.length; h++) rows.push({ kind: "hero", row: root.heroDevices[h] })
    for (var r = 0; r < root.recentRows.length; r++) {
      rows.push({ kind: "recent", row: root.recentRows[r], tsRole: root.tsRoleAt(root.recentRows, r) })
    }
    for (var k = 0; k < root.hereDevices.length; k++) rows.push({ kind: "here", row: root.hereDevices[k] })
    return rows
  }

  // Recent is newest-first and already ts-sorted by the core — a run of
  // consecutive rows landing in the same displayed minute came from one
  // linked event (a flow/group setting several devices at once with no
  // mood/flow row of its own to fold under), and the timeline gutter draws
  // them as a bracket instead of repeating the same time on every line.
  // Grouped by the displayed minute, not raw ts equality: separate devices
  // reacting to one trigger arrive as separate events a few hundred ms to a
  // couple seconds apart, essentially never at the exact same millisecond.
  function tsRoleAt(rows, i) {
    var sameAsPrev = i > 0 && root.formatTime(rows[i - 1].ts) === root.formatTime(rows[i].ts)
    var sameAsNext = i < rows.length - 1 && root.formatTime(rows[i + 1].ts) === root.formatTime(rows[i].ts)
    if (!sameAsPrev && !sameAsNext) return "single"
    if (!sameAsPrev && sameAsNext) return "first"
    if (sameAsPrev && sameAsNext) return "middle"
    return "last"
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
    if (kind === "word") return root.candidateWords ? root.candidateWords.label : "Words"
    return ""
  }

  function escapeMarkup(text) {
    return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  // Homey's device.class -> a Nerd Font glyph (the shell's default font is
  // "JetBrainsMono Nerd Font" — see Style.qml), for a quick visual cue next
  // to a row's name. capabilityId alone can't tell a light from a socket,
  // both commonly controlled via plain onoff — this is why here.mjs/
  // recent.mjs thread the device's own class through instead. Only classes
  // picked confidently; anything else falls back to a plain dot rather than
  // guess at a glyph that might not exist in every Nerd Font build.
  function classIcon(deviceClass) {
    switch (deviceClass) {
      case "light": return ""      // lightbulb-o
      case "socket": return ""     // plug
      case "thermostat": return "" // thermometer-half
      case "lock": return ""       // lock
      case "speaker": return ""    // volume-up
      case "tv": return ""         // television
      default: return "●"
    }
  }

  function rowIcon(entry) {
    if (entry.kind === "word") return "" // a plain word label, not a device/zone
    var row = entry.row
    if (!row) return ""
    if (entry.kind === "recent" && row.kind === "notification") return "" // bell
    if (entry.kind === "hero" || entry.kind === "here" || entry.kind === "recent") {
      return classIcon(row.deviceClass)
    }
    // A "match" row can be a device or a zone candidate — both can share
    // the exact same name at once (a zone and a device both "Wohnzimmer"),
    // which is exactly the case an icon needs to disambiguate at a glance.
    // A zone row carries its own deviceClass only when it's a capability-
    // scoped batch/pending-scope summary (previewRowForBatch/pendingScope in
    // grammar.mjs) — "the lights in Wohnzimmer," not the Wohnzimmer zone
    // itself — so that takes priority over the house icon; a bare room
    // query never sets deviceClass at all, and still gets the house icon.
    if (entry.kind === "match") {
      if (row.deviceClass) return classIcon(row.deviceClass)
      return row.kind === "zone" ? "" /* home */ : classIcon(row.deviceClass)
    }
    return ""
  }

  // A device currently off reads as background, not foreground — matches
  // the mockup's dimmed "off" rows. Scoped to Hero/Here only: a Recent row
  // is a transition that already happened, not a persisted state, so
  // dimming a "→ off" row the moment it lands would read as a rendering
  // glitch, not a status.
  function rowOpacity(entry) {
    var row = entry.row
    if (!row) return 1
    if (entry.kind !== "hero" && entry.kind !== "here") return 1
    return row.capabilityId === "onoff" && row.value === false ? 0.55 : 1
  }

  // Includes seconds, not just HH:MM — tsRoleAt groups by this same string,
  // and a coarser minute-level grouping would bracket unrelated rows that
  // simply landed in the same minute. Same-second is still loose enough to
  // catch a real linked event (a flow/group action's separate device writes
  // land within the same second in practice), but tight enough that two
  // unrelated actions essentially never collide.
  function formatTime(ts) {
    var d = new Date(ts)
    var hh = String(d.getHours()).padStart(2, "0")
    var mm = String(d.getMinutes()).padStart(2, "0")
    var ss = String(d.getSeconds()).padStart(2, "0")
    return hh + ":" + mm + ":" + ss
  }

  // The timeline gutter rendered before a Recent row: a faded time plus a
  // dash for a standalone row, or a box-drawing bracket for a run of rows
  // that shares one ts (see tsRoleAt) — the time then prints once, on the
  // bracket's first line, instead of repeating.
  function timeGutter(entry) {
    if (entry.kind !== "recent") return ""
    var row = entry.row
    var showTime = entry.tsRole === "single" || entry.tsRole === "first"
    var time = showTime ? formatTime(row.ts) : "        "
    var connector = entry.tsRole === "single" ? "--"
      : entry.tsRole === "first" ? "┌─"
      : entry.tsRole === "middle" ? "├─"
      : "└─"
    return time + " " + connector + " "
  }

  // Rich-text markup, not a plain string: any row carrying a `.zone` field
  // (Recent, an ambiguous match, a dead end) gets the same dimmed suffix —
  // one style for every kind, not a per-kind rule. Hero/Here rows never
  // carry `.zone` (they're already grouped under a room's own section
  // header, so it'd be redundant), so this never fires for them.
  function rowMarkup(entry) {
    if (entry.kind === "room") return escapeMarkup(entry.room.name)
    if (entry.kind === "word") return escapeMarkup(entry.word)
    var row = entry.row
    if (!row) return ""
    var icon = rowIcon(entry)
    var text = icon ? escapeMarkup(icon) + " " + escapeMarkup(row.label) : escapeMarkup(row.label)
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
        // isn't essential — see docs/design.md's "Explicitly decided
        // against" for the all-off shortcut specifically.
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

              readonly property bool isFirstOfKind: rowDelegate.index === 0
                || root.activeRows[rowDelegate.index - 1].kind !== rowDelegate.modelData.kind

              Text {
                visible: rowDelegate.isFirstOfKind
                width: rowDelegate.width
                text: root.sectionTitle(rowDelegate.modelData.kind)
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
              }

              // Mood chips: informational only for now — the grammar has no
              // way to activate a mood yet, so these aren't clickable.
              Flow {
                visible: rowDelegate.modelData.kind === "here" && rowDelegate.isFirstOfKind
                  && root.hereRoom && root.hereRoom.moods && root.hereRoom.moods.length > 0
                width: rowDelegate.width
                spacing: Style.space(4)

                Repeater {
                  model: root.hereRoom ? root.hereRoom.moods : []

                  Rectangle {
                    required property var modelData
                    radius: Style.space(2)
                    color: "transparent"
                    border.color: Color.muted
                    border.width: 1
                    width: chipText.implicitWidth + Style.space(12)
                    height: chipText.implicitHeight + Style.space(6)

                    Text {
                      id: chipText
                      anchors.centerIn: parent
                      text: modelData.name
                      color: Color.foreground
                      font.family: Style.font.family
                      font.pixelSize: Style.font.body
                    }
                  }
                }
              }

              Rectangle {
                width: rowDelegate.width
                height: rowText.implicitHeight + Style.space(4)
                color: rowDelegate.index === root.cursorIndex ? Color.menu.selectedBackground : "transparent"
                opacity: root.rowOpacity(rowDelegate.modelData)

                Text {
                  width: Style.space(80)
                  visible: rowDelegate.modelData.kind === "recent"
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.timeGutter(rowDelegate.modelData)
                  color: Color.muted
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                }

                Text {
                  id: rowText
                  anchors.left: parent.left
                  anchors.leftMargin: rowDelegate.modelData.kind === "recent" ? Style.space(80) : 0
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

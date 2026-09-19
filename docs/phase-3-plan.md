# Uchi — Phase 3 ("Omarchy panel") implementation plan

## Context

Phase 2 (merged) made the core real: `state.get`/`prompt.resolve`/`prompt.run`/`context.set`
work against a live Homey, with a recorded-fixture test suite. Nothing renders yet — every
verification so far has gone through `bin/uchi`, a one-shot client with no open connection.

Phase 3, per `docs/design.md`'s build order, is: **"BarWidget.qml (pill, 5 states), Panel.qml
(prompt + Recent + Here, menu rows), `context.set` wired to real desktop signals. Done: the
example prompts above resolve and run in the real panel, minus the agent path."**

The five pill states, confirmed with you since `design.md` never defines them (Attention/Habits
are still empty arrays until phases 4–5, so they can't drive pill state yet):

1. **not-set-up** — no credentials (`uchi setup` hasn't run)
2. **unreachable** — core exit 69 (Homey offline)
3. **connecting** — socket reconnect in flight
4. **idle** — connected, nothing new since the panel was last opened
5. **active** — connected, unseen Recent rows since the panel was last opened

Real facts confirmed against this machine's installed Omarchy shell (Quattro) and its first-party
plugins (`omarchy.clock`, `omarchy.media`, `omarchy.tailscale`, `omarchy.idle`) plus the host
source itself (`shell.qml`, `services/PluginShellApi.qml`, `services/PluginFirstPartyServiceApi.qml`),
not the one third-party plugin installed on this machine (`quickshell.spotify`) — its structure
isn't representative of anything official and isn't used as a reference below:

- `qs.Ui` provides base `BarWidget` and `Panel` QML types (`/usr/share/omarchy/shell/Ui/`) a
  plugin extends rather than building bar-pill/panel chrome from scratch. `BarWidget` exposes
  `bar`, `moduleName`, `settings`, `setting()`, `broadcast()`.
- `omarchy.media` (`service` + `bar-widget` kinds, `keepLoaded: true`) is the first-party shape
  this plugin's `Service.qml`/`BarWidget.qml` pair matches structurally. `omarchy.clock` is the
  reference for the `BarWidget.qml`/`Panel.qml` split specifically: **one** manifest kind
  (`bar-widget` only) — `Panel.qml` is not a separate `entryPoints.panel`, it's loaded internally
  by `BarWidget.qml` via `Loader { source: Qt.resolvedUrl("Panel.qml") }`. The bar-widget forwards
  `bar`/`settings` into the loaded panel itself (an `injectPanel()`-style function, called from
  `onBarChanged`/`onSettingsChanged` and once from the `Loader`'s `onLoaded`) and exposes
  `open()`/`close()`/`opened`/`toggle()` that delegate to `panelLoader.item`; `Panel.qml` still
  extends the base `Panel` type but sets `manageIpc: false` since the bar-widget's own
  `IpcHandler` (target `"uchi"`) owns open/close/toggle. This plugin follows that same shape:
  `manifest.json` gains only the `bar-widget` kind, not a `panel` kind.
  `bar.shell.serviceFor(id)`/`bar.shell.toggle/summon/hide(id, payload)`/
  `bar.shell.firstPartyServiceFor(id)` are confirmed directly against `PluginShellApi.qml` (the
  host's own implementation, not plugin-specific) — a `BarWidget` entry calls
  `bar.shell.serviceFor("uchi")` for its own always-loaded service; `Panel.qml`, loaded
  internally rather than as its own manifest entry, gets the service reference forwarded by
  `BarWidget.qml`'s `injectPanel()` the same way `bar`/`settings` are, not via host injection
  (host auto-injection of a `service` property only happens for a manifest-level `panel` kind
  entry, which this plugin doesn't declare).
- `bar.shell.firstPartyServiceFor(id)` looked like the sanctioned way to read mic/idle/media, but
  tracing `shell.qml`'s `_firstPartyServiceLookup` shows it only returns real data when the
  calling plugin owns `id` itself (why `omarchy.media`'s own `BarWidget.qml` can read
  `firstPartyServiceFor("omarchy.media")` — that's its *own* service) or has full `"bar"`-kind
  (whole-bar-replacement) capability. A third-party `bar-widget` plugin like this one gets `null`
  from it for `"omarchy.idle"`/`"omarchy.media"` — this path is not usable here at all.
- Mic, idle, and media are all reachable a different way instead: as plain Quickshell QML types,
  the same tier of access as any other Quickshell import, gated by nothing Omarchy-specific.
  Mic-live is `Quickshell.Services.Pipewire`'s `Pipewire.defaultAudioSource`, wrapped in a real
  bar widget (`plugins/bar/widgets/Microphone.qml`) as `inUse = activeStreams.length > 0 &&
  !muted`. Media is `Quickshell.Services.Mpris`'s `Mpris.players` — `plugins/services/media/
  Service.qml` reads `Mpris.players.values` directly, the same import this plugin can use
  directly rather than going through `omarchy.media`'s own service at all. Idle is
  `Quickshell.Wayland`'s `IdleMonitor` element (`timeout`, `onIsIdleChanged`) —
  `plugins/services/idle/Service.qml` instantiates its own directly; this plugin instantiates its
  own too, with its own timeout, rather than reading the shell's screensaver-timeout config (that
  config value itself is one of the fields `firstPartyServiceFor` would gate off). Not run on a
  live Quickshell engine to confirm `IdleMonitor` actually fires under this compositor — that's
  what the plan's own "reload the plugin" verification step below is for, same as every other
  "real facts" item here that's confirmed by reading rather than by running.
- `machineRoom` is **not** a live signal — `design.md`'s Config section puts it in wrapper-local
  config (this plugin's own settings, via `BarWidget`'s `setting()`), read once and on change,
  not polled from the desktop. `Service.qml` has no settings of its own (it's a plain `Item`, not
  a `BarWidget` instance, so it's never handed a `settings` object by the host) — `BarWidget.qml`
  reads `setting("machineRoom", null)` and forwards it into `Service.qml` via a setter call, the
  same forwarding `omarchy.clock`'s `injectPanel()` uses for `bar`/`settings`.
- `state.changed` (the push half of the protocol) was explicitly deferred past phase 2 to "the
  first long-lived wrapper, against a real consumer" — this is that consumer. `core/rpc.mjs` has
  no broadcast path yet.

**Scope gaps carried into this phase, flagged rather than silently resolved:**

- `h`/`l` (step a row's capability by one notch) and the `++`/`--` notch value form have no
  grammar support (still deferred, no phase attached). Wire the keys but have them no-op with a
  console warning rather than send `grammar.mjs` a line it can't parse — do **not** implement
  notch parsing here just to make the key do something.
- `a` (all off) has no named protocol method anywhere in `design.md`, and can't be built
  client-side from the existing row shape either: a Here/Hero device row is `{ id, label, why,
  line? }` — it doesn't expose which capability `line` targets or the device's raw `onoff`
  value, and `here.mjs`'s own picker can surface a different capability (`dim`, say) for a
  device that also has `onoff` on. This needs a small core addition, not client assembly: add
  `deviceId`/`capabilityId` to the Here device row shape, so `a` becomes a client-side loop over
  Here's rows with `capabilityId === "onoff"`,
  sending `prompt.run("<label> off")` for each — built directly, not `row.line` (which reflects
  the device's *current* value, so an already-on row's line is `"<label> on"` and would leave it
  on if replayed). No current-value field needed: an off write to an already-off device is a
  harmless no-op. Runs in sequence, not `Promise.all` — writes serialize per capability key.
- `x`/`s` (dismiss/snooze/mute) have nothing to act on — Attention and Habits are empty arrays
  until phases 4–5. Bind the keys to no-ops (or omit them) rather than call
  `row.dismiss`/`row.snooze`/`row.mute`, which don't exist as RPC methods yet either.
- `room.pin`/`room.unpin` **are** in scope: `design.md`'s Keyboard section requires Enter on a
  bare zone-query row to pin it as Here, and that's real, reachable behavior in phase 3.
- `recent.mjs`'s `list()` output rows carry no `ts` field — `log.mjs`'s buffer entries have one,
  but `capabilityRow()`/`notificationRow()` don't pass it through. `BarWidget.qml`'s
  `recent[0].ts` comparison (above) needs it, so this phase adds `ts: entry.ts` to both — a
  second Recent row-shape addition alongside Here's `deviceId`/`capabilityId`, not a client-side
  workaround.

## Files to create or change

### `core/rpc.mjs` (extend)

Track connected sockets in a `Set` so the server can push, not just respond. Add
`broadcast(payload)` to the object `createRpcServer()` returns: writes `JSON.stringify({event:
"state.changed", ...payload}) + "\n"` to every currently-connected socket. No queuing or
delivery guarantee — a client that's mid-reconnect simply misses it and catches up on its next
`state.get`, same tolerance the generation-guard already assumes.

### `core/index.mjs` (extend)

- `log.append`/`log.appendNotification` currently return nothing; make both return whether they
  actually inserted a row (`false` for `append`'s existing `from === to` no-op case and for
  `appendNotification`'s existing already-seen-id case). The 30s notification poll calls
  `appendNotification` once per returned entry regardless of whether it's new — broadcasting
  unconditionally on every call would fire a `state.changed` (and a client re-fetch) every 30s
  even when nothing changed. Broadcast only when at least one call in a batch returned `true`:
  after a `prompt.run` write settles, after an externally observed capability change logs a
  Recent row (`onChange`, phase 2 — always `true`, `onChange` only calls `append` for a real
  transition), and after a notification poll where at least one `appendNotification` call
  returned `true`. Payload: `rpc.broadcast({ sections: ["recent", "hero", "here"] })` — the panel
  re-fetches via `state.get` on receipt rather than trusting the push payload as authoritative
  data, per `design.md`'s own protocol note ("wrapper re-fetches what changed").
- Add `room.pin { zone }` and `room.unpin {}` methods. A `pinnedRoom` variable, separate from
  `context.machineRoom`: `room.pin` sets it (reject with an error if `zone` isn't a real zone id
  in the current `zones` map — this is an explicit user action, not a tolerant background read);
  `room.unpin` clears it. `state.get`'s `here`/`hero.room` computation becomes `here.compute(
  pinnedRoom ?? context.machineRoom, ...)`. A fresh room query overriding an existing pin (per
  `design.md`: "until `room.unpin` or the next room query overrides it") is the wrapper's job —
  Panel.qml calls `room.pin` again with the new zone on Enter, same as the first time.

### `Service.qml` (repo root, extend)

Phase 1 only tracks a single hardcoded `hello` request. This phase turns it into the real
state-owning daemon `BarWidget.qml`/`Panel.qml` read from, the same role `omarchy.media`'s
`Service.qml` plays for its own `BarWidget.qml`:

- A generic request/response layer replacing the single `helloRequestId` special case: an
  incrementing id, a `Map` of pending id → callback, dispatched from the existing `handleLine`.
  `sendHello` becomes one caller of this, not its own mechanism.
- `property var state: null` — the last `state.get` result. Call `state.get` once right after a
  successful handshake, and again on every incoming `{event: "state.changed", ...}` push.
- `function resolve(text, callback)`, `function run(line, callback)`, `function pinRoom(zoneId,
  callback)`, `function unpinRoom(callback)` — thin wrappers sending the matching RPC method
  through the request layer above. `run`/`pinRoom`/`unpinRoom` re-fetch `state.get` themselves
  on success too, not just on the server's own broadcast — the socket is local, so there's no
  real latency cost, and it means the caller's own action reflects immediately without waiting
  on a round-trip push.
- `readonly property string connectionStatus` — the actual context.set/pill dependency phase 1
  never needed: `"not-set-up"` on exit 78, `"unreachable"` on exit 69, `"connecting"` while a
  reconnect/spawn is scheduled or in flight, `"connected"` once the socket + handshake succeed.
  `handleCoreExit` already branches on these exit codes but only sets internal booleans
  (`coreFailed`, `suppressSpawn`) — this phase turns that existing branch into a value
  `BarWidget.qml` can actually read, since `connected`/`handshakeOk` alone can't distinguish
  "never connected because not set up" from "never connected because Homey's unreachable" from
  "reconnecting right now" (all three present as `connected: false, handshakeOk: null`).
- Context forwarding: mic, idle, and media are all read directly inside `Service.qml` itself —
  `Pipewire.defaultAudioSource` (mirroring `Microphone.qml`'s `inUse`), a local `IdleMonitor`
  (mirroring `plugins/services/idle/Service.qml`'s own), and `Mpris.players` (mirroring
  `plugins/services/media/Service.qml`'s own `activePlayer` selection, simplified — this plugin
  only needs "is something playing," not full player selection) — none of these three need `bar`
  or the host-injected `shell`, so no forwarding from `BarWidget.qml` is needed for them.
  `machineRoom` is the one exception: `Service.qml` has no read path of its own for it — it's a
  plain `Item`, never handed a `settings` object by the host — so `BarWidget.qml` reads
  `setting("machineRoom", null)` and pushes it into `Service.qml` via a setter call
  (`setMachineRoom(zoneId)`), the same forwarding `omarchy.clock`'s `injectPanel()` uses for
  `bar`/`settings`.
- Send an initial `context.set` right after handshake, not only on later changes — otherwise the
  core sits at its null startup defaults until something happens to change. Debounce subsequent
  changes (~250ms) so a burst collapses into one call. `context.set` never triggers the core's
  own broadcast (only writes/notifications do), so call `state.get` again immediately after every
  successful `context.set` — the same self-refresh `run`/`pinRoom`/`unpinRoom` already do.
- Exposed to `BarWidget.qml` via `bar.shell.serviceFor("uchi")` — confirmed directly against
  `services/PluginShellApi.qml` (`serviceFor`/`_serviceLookup` are host code, not plugin-specific).
  `Panel.qml` has no manifest entry point of its own (see `BarWidget.qml` below) so it never gets
  a host-injected `service` property either — `BarWidget.qml` forwards the same reference into it.

### `BarWidget.qml` (repo root, new)

Extends `BarWidget`. Manifest (below) gains the `bar-widget` kind and `entryPoints.barWidget`.
Owns the panel's lifecycle the way `omarchy.clock`'s `BarWidget.qml` owns its calendar popup's:
a `Loader { source: Qt.resolvedUrl("Panel.qml") }`, an `injectPanel()` forwarding `bar`, `settings`,
and the `uchi` service reference into `panelLoader.item` (called from `onBarChanged`,
`onSettingsChanged`, and the `Loader`'s own `onLoaded`), `open()`/`close()`/`opened`/`toggle()`
delegating to `panelLoader.item`, and an `IpcHandler` (target `"uchi"`) routing to those.

- Renders the five pill states directly from `uchi.connectionStatus` for the first four
  (not-set-up/unreachable/connecting/connected-with-nothing-new); "active" is `connectionStatus
  === "connected"` plus a `highestSeenTs` property (session-only, not persisted across restarts)
  compared against `uchi.state.recent[0].ts` — **`ts`, not `id`**: `core/log.mjs` mints a
  numeric id for capability rows but keeps Homey's own (non-numeric-guaranteed) id for
  notification rows, so comparing ids across row kinds can compare a number against a string.
  `ts` is a real number on every row regardless of kind, and `recent.list()` already sorts by it.
- Click calls `root.toggle()` (the local `panelLoader.item` delegation above, not
  `bar.shell.toggle`/`summon` — those are for a *different* plugin summoning this one by id, per
  `omarchy.clock`'s own `WidgetButton.onPressed`).
- On panel open, sets `highestSeenTs` to `uchi.state.recent[0].ts`, clearing "active" back to
  "idle".

### `Panel.qml` (repo root, new)

Extends `Panel`. No manifest entry point — loaded internally by `BarWidget.qml`'s `Loader` (see
above), the same shape as `omarchy.clock`'s `Panel.qml`: `moduleName: "uchi"`, `ipcTarget: "uchi"`,
`manageIpc: false` (the bar-widget's own `IpcHandler` owns open/close/toggle), a `uchi` property
set by the bar-widget's `injectPanel()` rather than host-injected. The base `Panel` type (`open()`/
`close()`/`toggle()`/`opened`, backed by its own `PanelController`) is state/IPC only — no visible
window. Actual on-screen chrome is `qs.Ui`'s `KeyboardPanel` (confirmed first-party: layer-shell
positioning relative to an anchor, outside-click dismissal, multi-monitor click-through, keyboard
focus priming, popout coordination with sibling bar panels), the same component `omarchy.clock`'s
`Panel.qml` wraps its calendar content in. That needs `anchorItem` (the bar pill button) and
`hostWidget` (`readonly property var barIdentity: hostWidget || root`, since the bar's popout
coordinator tracks the mounted `BarWidget.qml`, not this nested panel) forwarded the same way
`bar`/`settings`/`uchi` are — `BarWidget.qml`'s `injectPanel()` sets both.

- A prompt `TextInput` at the top. Every keystroke calls `uchi.resolve(text, ...)`, rendering
  whatever `matches`/`room` comes back as the candidate list below the prompt — this is
  `prompt.resolve`'s whole purpose (design.md: "called on every keystroke... the safe,
  side-effect-free half").
- Below the prompt, the resting body: Hero (room name + device rows, or the aggregate-only
  summary line if `hero.room` is null), Recent (rows with `why`/`line`, in/out visually
  distinguished via each row's `in` field), Here (same row shape as Hero's room devices — they
  may literally be the same array per phase 2's `hero.room === here`). Attention/Habits render
  as empty sections (nothing to show yet, not hidden entirely — the layout should already have
  room for them once phases 4–5 land).
- **Keyboard conflict, resolved with you rather than guessed:** design.md's `j`/`k` navigation
  and `a`/`h`/`l`/`x`/`s` single-key commands can't coexist literally with a live fuzzy-search
  prompt — those are all valid leading characters of a real device/zone name ("kitchen",
  "hallway", "sonos", "attic"...). `qs.Ui`'s `PanelKeyCatcher` (the vim-style handler
  `omarchy.clock`/`omarchy.tailscale` use) assumes a read-only list with no live text entry, so
  it's not reused here — instead this plugin builds its own `Keys.onPressed` handler, the same
  way `plugins/menu/Menu.qml` does for its own search-box-plus-list panel (confirmed first-party
  precedent: arrow keys navigate, everything printable goes into the filter text, no `j`/`k`).
  Resolution: **arrow keys always move the cursor** (never inserted as text, satisfying design.md's
  own "`j`/`k` or `↑`/`↓`" — just without the `j`/`k` half); **none** of `a`/`h`/`l`/`x`/`s` are
  reserved as commands, not even `a` (all-off) alone. First drafted as "`a` reserved only while the
  prompt is empty," but live testing on real hardware showed even that one letter blocks typing any
  device/zone name starting with it ("Anrichte", "Arbeitszimmer", ...) for a shortcut that isn't
  essential — the gaps section above already sanctions "bind the keys to no-ops (**or omit them**)"
  for `h`/`l`/`x`/`s`; this phase omits `a` too, on the same reasoning. `j`/`k`/`a`/`h`/`l`/`x`/`s`
  all type into the prompt like any other character, always.
- `Up`/`Down` move the cursor across whichever list currently has focus (the live candidate list
  while the prompt holds text, else the resting body's rows). `Enter` — a highlighted row with a
  `line` calls `uchi.run(line)`; a row that's a bare zone query (`room` present, no `line`) calls
  `uchi.pinRoom(room.id)` instead, per design.md's stated exception; either way, a successful
  activation clears the prompt afterward, since the resting body — where the effect of running a
  line or pinning a room is actually visible — never renders while the prompt still holds text.
  `Esc` clears the prompt if it holds text, else calls `root.close()`. `Enter` on a selected
  candidate is the only device-affecting key this panel has: `Tab`'s copy-to-prompt, `Shift+Tab`'s
  `switchPanel(-1)`, and the hero's `a` (all-off) control are all absent, not merely unbound — see
  "Post-launch refinements" below for why `a` specifically came out after shipping, not before.

### `manifest.json` (repo root, extend)

Add `"bar-widget"` to `kinds` (not `"panel"` — see above); add `entryPoints.barWidget:
"BarWidget.qml"`. Add a `barWidget` block (`displayName`, `category`, `defaultSection`) matching
the shape `omarchy.media`'s manifest uses.

### `core/test/rpc.test.mjs` (extend)

Add a test that `broadcast()` reaches every connected socket and not a disconnected one — the
one new piece of `rpc.mjs` behavior this phase adds, exercised the same way the existing `hello`
test already connects a plain `net.Socket` client.

## Live-testing findings

Discovered only by actually reloading the plugin against a running shell — real, not
"confirm during implementation" speculation:

- `~/.config/omarchy/plugins/uchi` being a **symlink** to this repo (a manual dev shortcut, not
  the standard `omarchy plugin add` install path, which is a real `git clone`) made the
  `bar-widget` entry point fail to load with `File name case mismatch` — a genuinely misleading
  Quickshell message; it actually means the running shell never saw these files during its first
  directory scan, and doesn't mean what it says. `service`-kind loading tolerated the symlink
  fine (that's why phase 1/2 never hit this); `bar-widget` loading didn't. Fixed with a bind
  mount instead of a symlink — `make dev-mount` (`Makefile`, new) sets it up; **run it again after
  every reboot**, a bind mount doesn't persist on its own.
- `rescanPlugins` and the `omarchy plugin enable`/`enablePlugin` IPC call do **not** pick up a
  plugin file that didn't exist on the shell's first scan, or reliably move a plugin id into
  `bar.layout` once it has — a full `omarchy-restart-shell` was required after adding the
  `bar-widget` kind, and the `bar.layout.right` placement had to be written into
  `~/.config/omarchy/shell.json` directly (`enablePlugin` returned `"ok"` without ever touching
  the file). Not a bug in this plugin.
- `Service.qml`'s existing `IpcHandler { target: "uchi" }` (from phase 1, backs
  `omarchy-shell uchi ping`) collided with a second one this phase first added to `BarWidget.qml`
  for open/close/toggle — only one `IpcHandler` can own a given target; Quickshell silently drops
  the loser with a `WARN scene` log line, not a hard error. Fixed by routing
  `BarWidget.qml`'s open/close/toggle through callback-hook properties
  (`_openPanel`/`_closePanel`/`_togglePanel`) on `Service.qml`'s existing handler instead of a
  second `IpcHandler`, the same callback-property pattern the host's own `PluginShellApi.qml`
  uses for `_summon`/`_hide`/`_toggle`.

## Verification (run these, in order)

1. `cd core && node --test` — existing suite plus the new `rpc.mjs` broadcast test.
2. `omarchy plugin validate .` — must pass against the two-kind manifest.
3. Reload the plugin (`omarchy-restart-shell`, not just `rescanPlugins` — see Live-testing
   findings above); the bar pill must appear and show state 1 or 2 correctly depending on
   whether `uchi setup` has run yet.
4. `uchi setup` (if not already done) — pill transitions to idle/active within a few seconds,
   no manual reload needed (proves `Service.qml`'s existing reconnect timer plus this phase's
   `state.get`-on-handshake wiring).
5. Open the panel; type each example prompt from `design.md`'s "Example prompts" table that
   phase 2's grammar actually supports (`desk 40`-equivalent, `front door unlock`, a bare zone
   query) — each must resolve live and run on Enter, matching `bin/uchi`'s already-proven
   behavior but through the panel now.
6. Trigger a real external capability change (physically flip a switch); within a couple of
   seconds the open panel's Recent list updates without the user doing anything — proves
   `state.changed` push → `Service.qml`'s re-fetch → Panel.qml's re-render, end to end.
7. Close the panel with unseen Recent activity, confirm the pill shows "active"; reopen it,
   confirm it drops back to "idle".
8. Type a bare zone query and press Enter; `state.get`'s `here` must reflect the pinned room on
   the next open, even after `context.set`'s `machineRoom` still points elsewhere — proves
   `room.pin` takes priority per `design.md`.

## Post-launch refinements (found only by watching Recent against a real house)

Three real gaps surfaced once Recent was actually watched against live activity, none of them
anticipated above:

- **The `a` all-off shortcut cut power to a running computer.** `capabilityId === "onoff"` on a
  Hero-room device row doesn't distinguish a light from a socket whose entire purpose is keeping
  a computer powered — a real device in this house is exactly that, named plainly enough
  ("Computer") that the risk should have been obvious before shipping the shortcut, not after.
  `a`/`allOff`/`runOffSequence` are removed from `Panel.qml` entirely, along with `Tab` (copy
  candidate to prompt) and `Shift+Tab` (switch panel) as a broader precaution while trust in this
  code is being rebuilt. `Enter` on a selected candidate is the only remaining device-affecting
  key, and it stays because it acts on one row a person explicitly navigated to or typed
  themselves — categorically different from a hotkey that scans "whatever's in this room" with no
  per-device judgment. If a bulk-off control returns, design.md's own (never implemented) `kind`
  grammar token (`light`, `son`, `temp` — an explicitly typed class of thing, not an ambient
  room scan) is the only acceptable shape for it, and it still needs its own decision about
  whether sockets/plugs belong in "light" at all.
- **Homey Groups weren't collapsing.** A Homey Group (the "Groups" app) shows up as an ordinary
  device with `driverId: "homey:virtualdrivergroup:driver"` and its member device ids in
  `settings.deviceIds` — confirmed live, undocumented in `homey-api`'s own types. Toggling a
  group cascades a capability change to every member, each logging its own Recent row alongside
  the group's — pure noise. `core/index.mjs`'s `onChange` now looks up `groupIdForMember`
  (an O(devices) scan of `settings.deviceIds` — cheap enough given onChange's real call rate) and
  drops a member's row unconditionally when it belongs to a group; the group's own row already
  represents the action. `core/homey.mjs` exports the driverId as `GROUP_DRIVER_ID`.
- **A numeric write cascades an implicit `onoff`.** Setting `dim`/`volume_set`/
  `target_temperature` above 0 on a device that's currently off flips its `onoff` too, and that
  echo wasn't in `pendingSelfWrites` (only the capability actually written was), so it read as an
  externally caused "on" and got its own Recent row next to the dim/volume/temp row that already
  covers the same action. `performWrite` now pre-registers an expected `onoff: true` self-write
  echo alongside the numeric-target one whenever this can happen, using the same 2-echo count as
  every other write (an inference from the existing `pendingSelfWrites` pattern for cascaded
  onoff, not independently re-confirmed against a live cascade specifically).
- **Recent rows carried no room, and long German compound device names + a room name overflow a
  narrow row.** `log.append`'s entries (from both `onChange` and `prompt.run`'s write result) now
  carry `zoneName` (looked up from live `devices`/`zones`, no historical fallback — an occasional
  missing zone on a renamed/removed device is an acceptable degrade); `recent.mjs` surfaces it as
  `row.zone`. `Panel.qml` renders it as a dimmed, unparenthesized suffix (`Text.StyledText`, an
  inline `<font color=...>` span) on Recent rows only — Hero/Here already group by room via their
  own section header, so a per-row zone there would be redundant. The panel's `contentWidth` grew
  from `Style.space(360)` to `Style.space(460)` to fit the combination.
- **An ambiguous match had no upper bound.** Typing a single common letter falls through to
  `matchThing`'s level-C substring match at k=1, which can hit most of a real house at once —
  `grammar.mjs`'s `ambiguous()` returned every one of them, uncapped, and `Panel.qml`'s `Repeater`
  rendered all of it with no clipping, overflowing the panel's fixed `contentHeight` well past its
  own bounds. `ambiguous()` now caps at `MAX_AMBIGUOUS_MATCHES` (20) — this doesn't change what
  `prompt.resolve` needs to do (design.md's "enough keystrokes to be unique resolves outright"
  still holds; a one-letter query was never meant to resolve, only narrow), it just stops the
  degenerate case from being a rendering hazard. Capping the match count alone wasn't enough,
  though: even a 20-row list still overflowed the card, since `bodyColumn` had no clipping or
  scroll behavior of its own — anything past the `KeyboardPanel`'s fixed `contentHeight` rendered
  outside the card border rather than being cut off or scrollable. `bodyColumn` is now wrapped in
  a `Flickable` (`clip: true`, `boundsBehavior: Flickable.StopAtBounds`), the same fix
  `omarchy.clock`'s own calendar content already uses for the same reason.
- **An externally triggered onoff+dim pair still doubled up.** The earlier `pendingSelfWrites`
  fix only covers *our own* writes cascading `dim`→`onoff` — it has nothing to do with a flow or
  the Homey app setting both `onoff` and a numeric target on one device as two separate external
  capability changes, arriving close together in either order (observed both ways: onoff-then-dim
  turning a light on to a level, dim-then-onoff turning it off). Neither event is a self-write
  echo, so `pendingSelfWrites` never sees either side. `onChange` now holds both in a per-device
  `pendingDeviceChange` record (for any device that actually has a numeric target capability — a
  plain onoff-only device, a socket or a lock, can't produce this pattern and logs immediately,
  unaffected) and decides once things settle, by transition rather than arrival order: an `onoff`
  change always wins over a coincident numeric-target one — the light turning on or off is what
  happened, the specific level it landed on is incidental — and only a numeric-target change with
  no accompanying `onoff` change logs its own level (already on, brightness adjusted). `onoff`
  resolves within the short `ONOFF_FOLD_WINDOW_MS` (500ms); see the next entry for why a
  numeric-target-only change waits longer.
- **A smooth-transition ramp logged every intermediate step.** A scene/flow fading a light over a
  few seconds sends several intermediate numeric-target values as separate external changes, each
  logging its own row. `pendingDeviceChange`'s numeric-only path (see above) now debounces over
  `DIM_TRANSITION_DEBOUNCE_MS` (5s, matching the existing `SELF_WRITE_ECHO_TIMEOUT_MS` — Recent
  isn't the primary feedback loop, so a row landing a few seconds late costs nothing real),
  reset on every new value so only the level it settles on after that long a quiet gap becomes a
  row. The debounced record keeps the *first* value in the burst as `from` (not the second-to-last
  step), since that's what the row's undo `line` targets.
- **Zone-qualified device disambiguation, previously flagged as out of scope, is now built.** The
  grammar had no way to reach one specific device when several share the exact same literal Homey
  name — a real, common naming pattern (this house has three devices literally named
  "Deckenleuchte", across Küche/Badezimmer/Flur), not a hypothetical, and one no amount of typing
  more of the name could ever resolve. `grammar.mjs`'s `resolve()` now tries a trailing zone name
  against an ambiguous device set's own zones — `resolveDevice()` is split out of `resolve()` so
  both the ordinary single-match path and this new `narrowByZone()` path reach the same word/value
  logic. Matched only against the zones the ambiguous candidates actually span, not every zone in
  the house: confirmed live that "decken fl" must narrow to Flur among {Küche, Badezimmer, Flur,
  Schlafzimmer} even though "fl" is also a substring of "Pflanzen," a zone none of these candidates
  are even in and so was never a real competing interpretation. Falls back to checking the whole
  house's zones only to return a clean "no match there" when the trailing text names a real zone
  that just isn't one of the candidates', rather than silently doing nothing; falls back further to
  the plain unqualified ambiguous list when the trailing text isn't a zone at all. Word/value
  semantics never apply to a still-ambiguous set in the existing grammar, so there's no case where
  the trailing text could mean something *other* than a zone qualifier once ambiguous — no new
  parse conflict to resolve. Order is device-then-zone only; no reverse form.
- **A match's zone was baked into `label` as plain "(Zone)" text, inconsistent with Recent's own
  dimmed zone suffix — and a resolved single device's dead end dropped the zone entirely, right
  when it stopped needing to distinguish anything.** `qualifyLabel` (now removed) built the label
  string itself; `ambiguous()` returns a separate `zone` field instead — the same field shape
  Recent rows already carry — and `deadEnd()` takes an optional `zone` argument, which
  `resolveDevice()` now always passes (the device's own zone, looked up via the `zones` parameter
  it gained). `Panel.qml`'s `rowMarkup()` renders the dimmed suffix for *any* row carrying `.zone`,
  not `entry.kind === "recent"` specifically — one style for every row kind, not a per-kind rule
  (Hero/Here rows never carry `.zone` at all, so this never fires for them, unaffected).

## After this phase

Phase 4 (Attention) is the first real consumer of the `x`/`s` keys and `row.dismiss`/
`row.snooze`/`row.mute` — those RPC methods get added then, against real rows, not speculatively
here. Phase 5 (Habits) is the same story for whatever's left of `x`. The notch/word grammar gap
(`h`/`l`, `++`/`--`) has no phase attached in `phase-2-plan.md`'s deferred list; whichever phase
picks it up should also flip `h`/`l` here from inert to real, since the panel-side wiring already
exists.

## Implementation approach

**Not a workflow/ultracode task** — `Service.qml`'s request layer, `BarWidget.qml`, and
`Panel.qml` all share one live connection and one row-rendering contract; splitting them across
agents risks the same kind of drift a shared protocol always risks. One continuous thread, same
as phases 1 and 2. A `/code-review` pass after this phase lands, same as before.

**Start in a fresh session once this plan is reviewed** — `docs/design.md`, `docs/phase-2-plan.md`
(for the now-working core/grammar shape), and this file are what a fresh session needs; it should
also read `omarchy.clock`'s, `omarchy.media`'s, and `omarchy.tailscale`'s real first-party QML
files directly (`/usr/share/omarchy/shell/plugins/...`) for the exact base-type API this plan
deliberately didn't transcribe — not the one third-party plugin installed on this machine, which
isn't a representative reference.

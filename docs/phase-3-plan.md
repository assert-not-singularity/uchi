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

Real facts confirmed against this machine's installed Omarchy shell (4.0.3-1) and the two real
plugins already present (`quickshell.spotify`, `omarchy.tailscale`), not assumed:

- `qs.Ui` provides base `BarWidget` and `Panel` QML types (`/usr/share/omarchy/shell/Ui/`) a
  plugin extends rather than building bar-pill/panel chrome from scratch. `BarWidget` exposes
  `bar`, `moduleName`, `settings`, `setting()`, `broadcast()`.
- Two real split patterns exist: `quickshell.spotify` uses three kinds (`service`, `bar-widget`,
  `panel`) as three files, with `BarWidget.qml` reaching the always-loaded `Service.qml` via
  `bar.shell.serviceFor("quickshell.spotify")`. `omarchy.tailscale` combines bar-widget+panel
  into one file. `design.md`'s own repo layout names `BarWidget.qml` and `Panel.qml` as separate
  files, so this plan follows the three-kind split, mirroring `quickshell.spotify` structurally.
- Mic-live is `Quickshell.Services.Pipewire`'s `Pipewire.defaultAudioSource`, wrapped in a real
  bar widget (`plugins/bar/widgets/Microphone.qml`) as `inUse = activeStreams.length > 0 &&
  !muted` — a Quickshell service any plugin can read directly, no cross-plugin access needed.
- Idle and media are both first-party shell services (`plugins/services/idle/Service.qml`,
  `plugins/services/media/Service.qml`), reached through `PluginFirstPartyServiceApi.qml`
  (`ownerPluginId`/`serviceId`, exposing `activePlayer`/`sourcePlayers` for media). The idle
  service itself is screensaver/lock-timer-based with a `stayAwake` override — reimplementing
  idle detection locally would duplicate real compositor-idle-protocol integration Omarchy
  already has; read it through the first-party API instead. Exact accessor call to confirm
  against `PluginFirstPartyServiceApi.qml` during implementation, not guessed here.
- `machineRoom` is **not** a live signal — `design.md`'s Config section puts it in wrapper-local
  config (this plugin's own settings, via `BarWidget`'s `setting()`), read once and on change,
  not polled from the desktop.
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
  `deviceId`/`capabilityId` to the Here device row shape (the one row-shape change this phase
  makes), so `a` becomes a client-side loop over Here's rows with `capabilityId === "onoff"`,
  sending `prompt.run("<label> off")` for each — built directly, not `row.line` (which reflects
  the device's *current* value, so an already-on row's line is `"<label> on"` and would leave it
  on if replayed). No current-value field needed: an off write to an already-off device is a
  harmless no-op. Runs in sequence, not `Promise.all` — writes serialize per capability key.
- `x`/`s` (dismiss/snooze/mute) have nothing to act on — Attention and Habits are empty arrays
  until phases 4–5. Bind the keys to no-ops (or omit them) rather than call
  `row.dismiss`/`row.snooze`/`row.mute`, which don't exist as RPC methods yet either.
- `room.pin`/`room.unpin` **are** in scope: `design.md`'s Keyboard section requires Enter on a
  bare zone-query row to pin it as Here, and that's real, reachable behavior in phase 3.

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
state-owning daemon the other two files read from — the same shape `quickshell.spotify`'s
`Service.qml` already has:

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
- Context forwarding: mic via `Pipewire.defaultAudioSource` directly (mirroring `Microphone.qml`'s
  `inUse`), idle/media via `PluginFirstPartyServiceApi.qml`. `machineRoom` is wrapper-local
  config, but its read path from `Service.qml` is **unconfirmed, not `root.setting(...)`** —
  that's a `BarWidget`-only function, and `Service.qml` is a plain `Item`. Verify the actual
  access path during implementation.
- Send an initial `context.set` right after handshake, not only on later changes — otherwise the
  core sits at its null startup defaults until something happens to change. Debounce subsequent
  changes (~250ms) so a burst collapses into one call. `context.set` never triggers the core's
  own broadcast (only writes/notifications do), so call `state.get` again immediately after every
  successful `context.set` — the same self-refresh `run`/`pinRoom`/`unpinRoom` already do.
- Exposed to `BarWidget.qml`/`Panel.qml` via `bar.shell.serviceFor("uchi")`, mirroring
  `quickshell.spotify`'s own pattern exactly — confirm the precise accessor name against that
  real file during implementation rather than guessing it here.

### `BarWidget.qml` (repo root, new)

Extends `BarWidget`. Manifest (below) gains the `bar-widget` kind and `entryPoints.barWidget`.

- Renders the five pill states directly from `uchi.connectionStatus` for the first four
  (not-set-up/unreachable/connecting/connected-with-nothing-new); "active" is `connectionStatus
  === "connected"` plus a `highestSeenTs` property (session-only, not persisted across restarts)
  compared against `uchi.state.recent[0].ts` — **`ts`, not `id`**: `core/log.mjs` mints a
  numeric id for capability rows but keeps Homey's own (non-numeric-guaranteed) id for
  notification rows, so comparing ids across row kinds can compare a number against a string.
  `ts` is a real number on every row regardless of kind, and `recent.list()` already sorts by it.
- Click toggles the panel (confirm the real toggle call — `bar.shell`'s panel-open API — against
  `quickshell.spotify`'s `BarWidget.qml`/`omarchy.tailscale`'s `Panel.qml` during implementation).
- On panel open, sets `highestSeenTs` to `uchi.state.recent[0].ts`, clearing "active" back to
  "idle".

### `Panel.qml` (repo root, new)

Extends `Panel`. Manifest gains the `panel` kind and `entryPoints.panel`.

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
- Keyboard, scoped per the gaps section above: `j`/`k` or arrows move the cursor across whichever
  list currently has focus (the live candidate list while the prompt has ambiguous matches, else
  the resting body's rows). `Enter` — a highlighted row with a `line` calls `uchi.run(line)`; a
  row that's a bare zone query (`room` present, no `line`) calls `uchi.pinRoom(room.id)` instead,
  per design.md's stated exception. `Tab` copies the highlighted row's `line` into the prompt
  without running it. `Esc` clears the prompt if it holds text, else closes the panel (likely
  free from the base `Panel` type — confirm during implementation). `a` runs the all-off loop
  from the gaps section. `h`/`l`/`x`/`s` are wired but inert per the gaps section, each logging
  once via `console.warn` rather than silently doing nothing unexplained.

### `manifest.json` (repo root, extend)

Add `"bar-widget"` and `"panel"` to `kinds`; add `entryPoints.barWidget: "BarWidget.qml"` and
`entryPoints.panel: "Panel.qml"`. Add a `barWidget` block (`displayName`, `category`,
`defaultSection`) matching the shape both real reference manifests use.

### `core/test/rpc.test.mjs` (extend)

Add a test that `broadcast()` reaches every connected socket and not a disconnected one — the
one new piece of `rpc.mjs` behavior this phase adds, exercised the same way the existing `hello`
test already connects a plain `net.Socket` client.

## Verification (run these, in order)

1. `cd core && node --test` — existing suite plus the new `rpc.mjs` broadcast test.
2. `omarchy plugin validate .` — must pass against the three-kind manifest.
3. Reload the plugin (`omarchy-shell shell rescanPlugins`); the bar pill must appear and show
   state 1 or 2 correctly depending on whether `uchi setup` has run yet.
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
also read `quickshell.spotify`'s and `omarchy.tailscale`'s real QML files directly for the exact
base-type API this plan deliberately didn't transcribe.

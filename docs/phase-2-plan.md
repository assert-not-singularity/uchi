# Uchi — Phase 2 ("Core, for real") implementation plan

## Context

Phase 1 (merged) proved the skeleton: the core connects to Homey, a Unix-socket
JSON-RPC server runs, `Service.qml` spawns/connects to it, and `bin/uchi`
round-trips a stubbed `hello`/`state.get`. Nothing in phase 1 reads real
device state or writes anything back to Homey.

Phase 2, per `docs/design.md`'s build order, is: **"`state.get` returns real
hero/Here data, verbs, log with causes, Recent (log-derived, in/out filter,
undo lines), grammar (exact/fuzzy/thing-number). `bin/uchi` gains real
commands. Tests against a recorded house fixture. Done: `uchi desk 40` works
from a terminal, `uchi status` prints the hero line."** That parenthetical —
`(exact/fuzzy/thing-number)` — is also the literal name given to
`grammar.mjs` in design.md's target repo layout, and it scopes phase 2's
grammar precisely: resolve a thing (device or zone name, exact then fuzzy)
and apply a bare number to its one obvious capability, plus the four
literal verbs `on`/`off`/`lock`/`unlock`. The full word grammar beyond
those four fixed verbs — prefix-matched words like `li`/`gr`, notches,
scale, chaining, kinds, `grp`/`ungrp` — is explicitly **not** phase 2, see
"Deferred past this phase" below.

The following facts are verified against this real Homey (110 devices, 12
zones, 9 moods) and the real `homey-api@3.20.0` source already vendored
locally, not assumed from the design doc's or the artifact's prose:

- **Manager operation names** (from `homey-api`'s own
  `assets/specifications/HomeyAPIV3Local.json`, the source its dynamic method
  generation reads): `devices.getDevices()`, `devices.getDevice({id})`,
  `devices.setCapabilityValue({deviceId, capabilityId, value})`,
  `zones.getZones()`, `zones.getZone({id})`, `moods.getMoods()`,
  `moods.setMood({id})`. `device.setCapabilityValue(capabilityId, value)`
  (the 2-arg legacy form, confirmed in `Device.js`) is the simpler per-device
  call phase 2 actually uses for verbs.
- **Device shape** (read live via `devices.getDevices()`): `id`, `name`,
  `zone` (a zone-id string — `zoneName` is confirmed live to log
  `"Device.zoneName is deprecated."` to stderr and return `undefined`, not
  just a stale doc claim), `class` (`light`, `socket`, `thermostat`,
  `speaker`, `lock`, `sensor`, `fan`, `tv`, `button`, `remote`, `bridge`,
  `other` — all seen live), `capabilities` (a flat array of capability-id
  strings), `capabilitiesObj` (a map of that same id to `{value, type,
  getable, setable, title, titleShort, lastUpdated, units}`). Real capability
  ids are **not** all clean/simple — this house alone has vendor-specific
  ones (`homematic_thermostat_boost`, `lv131sCapability`) and
  driver-namespaced ones (`measure_temperature.temperature_sensor_raspberry_pi`,
  `button.gpio0`) alongside the standard ones grammar cares about
  (`onoff`, `dim`, `target_temperature`, `volume_set`, `volume_mute`,
  `speaker_playing`, `locked`) — all of which exist on real devices in this
  house and were confirmed `getable`/`setable` as expected (e.g. `dim` is
  `setable`, type `number`, units `%`; `measure_temperature` is `getable`
  only). `grammar.mjs`'s capability-word mapping must key off exact
  known-good ids, never assume every capability id is "clean."
- **Multi-kind zones are the common case, not an edge case.** Most of this
  house's zones mix 3+ device classes — design.md's own fictional Living
  Room (lights + a Sonos speaker + a thermostat) is the norm, not a
  contrived example. This directly confirms design.md's grammar rule that
  a bare value only resolves when the thing has exactly *one* controllable
  capability — most real zones need an explicit word once words exist,
  which phase 2 doesn't implement yet (see below), so phase 2's
  bare-number form only ever targets a **device**, not a zone, until words
  land.
- **Zone shape**: `{id, name, parent, icon, active, activeLastUpdated,
  activeOrigins, sortIndex, uri}` — `parent` exists (a zone tree), unused in
  phase 2 (Here is flat, per design.md).
- **Mood shape**: `{id, name, preset, devices, zone, uri}` — `zone` is
  present, confirming moods can be filtered per-room for Here's "moods as
  chips" without a separate lookup.
- **No cause/attribution field exists on the realtime *capability* event,
  but a separate, real notification feed does carry genuine attribution for
  a narrower set of event kinds.** Read `RealtimeConsumer`/`Item.js`
  /`DeviceCapability.js` directly: a device's `'capability'` event fires
  with exactly `{capabilityId, value, transactionId, transactionTime}` —
  the same four fields the socket.io wire event carries, verified by
  tracing `onEvent` straight through to `this.emit(event, data)` with no
  enrichment anywhere in the call chain. There is no "triggered by Kitchen
  Switch" field there. Separately, `notifications.getNotifications()` (a
  real, verified operation — see below) returns entries shaped `{id,
  ownerUri, ownerName, excerpt, dateCreated, meta}`, confirmed live
  against this house: a presence entry has `ownerName: "Anwesenheit"`
  with a free-text departure/arrival message as `excerpt`, a flow-authored
  entry has `ownerName: "Flow"`, an app update has `ownerName: "Apps"`.
  This *is* real attribution, for exactly the event kinds design.md's Recent
  section separately names — "presence, notifications" — but it does not
  cover ordinary device-capability writes: a physical switch flipping a
  light does not itself create a notification entry unless a flow was
  explicitly built to log one. So the finding is narrower than "no cause
  exists" — it's "no cause exists for capability changes specifically";
  presence and Homey-authored notifications get real cause data through a
  different, verified channel, and phase 2 uses it for exactly those rows
  (`getNotifications()` in `core/homey.mjs`, `appendNotification()` in
  `core/log.mjs`, the notification row shape in `core/recent.mjs`, all
  below). Design.md's Recent examples
  showing a named cause on a *device* row (`"Kitchen Switch"`) are still
  aspirational UI copy the local API doesn't hand us for free — phase 2's
  capability-change log entries record a real `cause` only for writes *we*
  make (`"prompt"`); every externally-observed capability change still
  gets `cause: null`. This is a deliberate, documented scope decision, not
  an oversight — see "Deferred past this phase."
- **`context.set { machineRoom, ... }` is how the core learns "the
  wrapper's room," not a core-side config file.** Design.md's Config section
  puts `machineRoom` in wrapper-local config, and the rule "if two wrappers
  could disagree about it, it belongs in the core's config, not a wrapper's"
  means the core never reads a wrapper's settings file directly — it only
  ever learns `machineRoom` (and `idle`/`mic`/`media`) via the `context.set`
  RPC call the protocol already names. `bin/uchi` is a one-shot CLI with no
  desktop context to report, so it never calls `context.set`; `uchi status`
  against a core that's never received one from any wrapper shows Hero's
  aggregate-only line with no own-room section — a real, expected phase-2
  state, not a bug.

## Files to create or change

### `core/config.mjs` (extend)
Design.md's own repo-layout comment states this explicitly: "phase 2 adds
reading the separate shared core config, `~/.config/uchi/config.json`."
Add `readCoreConfig()`: reads that path (plain `fs.readFileSync`, no
`O_NOFOLLOW`/mode enforcement — unlike the credentials file, this holds no
secrets, so the phase-1-only symlink/permission hardening doesn't apply
here), parses JSON, and returns `{ notches, events, recentRows, people,
agent }` with defaults for every field so a missing or partial file (or no
file at all — this config is optional, unlike the credentials file) doesn't
throw: `{ notches: { light: 10, vol: 5, temp: 1 }, events: {}, recentRows:
20, people: {}, agent: "off" }`. Phase 2 only *consumes* `recentRows` (in
`recent.mjs`, below); `notches` is read and stored now so the notch grammar
form (`++`/`--`) has a config value to read once it's implemented, without
a second config-reading pass; `events`/`people`/`agent` are read but unused
until phases 4–6 — reading them now costs nothing and avoids a schema
migration later. The existing `readSettings()` (credentials) is untouched.

### `core/homey.mjs` (extend)
Phase 1 has `connect()` and `getDeviceCount(api)` — the latter is `Object.
keys(await api.devices.getDevices()).length`, i.e. it already fetches the
full device map just to count it. Retire `getDeviceCount` as its own
export: phase 2's `index.mjs` needs the full map anyway (for `state.get`,
subscriptions, and everything else below), so it derives the startup log's
device count from that one fetch instead of making a second, redundant
`devices.getDevices()` round trip at boot. `core/validate.mjs` (`uchi
setup`'s validator) is `getDeviceCount`'s only other caller and stays as
architected — it doesn't need the full map, so it keeps calling
`getDevices(api)` (below) and takes `Object.keys(...).length` itself
inline, a one-line change.

Add, using only the operation names verified above:

- `getDevices(api)` → `api.devices.getDevices()`, returned as-is (a map
  keyed by device id — matches what `homey-api` gives us, no
  reshaping needed for phase 2).
- `getZones(api)` → `api.zones.getZones()`, same shape convention.
- `getMoods(api)` → `api.moods.getMoods()`.
- `DISCRETE_CAPABILITIES = new Set(["onoff", "dim", "locked",
  "target_temperature", "speaker_playing", "alarm_contact", "alarm_motion",
  "volume_set", "windowcoverings_state"])` — the Uchi artifact's Recent "In"
  list is more precise than design.md's own prose summary here and is the
  one this plan follows: it explicitly names `volume_set` and
  `windowcoverings_state` alongside the ones design.md's prose already
  implied. `volume_set` exists on 10 real devices in this house (confirmed
  `setable`, above); `windowcoverings_state` exists on none of this
  house's 110 devices, so it's untestable live here but included for
  fidelity to the artifact's spec — a device that has it will work the
  same way any other discrete capability does. `measure_*`/`meter_*` ids
  are excluded by construction (they're never in this set), matching
  Recent's explicit exclusion — no separate prefix-filter needed.
- `subscribeToDiscreteChanges(devices, onChange)` — for every device, for
  every capability id in `DISCRETE_CAPABILITIES` that the device actually
  has (checked against `device.capabilities`, since most devices have none
  of these), call `device.makeCapabilityInstance(capabilityId, (value) => {
  if ((capabilityId === "alarm_contact" || capabilityId === "alarm_motion")
  && value !== true) return; onChange({ deviceId: device.id, capabilityId,
  value }) })` — design.md's Recent definition names these two specifically
  as "contact/motion **going true**," not every transition, so a contact
  closing or motion clearing is filtered out here rather than reaching the
  log at all (not filtered later in `recent.mjs`, since `log.mjs` is
  supposed to hold real changes worth keeping, not values to be
  post-filtered downstream). This is the
  verified-correct realtime mechanism from phase 1's own research
  (`makeCapabilityInstance`, not the CRUD-only `devices.connect()`), now
  actually used. Returns nothing; the instances live for the process
  lifetime (matching phase 1's core lifecycle — one core process, one
  subscription set, until idle-exit).
- `setCapabilityValue(device, capabilityId, value)` → thin wrapper over
  `device.setCapabilityValue(capabilityId, value)` (legacy 2-arg form,
  confirmed to delegate to the real write path in `Device.js`).
- `getNotifications(api)` → `api.notifications.getNotifications()`. Real,
  verified operation (`ManagerNotifications.getNotifications` in the spec)
  returning entries shaped `{id, ownerUri, ownerName, excerpt, dateCreated,
  meta}`, confirmed live against this house across presence
  (`ownerName: "Anwesenheit"`), flow (`ownerName: "Flow"`), and app
  (`ownerName: "Apps"`) owners. This is design.md's "presence,
  notifications" half of Recent's Discrete definition, verified real and
  separate from the capability-change half above.

`zones.getZone({id})`/`device.getZone()` from phase 1's research are not
directly needed in phase 2's own code paths (zones are fetched in bulk via
`getZones()` once and kept in memory), but stay documented as the correct
per-id lookup for a later phase that needs one zone freshly.

### `core/log.mjs` (new)
In-memory only in phase 2 — an array-backed ring buffer capped at 500
entries, oldest dropped first, and genuinely **append-only**: nothing
written here is ever mutated or removed except by the 500-entry cap
itself. Not persisted to disk: design.md's Habits (phase 5) is the
feature that actually needs a *durable*, multi-week log ("each of your
interactions is logged with a full house+desktop snapshot"); Recent
(this phase) only ever shows the last `recentRows` entries of the
current process's lifetime, so an in-memory buffer that resets on core
restart is sufficient and avoids designing a durable log format twice.
Revisit this file when phase 5 actually needs persistence.

- `append(entry)` — a capability entry is `{ ts, kind: "capability",
  deviceId, deviceName, capabilityId, from, to, cause }`. `deviceName` is
  a snapshot of the device's name *at append time*, not a live
  reference — `recent.mjs` renders rows from log entries alone and is
  never handed a device map, so the name has to travel with the entry;
  if a device is later renamed, older Recent rows keep showing the name
  it had when the change happened, which is the correct behavior for a
  log, not a bug to fix. `cause` is `"prompt"` when the write went
  through `prompt.run` (see `rpc.mjs` below) and `null` for everything
  observed via `subscribeToDiscreteChanges` that we didn't just cause
  ourselves. `append` silently drops (does not append) an entry whose
  `from === to` — a write that lands on the value it already had is not
  a transition, and this guard is what actually makes a redundant prompt
  write (e.g. dimming a light already at 40% to 40%) produce no Recent
  row, not a side effect of the echo/bounce handling below.

  Two independent kinds of realtime noise are also filtered before an
  incoming capability change is appended, both confirmed against a real
  house, not assumed — but *filtered from being appended in the first
  place*, which is different from removing something already in the log
  (the log stays append-only either way; these two never make it in):
  - **The self-write echo.** A write we make arrives back over the
    realtime capability event — confirmed live: `setCapabilityValue`
    triggered the subscribed listener **twice** with the same value, not
    once, so this isn't a rare double-fire to special-case but the
    expected shape of every self-caused write. Skip any incoming event
    whose `(deviceId, capabilityId, value)` exactly matches the log's most
    recent entry for that pair within the last 2 seconds.
  - **The bounce.** Per the Uchi artifact's Recent "Out" list explicitly
    ("a value changing back within two seconds, which is a bounce, not a
    change") — a capability going `A → B → A` within 2 seconds is a
    flicker, not two real changes. Held in a short-lived pending buffer
    (keyed by `deviceId`+`capabilityId`, separate from the log itself,
    holding at most one entry per pair for up to 2 seconds) rather than
    appended immediately: `A → B` is only committed to the log once 2
    seconds pass without a `B → A` arriving; if `B → A` does arrive
    inside that window, the pending `A → B` is discarded and neither half
    is ever appended. This costs Recent up to a 2-second display delay
    for genuinely new capability changes, which is the honest trade for
    never appending-then-un-appending — an append-only log can't
    implement "remove the pending entry" (that's a mutation), so the
    only way to keep both the bounce rule and the append-only contract
    is to decide *before* appending, not after.
- `appendNotification(entry)` — same buffer, `kind: "notification"`
  (`{ ts, kind: "notification", id, ownerName, excerpt }`). Deduping by
  `id` against only the last 500 buffered entries isn't enough on its
  own: once a notification is evicted from that bounded ring by 500
  newer capability entries, `getNotifications()` will still return its
  `id` on every future poll (it's Homey's own persistent notification,
  not a live-only event), and the ring no longer remembers having seen
  it — so the same notification would get re-appended, and re-shown as
  a "new" Recent row, forever. `log.mjs` therefore also keeps a separate,
  *unbounded-within-the-process* `Set` of every notification `id` it has
  ever appended, checked instead of scanning the ring, so eviction from
  the display buffer never causes a re-append.
- `tail(n)` — the last `n` entries of either kind, newest first.

### `core/recent.mjs` (new)
Derives Recent rows from `log.mjs`'s buffer, per design.md's Recent
section, reading `recentRows` from `readCoreConfig()` for how many rows to
return:

- One row per log entry (no mood/flow-fold grouping yet — folding requires
  knowing *which* entries share a mood/flow cause, and phase 2 has no
  mood/flow attribution at all per the cause-tracking limitation above;
  fold-grouping is meaningful only once that exists, so it's deferred to
  whichever phase actually wires up mood/flow triggering).
- A `kind: "capability"` row: `{ id, kind, label, why, line }` — `label`
  is the entry's own `deviceName` (a snapshot from `log.mjs`, not a
  live device-map lookup — `recent.mjs` needs no `devices` argument at
  all), `why` is a plain rendering of the transition (`"→ on"`, `"dimmed
  to 40%"`, `"locked"`) built from `capabilityId`/`from`/`to`, plus
  `"(you)"` appended when `cause` is `"prompt"` (design.md's "in/out
  filter" — the closest honest rendering of in/out attribution phase 2's
  data actually supports for this row kind; the row exposes this as text
  in `why`, not as a separate `cause` field, so a caller checks for the
  `"(you)"` substring, not a schema field, when it needs to tell the two
  apart).

  `line` is the grammar line that undoes the change, but only for a
  `capabilityId` phase 2's own grammar can actually execute — `onoff`
  (`"<device name> off"`/`"<device name> on"`) and `locked`
  (`"<device name> unlock"`/`"<device name> lock"`) are verbs the
  grammar recognizes; `dim`/`target_temperature`/`volume_set` are the
  three bare-number targets it recognizes, so their undo line is
  `"<device name> <from-value>"`. Every other member of
  `DISCRETE_CAPABILITIES` — `speaker_playing` (`setable`, but phase 2's
  grammar has no play/pause verb), `alarm_contact`/`alarm_motion`
  (`getable`-only, not writable at all), `windowcoverings_state` (no verb
  or value form for it yet) — gets `line` omitted, same as the
  already-documented `null`-`from` case, because a line `prompt.run`
  would reject on submission is worse than no line: this list is exactly
  the complement of `grammar.mjs`'s own recognized verbs/targets below,
  so extending grammar's coverage automatically extends which
  capabilities get a real undo line, with no separate list to keep in
  sync by hand.
- A `kind: "notification"` row: `{ id, kind, label, why }` — `label` is
  the entry's real `ownerName` (`"Anwesenheit"`, `"Flow"`, `"Apps"`),
  `why` is its `excerpt` verbatim. No `line`: a notification isn't a
  device state to revert, it's a fact that happened, matching design.md's
  own doorbell example ("a doorbell is simply the newest change...
  carrying `haustür unlock` instead" — an *event-table* line, which is
  `events` in `readCoreConfig()`, not something derived from the
  notification text itself; phase 2 doesn't implement the event-table
  lookup, so a notification row is line-less until whichever phase wires
  `events` up).

### `core/grammar.mjs` (new)
Exactly what design.md's repo layout names it: an exact/fuzzy/thing-number
parser, nothing wider yet.

- `resolve(text, { devices, zones })` — the `prompt.resolve` implementation.
  Splits `text` into `thing` and `rest` (first whitespace-delimited token(s)
  forming a name, greedily matched against device/zone names before falling
  back token-by-token — device/zone names are unpredictable-length, e.g.
  "Kitchen Switch"). Thing matching order, per design.md's resolution order:
  1. **Exact** — case-insensitive full match against every device and zone
     `name`.
  2. **Fuzzy** — case-insensitive substring/prefix match; unique match
     resolves outright, multiple matches become `matches: [...]` candidates
     (each `{ label, why }`, no `line` yet since the value/word half isn't
     resolved), zero matches is a dead end (`matches: []`).
  3. Verbs (`on`, `off`, `lock`, `unlock`) — recognized as `rest` for a
     device whose `capabilitiesObj[capabilityId]` is both present *and*
     `setable` (`onoff` for on/off, `locked` for lock/unlock) — checking
     `capabilities`' presence alone isn't enough: Homey's own shape
     distinguishes `getable` from `setable`, and a capability can be
     present and readable without being writable, so a read-only device
     would otherwise resolve here and only fail later, inside
     `prompt.run`, instead of failing resolution up front the way an
     unmatched thing already does. Anything else in `rest` is parsed as a
     bare number.
  4. A bare number in `rest` resolves only if the matched thing is a
     **device** (not a zone — see the multi-kind-zone finding above) whose
     `capabilitiesObj` has exactly one `setable` entry among
     `dim`/`target_temperature`/`volume_set` (checked in that order; a
     device is never expected to have more than one in phase 2's real
     data, but the order is deterministic either way) — the same
     `setable` check as verbs, for the same reason. Zero or
     more-than-one such capability is a dead end with `why: "needs a
     word"` — the real word grammar (design.md's full word list) is
     deferred, so this phase can name the problem but not solve every
     case; it's still strictly better than silently guessing wrong.
- `run(line, { devices, zones, setCapabilityValue })` — the `prompt.run`
  implementation: re-resolves `line` via `resolve()`; if it resolves to
  exactly one device+verb/value, reads the capability's current value from
  `devices` as `from` *before* writing (the realtime subscription's own
  self-write-echo is deliberately suppressed in `log.mjs`, so this is the
  only place `from` is ever captured for a prompt-caused change), then
  `await`s `setCapabilityValue` (it's async — `device.setCapabilityValue`
  is a real network call to Homey, so a slow or rejected write must not be
  reported as success) and returns `{ ok: true, change: { deviceId,
  capabilityId, from, to } }` only once that await resolves; a rejection
  is caught and returned as `{ ok: false, error: <message> }`, not thrown
  past `run()`. `rpc.mjs`'s `prompt.run` handler (below) only calls
  `log.append(...)`, with `result.change` plus `cause: "prompt"`, after
  `run()` itself has resolved with `{ ok: true }` — a write that failed or
  hasn't finished yet has nothing to log.
  Ambiguous or no match returns `{ ok: false, matches }` (`bin/uchi`
  prints the candidates and exits non-zero, per design.md's
  one-shot-caller behavior) without calling `setCapabilityValue` at all.

No `?` (list applicable words), no chaining (`,`/`;`), no exclusions
(`-thing`), no join (`thing+thing`), no kinds (`son`/`light`/`temp` as a
`thing`), no notches/scale — all explicitly out of scope, see "Deferred
past this phase."

### `core/here.mjs` (new)
`compute(zoneId, { devices, zones, moods })` → `{ id, name, moods: [...],
devices: [...] }` or `null` if `zoneId` is `null` (no `machineRoom` known
yet, per the `context.set` finding above). `moods` filters the mood map by
`mood.zone === zoneId`. `devices` filters to `device.zone === zoneId`
**and** at least one `setable` capability among
`onoff`/`dim`/`locked`/`target_temperature`/`volume_set` — design.md's
Here section says "controllable devices," not every device in the zone,
and the fixture makes the distinction concrete: Kitchen has 5 lights plus
a Kitchen Switch (a physical remote, design.md's own description of it),
and a remote has no setable capability of its own to control — it
triggers flows, it isn't controlled directly — so filtering on
`setable` correctly returns the 5 lights `here.test.mjs` (below) expects,
not 6. Each surviving device is rendered as `{ id, label, why, line }`
matching the row contract every section uses (`why` here is just the
device's current primary value, e.g. `"40%"`/`"on"`; `line` is the same
undo-style line `recent.mjs` builds for a re-apply, reusing that
formatting logic — factor the shared from-value → line renderer into
`grammar.mjs` so `here.mjs` and `recent.mjs` don't duplicate it, and
apply `recent.mjs`'s same rule of omitting `line` for a capability
grammar can't write).

### `core/index.mjs` (extend)
The existing `try { const api = await connect(settings); deviceCount =
await getDeviceCount(api); } catch { ...; process.exit(69); }` block
becomes `const api = await connect(settings); const devices =
await homey.getDevices(api);` in that same try (per the retired-
`getDeviceCount` decision above) — a fetch failure here is still exactly
the "Homey unreachable" case that existing block's `exit(69)` handles, so
`zones`/`moods` are fetched in the same try right alongside `devices`,
not after it: any of the three failing means Homey isn't fully available,
the same condition the current code already detects for one of them.
`deviceCount` for the startup log line becomes `Object.keys(devices)
.length`.

After that block (where phase 1's `console.log("Connected to Homey —
...")` already sits): call `subscribeToDiscreteChanges` **once**, against
the device map from that startup fetch, wiring each change into
`log.append(...)` (with a fresh-value dedupe check against the device's
last-known value so the *first* fetch's already-current values don't get
logged as "changes" the instant subscriptions start), and hold
`devices`/`zones`/`moods` plus an in-memory `context` object (`{
machineRoom: null, idle: null, mic: null, media: null }`, updated only by
`context.set`) in variables the `methods` table's closures below can
read. Device/zone/mood maps are refreshed by re-fetching on each
`state.get` call rather than kept live-updated from CRUD events — phase 2
has no device-added/removed test scenario to justify the extra complexity
of consuming `Manager`'s own `.create`/`.update`/`.delete` events; a
per-call refetch is one extra HTTP round trip and correctness now, revisit
only if `state.get` latency becomes a real problem. This deliberately
means the *subscriptions* stay pinned to whatever devices existed at
startup even though the *maps* `state.get` reads are always fresh: a
device added after the core started would show up in `here`/grammar
(next `state.get`, real data) but never generate a Recent row (no
subscription was ever created for it), and a device removed or replaced
leaves a harmlessly-inert listener. This is the direct, previously-
undocumented consequence of the "refetch don't resubscribe" choice above,
not a new decision — phase 2 doesn't attempt to reconcile subscriptions
against topology changes; a core restart (already the standard recovery
path for a settings change, per phase 1) picks up any added/removed
device.

Also start a `setInterval(..., 30_000)` polling `homey.getNotifications(api)`.
The very first poll only *seeds* `log.mjs`'s seen-notification-id set from
whatever `getNotifications()` already returns — it does not call
`appendNotification` for any of them. Homey's notification list is
real, persistent history (this house alone has 250 real entries going
back weeks), not a live-only feed, so appending everything already
present on first connect would flood Recent with pre-core history in
one shot, directly contradicting Recent's own "current process lifetime"
scope stated for `log.mjs` above. Only entries whose `id` isn't in the
seen set are appended from the *second* poll onward — i.e., only
notifications that are new since the core started. Each poll (including
the first) is wrapped so a rejected `getNotifications()` call is caught
and logged via `console.error`, not left to reject an unhandled interval
callback — a transient failure skips that one poll and the next
scheduled one retries; it must not be able to take the whole core down,
unlike the startup fetch's `exit(69)`, which is appropriate only for the
one-time initial connection check. No realtime "notification created"
push was found or verified in `homey-api`'s exposed surface (unlike
capability changes, which genuinely are push-based), so polling is the
honest approach here, not a shortcut; 30s balances staleness against
hammering the API for a row kind that's inherently lower-frequency than
capability changes. This is a deliberate, narrow exception to design.md's
"Explicitly decided against: Polling — replaced by `homey-api` realtime
events" — that decision is about *capability* state, which stays fully
push-based and unchanged here; notifications are a different data source
with no push mechanism this research found, and get this one exception
rather than being dropped from Recent's scope entirely (design.md itself
lists "notifications" as in-scope Discrete content).

### `core/rpc.mjs` (no structural change)
Untouched — phase 1 already factored dispatch as a plain `{method:
handler}` table passed in from `index.mjs`; phase 2 just grows that table
in `index.mjs`:

- `state.get` → real `{ hero, recent, attention: [], here, habits: [] }`.
  Both `hero.room` and the top-level `here` are the *same*
  `here.mjs`-computed value (`compute(context.machineRoom, ...)`) —
  design.md's protocol names `here` as its own top-level field alongside
  `hero`, not a field nested only inside `hero`, so `state.get`'s handler
  computes it once and assigns it to both places rather than defining it
  in only one and leaving the other `undefined`. `hero.summary` is built
  from the same `devices`/`zones` maps: count of devices with
  `onoff===true` or `dim>0`, sum of `measure_power` values across all
  `capabilitiesObj` entries (Watts, confirmed present in this house).
  Active-mood count is **not** part of phase 2's summary: the verified
  mood shape has no `active` flag, and nothing in phase 2 calls
  `moods.setMood` (mood activation is deferred, see below) — tracking
  "moods activated since core startup" would track an event that can
  never happen yet, which is worse than just not claiming the metric.
  `recent` is `recent.mjs`'s `list()`. `attention`/`habits` stay the
  literal empty arrays from phase 1 (unchanged — those are phases 4/5).
- `context.set` → merges the given fields into the in-memory `context`
  object; no response body needed beyond `{}` (design.md lists no `result`
  shape for it).
- `prompt.resolve` → `grammar.resolve(params.text, { devices, zones })`.
- `prompt.run` → `await`s `grammar.run(params.line, { devices, zones,
  setCapabilityValue: (device, capId, value) =>
  homey.setCapabilityValue(device, capId, value) })`; on `{ ok: true,
  change }`, calls `log.append({ ts: Date.now(), kind: "capability",
  deviceId: change.deviceId, deviceName: devices[change.deviceId].name,
  capabilityId: change.capabilityId, from: change.from, to: change.to,
  cause: "prompt" })` and returns `{ ok: true }` to the caller; on `{ ok:
  false, ... }`, skips `log.append` entirely and returns the failure
  as-is. The append happens here, at the call site that *knows* it's a
  prompt-caused write and has the real `from`/`to` pair `run()` captured,
  not inside `homey.mjs`'s thin wrapper, keeping the cause-tagging logic
  in one place next to the only thing that can honestly claim it.

No `row.dismiss`/`row.snooze`/`row.mute`/`room.pin`/`room.unpin` yet —
those act on Attention/Habits rows and Here's pin state, none of which
exist as anything other than an empty array or context-driven read in this
phase; adding the RPC methods now with nothing real for them to do would
be surface area with no caller. `bin/uchi` (below) and any future Panel.qml
are the only realistic callers, and neither needs them until Attention/
Habits/pinning are themselves real.

### `bin/uchi` (extend)
Add: any invocation that isn't `setup` or `rpc` is treated as a prompt
line — `bin/uchi desk 40` joins `argv.slice(2)` with spaces and sends it as
`prompt.run { line }`. On `{ ok: true }`, exit 0 silently (matching a
successful command-line tool's convention); on `{ ok: false, matches }`
with `matches.length > 1`, print each candidate's `label`/`why` and exit 1;
with zero matches, print "no match for '<line>'" and exit 1 — this is the
one-shot disambiguation behavior design.md's `prompt.resolve` section
specifies for a non-interactive caller. Add `uchi status`: calls
`state.get`, prints `hero.summary`, and if `hero.room` is non-null, the
room's name and its devices' `why` values — this is literally "prints the
hero line," phase 2's second done-criterion, verbatim.

### `core/test/fixture.mjs` (new)
The exact fictional house from `docs/design.md`'s "Example prompts"
section, reused verbatim per that section's own note ("worth reusing again
for the recorded-house test fixture — every device named anywhere in this
document is declared here, so the fixture is reproducible on its own"):
Kitchen (5 lights, Kitchen Switch), Living Room (4 lights incl. Floor Lamp,
TV, Sonos speaker, thermostat, Sofa Switch), Office (Desk Lamp, Sonos
speaker, desktop machine as a metered plug, space heater as a metered plug,
Do Not Disturb switch), Bedroom (Bedside Lamp, window contact, thermostat),
Hallway (motion sensor, Front Door lock), Bathroom (no devices). Moods:
Movie Night, Morning, Bedtime. Shaped exactly as `devices`/`zones`/`moods`
maps matching the real shapes verified above (`capabilities`/
`capabilitiesObj` per device, `zone` per device and mood), plus a small
`notifications` array shaped like real `getNotifications()` entries (one
`ownerName: "Anwesenheit"` presence entry, one `ownerName: "Flow"` entry)
for `recent.mjs`'s notification-row tests, so
`grammar.mjs`/`recent.mjs`/`here.mjs` can be tested against it with no
network and no real Homey — this is what makes those modules unit-testable
the same way phase 1 made `rpc.mjs` unit-testable against a plain dispatch
table.

### `core/test/grammar.test.mjs`, `core/test/recent.test.mjs`, `core/test/here.test.mjs` (new)
Against `fixture.mjs`, `node --test`:
- Grammar: `"desk 40"` resolves to the Desk Lamp with value 40 (design.md's
  own first example row); `"kitchen+office"`-style joins are **not**
  tested since chaining/join is out of phase 2's scope — instead assert
  that a query naming a multi-kind zone (Living Room: lights + speaker +
  thermostat) with a bare number returns the "needs a word" dead end, not
  a guess; assert `"front door"` resolves to the Front Door lock uniquely.
- Recent: appending a log entry and reading it back renders the expected
  `why`/`line`; a `cause: "prompt"` entry's `why` includes the `"(you)"`
  marker and a `cause: null` entry's doesn't; the 2-second echo-dedupe
  actually suppresses a duplicate; an `A → B → A` bounce within 2 seconds
  leaves no row at all (not two, not one net-wrong one); a
  `kind: "notification"` entry renders as `{label: ownerName, why:
  excerpt}` with no `line`; appending the same notification `id` twice
  (simulating a re-poll) doesn't duplicate the row.
- Here: `compute(null, ...)` returns `null`; `compute(<Kitchen's zone id>,
  ...)` returns Kitchen's 5 lights and no moods (none of the three fixture
  moods are zoned to Kitchen).

## Verification (run these, in order)

1. `cd core && node --test` — all of phase 1's existing test plus the three
   new suites above, against the fixture, no real Homey needed.
2. `bin/uchi status` against the real core (already running per phase 1's
   verification) — must print the aggregate summary line; with no
   `context.set` ever sent (true for a bare CLI session), `hero.room` is
   `null` and no room section prints — expected, not a failure.
3. `bin/uchi desk` — replace "desk" with the name of one real dimmable
   light in this house — followed by a target percentage, e.g. `bin/uchi
   "<light name>" 40` — must actually change that light's brightness;
   confirm visually or via `bin/uchi rpc state.get '{}'`'s `here`/`recent`
   fields on a subsequent call (once `context.set` has been sent by some
   client — `bin/uchi rpc context.set '{"machineRoom":"<zone id>"}'` first)
   showing the new value and a Recent row whose `why` ends in `"(you)"`
   (the row schema doesn't expose a raw `cause` field — see `recent.mjs`
   above — so this is the correct observable, not `cause: "prompt"`).
4. Physically flip a real switch/remote in the house (or use the Homey app)
   for a device with a capability in `DISCRETE_CAPABILITIES`; within a few
   seconds, `bin/uchi rpc state.get '{}'`'s `recent` must show that change
   with `cause: null` (no "(you)" marker) — this is the concrete proof the
   realtime subscription and the cause-tracking limitation both work as
   documented, not just in theory.
5. Leave the core running long enough to notice a real presence change
   (someone arriving/leaving) or any other real Homey notification; within
   30s, `bin/uchi rpc state.get '{}'`'s `recent` must show a
   `kind: "notification"` row with the real `ownerName`/`excerpt` from
   Homey's own timeline — proof `getNotifications()` polling and
   dedupe-by-id both work against real data, not just the fixture.
6. `omarchy plugin validate .` and `node --check` on every new `.mjs` file
   — no QML changes are needed this phase (`Service.qml` already spawns/
   connects; it doesn't need to know `state.get` grew real fields).

## Deferred past this phase

- **Cause attribution for externally-triggered *capability* changes**
  specifically (`cause: null` for anything not our own `prompt.run`) —
  this is narrower than "no attribution at all": presence and Homey
  notifications *do* get real attribution this phase, via
  `getNotifications()` (see Context above). What's still missing is a
  cause for an ordinary device write like "Kitchen Switch turned off the
  kitchen lights" — no mechanism for that was found in `homey-api`'s
  exposed surface; revisit if a future Homey API version exposes one, or
  if correlating a notification's `dateCreated` against a capability
  change's `transactionTime` within a tight window turns out to be
  reliable enough for the specific case of a flow-authored notification
  that happens to name the devices it touched (untested; the notification
  `excerpt` is free text, not a structured device reference, so this is
  speculative, not a confirmed path). Not blocking: design.md's own
  examples treat cause as descriptive flavor, not something anything
  downstream depends on structurally.
- **The rest of the grammar**: words beyond bare-number targeting (`li`/
  `gr`/etc. prefixes), notches (`++`/`--`) and scale (`*2`/`/2`) — though
  `notches` config is already read, unused — chaining (`,`/`;`), exclusion
  (`-thing`) and join (`thing+thing`), kinds as a `thing` (`son`/`light`/
  `temp`), `?` candidate listing, `grp`/`ungrp` (needs Homey's flow-card
  action mechanism, confirmed real in phase 1's research but not wired to
  anything yet). Each of these is a grammar.mjs addition on top of the
  same exact/fuzzy/thing-number core this phase ships — no rework
  expected, just growth.
- **Mood/flow activation and Recent's fold-under-mood/flow grouping** —
  `moods.setMood({id})`/`flow.triggerFlow({id})` are confirmed real
  operation names (this phase's research) but nothing calls them yet;
  folding Recent rows under a mood/flow needs to know *which* rows a
  mood/flow caused, which needs at least mood/flow activation to exist
  first.
- **Durable, cross-restart logging** — needed for Habits (phase 5), not
  Recent (this phase). `log.mjs`'s in-memory ring buffer is the right
  scope for now; don't build persistence speculatively.
- **CRUD-event-driven live device/zone/mood maps, and reconciling
  capability subscriptions against topology changes** — re-fetching maps
  per `state.get` call is phase 2's deliberate choice, and capability
  subscriptions stay pinned to the device set from startup (see
  `core/index.mjs` above): a device added after the core starts is
  visible in `here`/grammar but never produces a Recent row, and a core
  restart is the documented recovery path, not something phase 2
  reconciles live. Only revisit either if it's measurably a real problem
  against a real house.
- **Attention and Habits** — stay the literal empty arrays/null from phase
  1. Phases 4 and 5 respectively.

## Implementation approach

**Not a workflow/ultracode task**, same reasoning as phase 1: `grammar.mjs`,
`here.mjs`, and `recent.mjs` all share the row-shape contract
(`{id, label, why, line}`) and the same fixture, and `rpc.mjs`'s dispatch
table in `index.mjs` wires all of them together — small file count, tightly
coupled, better as one continuous thread than fanned out. A `/code-review`
pass after this phase lands is the right point to bring in a second set of
eyes, same as phase 1.

**Start in a fresh session once this plan is reviewed** — `docs/design.md`,
`docs/phase-1-plan.md` (for the now-working core/RPC/QML shape), and this
file are all a fresh session needs; "implement phase 2 per
`docs/phase-2-plan.md`" is a complete prompt.

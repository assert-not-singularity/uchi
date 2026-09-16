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
  only). **`units: "%"` is a display hint, not the actual value range** —
  checked directly on every real `dim` and `volume_set` capability in
  this house: all read `min: 0, max: 1`, genuinely normalized, not 0–100.
  `target_temperature` was checked the same way and is real degrees
  (`min: 4, max: 35`). See `core/homey.mjs`'s `PERCENT_CAPABILITIES`
  below for the conversion this requires — without it, `uchi desk 40`
  (this phase's own literal done-criterion) sends `40` where Homey
  expects `0.4`. `grammar.mjs`'s capability-word mapping must key off exact
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
- **Presence is a per-user field on `users.getUsers()`, not a separate
  manager call.** `presence.getPresent()` exists in the spec but needs a
  per-user `id` (checked live: calling it with none throws "Missing
  Parameter: id") — but `users.getUsers()` already returns each user as
  `{id, name, present, asleep, ...}` directly, confirmed live against
  this house's real users. Hero's "presence" component (design.md: the
  hero's second line is "presence, active moods, total draw") needs
  nothing beyond this one `getUsers()` fetch — no separate presence
  manager call, no per-user round trip.
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
- `getUsers(api)` → `api.users.getUsers()`, returned as-is — used for
  Hero's presence line, per the verified fact above.
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
  of these), call `device.makeCapabilityInstance(capabilityId, (value) =>
  onChange({ deviceId: device.id, capabilityId, value }))`. `onChange`
  fires for **every** value, including an `alarm_contact`/`alarm_motion`
  transition to `false` — design.md's Recent definition wants only
  "going true" transitions to become Recent rows, but that filtering
  happens in `core/index.mjs`'s handler (below), not here, because
  `index.mjs` also maintains a last-known-value cache off this same
  callback that has to see *every* event to stay correct — a version of
  this function that silently dropped `false` transitions before calling
  `onChange` would leave that cache stuck on a stale `true`, and the
  *next* real `false → true` transition would then look like a no-op
  (`from === to`) against the stale cache and get lost. `homey.mjs` stays
  a thin, policy-free wrapper over the real Homey API; deciding which
  events become Recent rows is `index.mjs`'s job, once, in the one place
  that already needs to see everything. This is the verified-correct
  realtime mechanism from phase 1's own research (`makeCapabilityInstance`,
  not the CRUD-only `devices.connect()`), now actually used. Returns
  nothing; the instances live for the process lifetime (matching phase
  1's core lifecycle — one core process, one subscription set, until
  idle-exit).
- `setCapabilityValue(device, capabilityId, value)` → thin wrapper over
  `device.setCapabilityValue(capabilityId, value)` (legacy 2-arg form,
  confirmed to delegate to the real write path in `Device.js`). Takes
  and returns the raw Homey value — the percent↔normalized conversion
  below happens in the caller, not here, keeping this wrapper a pure
  pass-through.
- `PERCENT_CAPABILITIES = new Set(["dim", "volume_set"])` with
  `toHomeyValue(capabilityId, percent)` (`percent / 100`) and
  `toPercent(capabilityId, homeyValue)` (`Math.round(homeyValue * 100)`)
  for the two in that set, identity for everything else. Verified live
  against this house, not assumed from the `units: "%"` hint alone: every
  real `dim` and `volume_set` capability read has `min: 0, max: 1` —
  `units: "%"` is purely a *display* hint, the actual stored/written
  value is normalized 0–1. `target_temperature` was checked the same way
  and is genuinely real degrees (`min: 4, max: 35` on this house's real
  thermostats) — it is **not** in `PERCENT_CAPABILITIES` and needs no
  conversion, matching design.md's own `"arb temp 21"` example taking a
  literal degree value. Getting this wrong is exactly how `uchi desk 40`
  — phase 2's own literal done-criterion — would fail or clamp to full
  brightness instead of dimming to 40%: without this conversion, `40` is
  sent directly where Homey expects `0.4`.
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

- `append(entry)` — a capability entry is `{ id, ts, kind: "capability",
  deviceId, deviceName, capabilityId, from, to, cause }`. `id` is a
  process-local counter `log.mjs` mints and assigns here — a capability
  entry has no natural id of its own (a device/capability/timestamp
  triple isn't guaranteed unique against rapid repeated writes) — while
  a notification entry (below) keeps Homey's own real `id` unchanged
  through `appendNotification`, never reminted: that real id is also
  what `seedNotificationIds`/the seen-`Set` dedupe against, so replacing
  it here would disconnect the row's own id from the dedupe key that
  refers to the same notification. `recent.mjs` copies whichever id is
  already on the entry — minted or real — straight onto the row it
  renders, uniformly; only the *source* of the id differs by entry kind,
  not how `recent.mjs` handles it. `deviceName` is
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
  row, not a side effect of the bounce handling below.

  (The self-write echo — confirmed live: `setCapabilityValue` triggers
  the subscribed realtime listener **twice** with the same value, not
  once — is *not* handled here. It's detected in `core/index.mjs`,
  before `log.append` is ever called for that event, against a registry
  of writes-in-flight rather than against the log's own tail; see
  `core/index.mjs` below for why matching against "the log's most recent
  entry" specifically doesn't work.)

  One further kind of realtime noise *is* filtered here, inside
  `append` itself, confirmed against a real house: **the bounce**. Per
  the Uchi artifact's Recent "Out" list explicitly ("a value changing
  back within two seconds, which is a bounce, not a change") — a
  capability going `A → B → A` within 2 seconds is a flicker, not two
  real changes. Held in a short-lived pending slot (keyed by
  `deviceId`+`capabilityId`, separate from the log itself, holding at
  most one *uncommitted* transition per pair) rather than appended
  immediately, with a 2-second timer per pending slot that commits it if
  nothing else arrives first. On each incoming transition `P → Q` for a
  key with no pending slot: start one holding `P → Q` and its timer. For
  a key that already has a pending `X → Y` slot: if `Q === X` (the value
  is reverting to what the pending transition started from), it's a
  bounce — cancel the timer, discard the pending slot, append nothing
  for either half. Otherwise (`Q !== X` — a *further*, distinct change,
  not a reversion of the pending one) the pending `X → Y` is no longer
  in question — commit it to the log immediately, cancel its timer, and
  start a new pending slot holding `Y → Q` with its own fresh timer. This
  is what correctly handles three changes in quick succession
  (`A → B → C`, neither step a reversion of the other): `A → B` commits
  the moment `C` arrives (since `C ≠ A`), and `B → C` becomes the new
  pending slot, rather than the naive one-slot version silently
  overwriting `A → B` and never appending it, or applying the bounce
  window to a transition that was never actually reverted. Bounce
  detection only ever compares an incoming value against the single most
  recent *pending* transition's origin — it does not scan further back
  through already-committed history, matching the artifact's own
  two-value framing ("a value changing back") rather than a general
  cycle detector. This costs Recent up to a 2-second display delay for
  the *last* transition in any such run, which is the honest trade for
  never appending-then-un-appending — an append-only log can't implement
  "remove an already-appended entry" (that's a mutation), so the only way
  to keep both the bounce rule and the append-only contract is to decide
  each transition's fate *before* appending it, not after.
- `appendNotification(entry)` — same buffer, `kind: "notification"`
  (`{ ts, kind: "notification", id, ownerName, excerpt }`, `id` real and
  Homey's own). Deduping by `id` against only the last 500 buffered
  entries isn't enough on its own: once a notification is evicted from
  that bounded ring by 500 newer capability entries, `getNotifications()`
  will still return its `id` on every future poll (it's Homey's own
  persistent notification, not a live-only event), and the ring no
  longer remembers having seen it — so the same notification would get
  re-appended, and re-shown as a "new" Recent row, forever. `log.mjs`
  therefore also keeps a separate, *unbounded-within-the-process* `Set`
  of every notification `id` it has ever appended, checked instead of
  scanning the ring, so eviction from the display buffer never causes a
  re-append.
- `seedNotificationIds(ids)` — adds every id in `ids` to that same seen
  set *without* appending anything. This is the explicit, named
  operation `core/index.mjs`'s first notification poll needs (below): it
  establishes "these already existed before the core started" as a
  baseline, and `appendNotification` alone can't express "mark as seen,
  but don't create a row" — that's a second, distinct operation on the
  same seen set, not a special-cased call to the first one.
- `tail(n)` — the last `n` entries of either kind, newest first.

### `core/recent.mjs` (new)
Derives Recent rows from `log.mjs`'s buffer, per design.md's Recent
section. `list(entries, recentRows)` takes both the log entries *and* the
row limit as plain arguments — it never calls `readCoreConfig()` itself.
`core/index.mjs` reads the config once and passes `recentRows` in, the
same way it already passes `devices`/`zones` to everything else that
needs them; if `recent.mjs` read config directly, `core/test/recent.test.mjs`
(below) would depend on whatever `~/.config/uchi/config.json` happens to
contain on the machine running the tests — a `recentRows: 0` there would
silently break the fixture-only tests. Dependency injection here isn't
extra ceremony, it's what makes "tested against a recorded house fixture,
no real Homey" (this phase's own stated goal) actually true for this file:

- One row per log entry (no mood/flow-fold grouping yet — folding requires
  knowing *which* entries share a mood/flow cause, and phase 2 has no
  mood/flow attribution at all per the cause-tracking limitation above;
  fold-grouping is meaningful only once that exists, so it's deferred to
  whichever phase actually wires up mood/flow triggering).
- A `kind: "capability"` row: `{ id, kind, label, why, line }` — `label`
  is the entry's own `deviceName` (a snapshot from `log.mjs`, not a
  live device-map lookup — `recent.mjs` needs no `devices` argument at
  all), `why` is a plain rendering of the transition (`"→ on"`, `"dimmed
  to 40%"`, `"locked"`) built from `capabilityId`/`from`/`to` — for
  `dim`/`volume_set` specifically, `from`/`to` are converted through
  `homey.mjs`'s `toPercent()` before rendering, since the log stores
  Homey's real normalized `0–1` value (see `core/homey.mjs` above), and
  "dimmed to 0.4" would be wrong to show a user who thinks in percent —
  plus `"(you)"` appended when `cause` is `"prompt"` (design.md's "in/out
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
  `"<device name> <from-value>"` — again `toPercent()`-converted for
  `dim`/`volume_set`, since the grammar line is meant to be typed back
  in and the grammar only ever accepts percent input for those two, per
  `core/homey.mjs` above. Every other member of
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
  "Kitchen Switch"). This is a two-stage process, not five independent
  branches tried in order: stage one (exact, then fuzzy) finds the
  **thing** — a specific device or zone, or gives up — and stage two
  decides what `rest` (if anything) means for *that* thing. An earlier
  draft of this plan wrote stages one and two as one flat numbered list
  and said a unique match at stage one "resolves outright," which reads
  as stage two being unreachable; to be unambiguous, stage one only ever
  identifies *which* device/zone `text` refers to (or that it's
  ambiguous, or that it's nothing) — it does not by itself produce
  `resolve()`'s final return value:
  1. **Exact** — case-insensitive full match against every device and zone
     `name`. A *unique* exact match identifies the thing; more than one
     device/zone sharing a name (nothing stops two devices being named
     identically) makes stage one itself ambiguous and `resolve()`
     returns `matches: [...]` candidates immediately, exactly like an
     ambiguous fuzzy match does — exactness is about the string match
     quality, not a promise of uniqueness, so this step must not silently
     pick one via whatever order `Object.values(devices)` happens to
     iterate in.
  2. **Fuzzy** — case-insensitive substring/prefix match, tried only if
     stage one found nothing; a unique match identifies the thing the
     same way exact does, multiple matches return `matches: [...]`
     candidates (each `{ label, why }`, no `line` yet since stage two
     never ran), zero matches is a dead end (`matches: []`).

  Once stage one has identified exactly one thing, stage two looks at
  `rest`:
  3. **A zone thing with empty `rest`** — design.md's grammar explicitly
     supports a bare zone query ("`office` — a bare zone query — lists
     the Office's devices"), and `prompt.resolve`'s protocol shape
     already carries a `room?` field for exactly this, so phase 2 returns
     `{ room: { id: zoneId, name: zone.name } }` — the name travels with
     the id because `bin/uchi` (below) has no zone map of its own to look
     one up in; `resolve()` already has `zones` in scope, so it's the one
     place that can cheaply attach it. No `line`: design.md is explicit
     that a bare zone row has none ("**Enter** pins it as Here via
     `room.pin`," not `prompt.run`) — phase 2 doesn't implement
     `room.pin` (see `rpc.mjs` below), so `{ room }` is as far as this
     goes; a wrapper or `bin/uchi` that doesn't yet call `room.pin` can
     still show the zone was recognized.
  4. Verbs (`on`, `off`, `lock`, `unlock`) — recognized as `rest` for a
     device whose `capabilitiesObj[capabilityId]` is both present *and*
     `setable` (`onoff` for on/off, `locked` for lock/unlock) — checking
     `capabilities`' presence alone isn't enough: Homey's own shape
     distinguishes `getable` from `setable`, and a capability can be
     present and readable without being writable, so a read-only device
     would otherwise resolve here and only fail later, inside
     `prompt.run`, instead of failing resolution up front the way an
     unmatched thing already does. Anything else in `rest` is parsed as a
     bare number.
  5. A bare number in `rest` resolves only if the matched thing is a
     **device** (not a zone — see the multi-kind-zone finding above) whose
     `capabilitiesObj` has exactly one `setable` entry among
     `dim`/`target_temperature`/`volume_set` (checked in that order; a
     device is never expected to have more than one in phase 2's real
     data, but the order is deterministic either way) — the same
     `setable` check as verbs, for the same reason. The parsed number is
     treated as a **percent** for `dim`/`volume_set` and converted via
     `homey.toHomeyValue()` before it's used for anything — resolving
     against the *converted* value, not the raw typed number, since a
     dim capability's real range is `0–1` (see `core/homey.mjs` above);
     `target_temperature` is used as-is, already real degrees. Zero or
     more-than-one such capability is a dead end with `why: "needs a
     word"` — the real word grammar (design.md's full word list) is
     deferred, so this phase can name the problem but not solve every
     case; it's still strictly better than silently guessing wrong.
- `run(line, { devices, zones, setCapabilityValue })` — the `prompt.run`
  implementation: re-resolves `line` via `resolve()`; if it resolves to
  exactly one device+verb/value, `await`s `setCapabilityValue(device,
  capabilityId, homeyValue)` — the already-percent-converted value from
  `resolve()`, so `setCapabilityValue`'s caller (`core/index.mjs`, not
  this file) never has to know which capabilities are percent-displayed.
  `setCapabilityValue` here is **not** `core/homey.mjs`'s thin wrapper of
  the same name directly — `rpc.mjs` passes in `index.mjs`'s serialized
  write function (below), which performs the real write *and* returns
  `{ deviceId, deviceName, capabilityId, from, to }` itself, reading
  `from` (and `deviceName`) from its own live state rather than
  `grammar.mjs` reading either from the `devices` snapshot: `devices` is
  only refreshed by `state.get` (see `core/index.mjs` above), so a second
  `prompt.run` shortly after a first one — two CLI invocations back to
  back, nothing unusual — would otherwise capture a stale `from` against
  `resolve()`'s `devices` argument, and `state.get` replacing the whole
  `devices` object while a write is still in flight would otherwise make
  a post-write `devices[deviceId]` lookup unreliable. `run()` forwards
  whatever the write function returns as `{ ok: true, change: {
  deviceId, deviceName, capabilityId, from, to } }` once the write
  settles; a rejection is caught and returned as `{ ok: false, error:
  <message> }`,
  not thrown past `run()`. `rpc.mjs`'s `prompt.run` handler (below) only
  calls `log.append(...)`, with `result.change` plus `cause: "prompt"`,
  after `run()` itself has resolved with `{ ok: true }` — a write that
  failed or hasn't finished yet has nothing to log.
  Ambiguous or no match returns `{ ok: false, matches }` (`bin/uchi`
  prints the candidates and exits non-zero, per design.md's
  one-shot-caller behavior) without calling `setCapabilityValue` at all.
  A bare-room match (`{ room }`, no device/verb/value) also returns `{
  ok: false, room }` from `run()` without writing anything — running a
  room query on `Enter` isn't a write, and `bin/uchi` (below) reports it
  distinctly from a real failure.

No `?` (list applicable words), no chaining (`,`/`;`), no exclusions
(`-thing`), no join (`thing+thing`), no kinds (`son`/`light`/`temp` as a
`thing`), no notches/scale — all explicitly out of scope, see "Deferred
past this phase."

### `core/here.mjs` (new)
`compute(zoneId, { devices, zones, moods })` → `{ id, name, moods: [...],
devices: [...] }` or `null` if `zoneId` is `null` **or** `zones[zoneId]`
doesn't exist — `context.machineRoom` is set once by `context.set` and
held as-is (see `core/index.mjs` above) while `zones` itself is
refetched on every `state.get`, so a zone deleted or renamed between
those two events would otherwise reach `compute()` as a real-looking id
for a zone that's no longer there; treating an unknown id exactly like
`null` (no room, aggregate-only Hero) is the same "degrade gracefully"
behavior already specified for the no-context case, not a new one, and
avoids `compute()` crashing every subsequent `state.get` on a stale
context value it never asked to be told about again. `moods` filters the
mood map by `mood.zone === zoneId`. `devices` filters to `device.zone
=== zoneId` **and** at least one `setable` capability among
`onoff`/`dim`/`locked`/`target_temperature`/`volume_set` — design.md's
Here section says "controllable devices," not every device in the zone,
and the fixture makes the distinction concrete: Kitchen has 5 lights plus
a Kitchen Switch (a physical remote, design.md's own description of it),
and a remote has no setable capability of its own to control — it
triggers flows, it isn't controlled directly — so filtering on
`setable` correctly returns the 5 lights `here.test.mjs` (below) expects,
not 6.

Each surviving device is rendered as `{ id, label, why, line }` matching
the row contract every section uses. A device can have more than one of
the five controllable capabilities at once — an ordinary light has both
`onoff` and `dim` — so `why`/`line` pick the **first capability that is
both present *and* `setable`** in a fixed priority order, `dim` >
`target_temperature` > `volume_set` > `onoff` > `locked`: checking
presence alone isn't enough, the same reasoning as `grammar.mjs`'s
`setable` check above — a device could in principle have a read-only
`dim` (reporting brightness without controlling it) alongside a genuinely
`setable` `onoff`, and presence-only selection would then choose the one
capability that can't actually be written, producing a `line` `prompt.run`
would reject. The zone-level `setable` filter above only guarantees *some*
capability among the five is controllable, not that it's the
highest-priority one present, so this second, per-capability `setable`
check is a distinct, necessary step, not a restatement of the first. The
priority order itself is the same one `grammar.mjs`'s bare-number step
already checks value-bearing capabilities in, with `onoff`/`locked`
appended after as the two verb-only fallbacks for a device with none of
the three value targets. `why` is that capability's current value,
`toPercent()`-converted for `dim`/`volume_set` (e.g. `"40%"`), plain for
`target_temperature` (e.g. `"21°"`), and `"on"`/`"off"`/`"locked"`/
`"unlocked"` for the boolean pair; `line` is the same undo-style line
`recent.mjs` builds for a re-apply of that one chosen capability, reusing
that formatting logic — factor the shared from-value → line renderer
into `grammar.mjs` so `here.mjs` and `recent.mjs` don't duplicate it, and
apply `recent.mjs`'s same rule of omitting `line` for a capability
grammar can't write (moot here in practice, since all five capabilities
in the priority order above are ones `grammar.mjs` can write, by
construction — they're the same five, not a coincidence).

### `core/index.mjs` (extend)
The existing `try { const api = await connect(settings); deviceCount =
await getDeviceCount(api); } catch { ...; process.exit(69); }` declares
`api`/`deviceCount` with `const` scoped to that `try` block — fine in
phase 1, where nothing outside the block ever reads them again. Phase 2
does: notification polling needs `api`, and the subscription/write
machinery below needs `devices`. So `api`, `devices`, `zones`, `moods`,
and `users` are declared with `let` *before* the `try` (initialized to
`undefined`, standard for a value a `try` is about to assign), and the
`try` body simply assigns them — `api = await connect(settings); devices
= await homey.getDevices(api);` and so on — rather than re-declaring them
with `const` inside it. A fetch failure here is still exactly the "Homey
unreachable" case that existing block's `exit(69)` handles, so
`zones`/`moods`/`users` are fetched in the same try right alongside
`devices`, not after it: any of the four failing means Homey isn't fully
available, the same condition the current code already detects for one
of them. `deviceCount` for the startup log line becomes `Object.keys(
devices).length`.

After that block (where phase 1's `console.log("Connected to Homey —
...")` already sits): build `currentValue`, a plain `Map` keyed by
`` `${deviceId}:${capabilityId}` ``, seeded from the startup `devices`
fetch's own `capabilitiesObj` values for every capability in
`DISCRETE_CAPABILITIES`. This one cache is what fixes three related gaps
at once, all stemming from the same root cause — relying on the
`devices` snapshot (refreshed only by `state.get`) for a value that
needs to be current *between* `state.get` calls:

- Call `subscribeToDiscreteChanges` **once**, against the device map
  from that startup fetch. Its `onChange` callback **first**
  unconditionally sets `currentValue` for that pair to the new value —
  before any filtering — and only *then* decides whether to log
  anything. Updating the cache before filtering, not after, is what
  keeps a later `alarm_contact`/`alarm_motion` "going true" comparison
  correct: filtering `false` transitions out of `onChange`'s *logging*
  behavior must not also filter them out of what the cache remembers,
  or a `true → false → true` sequence would see the second `true` as a
  no-op against a cache stuck on the first `true`, and lose a real
  Recent row.
- The callback checks a `pendingSelfWrites` `Map` (same key shape)
  *before* deciding to log: an entry there is `{ value, remaining, timer
  }` — `remaining` starts at `2` (confirmed live: `setCapabilityValue`
  triggers this callback **twice** with the same value, not once, so
  this isn't a rare double-fire to special-case but the expected shape
  of every self-caused write). On a matching event (same key, same
  value), decrement `remaining`; drop the event either way (it's an
  echo), and only delete the pending entry once `remaining` reaches `0`
  — deleting it after the *first* matching echo, as an earlier draft of
  this plan did, leaves the *second* echo with nothing to match against,
  and it would be logged as an external change. `timer` is a fallback:
  a few seconds after the entry is created, delete it regardless of
  `remaining`, in case fewer than two echoes ever arrive for some reason
  — a stale entry that never gets deleted would incorrectly swallow a
  later *genuine* external write to the same value. This registry, not
  "the log's most recent entry" (an earlier draft of this plan), is what
  self-write detection matches against, because the echo can arrive
  before `rpc.mjs` has even called `log.append` for the prompt-caused
  write — matching against the log's tail is racy exactly in that
  window; matching against a registry populated *before* the write is
  issued (below) isn't.
- Only once both of those pass does the callback apply the
  `alarm_contact`/`alarm_motion` "going true" filter (design.md wants
  only `value === true` transitions as Recent rows for these two, not
  every transition) and call `log.append(...)` with a fresh-value dedupe
  against `currentValue`'s *prior* value for that pair, so the first
  fetch's already-current values don't get logged as "changes" the
  instant subscriptions start.

The serialized write function — what `rpc.mjs` passes to `grammar.run`
as `setCapabilityValue` (see `core/grammar.mjs` above) — is defined here
too, since it's the other thing that needs `currentValue`: `write(device,
capabilityId, homeyValue)` keeps one promise chain per
`` `${device.id}:${capabilityId}` `` key (a plain `Map` of the tail
promise for each key so far) — a second call for the same pair is
chained onto `previousTail.catch(() => {}).then(...)`, not
`previousTail.then(...)` directly: chaining straight onto the previous
promise means a *rejected* previous write (a real, expected outcome —
Homey can reject a write) poisons the chain permanently, since `.then`
without a rejection handler propagates the rejection forward forever,
and every later write to that same capability would reject without ever
running, until a core restart. Swallowing the previous result with
`.catch(() => {})` before chaining the next call is what keeps one
transient failure from taking down every future write to that key,
while queued calls still run in submission order rather than
concurrently, so two quick writes to the same capability still can't
interleave or both capture the same stale `from`.

Once it's this call's turn: if `currentValue` has no entry yet for this
key — a device that didn't exist at startup, made visible only through a
later `state.get` refetch, per the topology-change limitation below —
seed one from `device.capabilitiesObj[capabilityId].value` (the value
already sitting on the resolved device object `write()` was called
with) before reading anything, rather than reading `from` as `undefined`
for a device this cache was never told about. Then: reads `from` from
`currentValue`, sets `pendingSelfWrites` for that key (per the two-echo
registry above), `await`s `homey.setCapabilityValue(device,
capabilityId, homeyValue)`, updates `currentValue` to the new value
immediately on success (not waiting for the realtime echo, so a same-key
write issued right after this one still sees the right `from`), and
returns `{ deviceId: device.id, deviceName: device.name, capabilityId,
from, to: homeyValue }` — `deviceName` comes
from the `device` object `write()` was called with, captured here rather
than by `rpc.mjs` reading `devices[change.deviceId].name` after the
`await` returns: `state.get` can replace the whole `devices` map object
while this write is in flight, so a lookup against `devices` *after*
awaiting reads whatever the variable currently points to, not
necessarily the map this call started against — reading `device.name`
directly off the already-resolved object handed to `write()` has no such
window. A rejected `homey.setCapabilityValue` call clears the pending
entry it set (so a failed write doesn't leave a phantom echo expectation
behind) and rethrows, for `grammar.run` to catch (see above).

`devices`/`zones`/`moods`/`users` plus an in-memory `context` object (`{
machineRoom: null, idle: null, mic: null, media: null }`, updated only by
`context.set`) are held in variables the `methods` table's closures below
can read. Device/zone/mood/user maps are refreshed by re-fetching on each
`state.get` call rather than kept live-updated from CRUD events — phase 2
has no device-added/removed test scenario to justify the extra complexity
of consuming `Manager`'s own `.create`/`.update`/`.delete` events; a
per-call refetch is one extra HTTP round trip and correctness now, revisit
only if `state.get` latency becomes a real problem. This deliberately
means the *subscriptions* (and `currentValue`'s key set) stay pinned to
whatever devices existed at startup even though the *maps* `state.get`
reads are always fresh: a device added after the core started would show
up in `here`/grammar (next `state.get`, real data) but never generate a
Recent row (no subscription was ever created for it), and a device
removed or replaced leaves a harmlessly-inert listener. This is the
direct, previously-undocumented consequence of the "refetch don't
resubscribe" choice above, not a new decision — phase 2 doesn't attempt
to reconcile subscriptions against topology changes; a core restart
(already the standard recovery path for a settings change, per phase 1)
picks up any added/removed device.

Notification polling: call `homey.getNotifications(api)` **once,
immediately** (not inside the interval) right after the block above.
Only once that call *succeeds* does its result seed
`log.seedNotificationIds(...)` (never `appendNotification` — Homey's
notification list is real, persistent history, this house alone has 250
real entries going back weeks, not a live-only feed, so appending
everything already present on first connect would flood Recent with
pre-core history in one shot) and does `setInterval(..., 30_000)` start,
polling the same `getNotifications(api)` on a repeat and appending only
entries whose `id` isn't already in the seen set. If the immediate seed
call *fails*, it does not fall through to starting the interval with an
empty seen set — that would make the interval's first successful poll
treat the *entire* real notification history as new, exactly the flood
the seed step exists to prevent. Instead it retries itself every 5
seconds (its own short interval, separate from and replaced by the real
30s one once it succeeds) until a `getNotifications()` call finally
succeeds, then proceeds to seed and start the real interval as above. Doing the first
poll immediately and outside the interval, rather than letting
`setInterval` fire its first callback after the usual 30-second delay,
matters because `setInterval` genuinely doesn't run its callback until
the interval elapses: a notification created in that gap between "core
started" and "first interval fire" would otherwise get folded into the
*baseline* seed instead of being correctly treated as new. Every poll
from the real 30s interval onward is wrapped so a rejected
`getNotifications()` call is caught and logged via `console.error`, not
left to reject an unhandled interval callback — a transient failure
skips that one poll and the next scheduled one retries; it must not be
able to take the whole core down, unlike the startup fetch's `exit(69)`,
which is appropriate only for the one-time initial connection check. No
realtime "notification created" push was found or verified in
`homey-api`'s exposed surface (unlike capability changes, which
genuinely are push-based), so polling is the honest approach here, not a
shortcut; 30s balances staleness against hammering the API for a row
kind that's inherently lower-frequency than capability changes. This is
a deliberate, narrow exception to design.md's "Explicitly decided
against: Polling — replaced by `homey-api` realtime events" — that
decision is about *capability* state, which stays fully push-based and
unchanged here; notifications are a different data source with no push
mechanism this research found, and get this one exception rather than
being dropped from Recent's scope entirely (design.md itself lists
"notifications" as in-scope Discrete content).

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
  in only one and leaving the other `undefined`. `hero.summary` covers
  two of design.md's three named components ("presence, active moods,
  total draw") — presence and total draw — built from `devices`/`users`:
  the names of every user with `present === true` from `homey.getUsers()`
  (design.md's own Friday-evening example names presence generically,
  "someone else in the household is home," not by name — showing real
  names in the summary is this plan's own choice, since `getUsers()`
  gives real names to work with; nothing in design.md requires it be
  anonymized), and separately, count of devices considered "active" — `onoff
  === true` when the device has an `onoff` capability at all (regardless
  of `dim`'s value: a light switched off but still holding a nonzero
  `dim` level from before — the normal state after an `onoff`-only "off"
  command, since turning a light off doesn't reset its remembered
  brightness — is off, full stop); `dim > 0` only for a device that has
  `dim` but no `onoff` to check instead — plus the sum of `measure_power`
  values across all `capabilitiesObj` entries (Watts, confirmed present
  in this house), together as the "total draw" component. Active-mood
  count, design.md's third named component, is **not** part of phase 2's
  summary: the verified
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
  setCapabilityValue: write })` — `write` is `core/index.mjs`'s
  serialized write function (above), not `core/homey.mjs`'s thin wrapper
  directly, since it's the one that owns `currentValue` and
  `pendingSelfWrites` and can honestly report `{ deviceId, deviceName,
  capabilityId, from, to }` without touching `devices` again after the
  write settles. On `{ ok: true, change }`, calls `log.append({ kind:
  "capability", ...change, cause: "prompt" })` (`ts`/`id` assigned by
  `log.append` itself; `change` already has every other field `append`
  needs, spread as-is) and returns `{ ok: true }` to the caller; on `{
  ok: false, room }` (a bare zone query, not a write) or `{ ok: false,
  matches }` or `{ ok: false, error }`, skips `log.append` entirely and
  returns the result as-is. The append happens here, at the call site
  that *knows* it's a prompt-caused write and has the real `from`/`to`
  pair `run()` captured,
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
Add `uchi status` (below) and `uchi setup`/`uchi rpc` (phase 1, unchanged)
as named subcommands, checked *before* anything else. Only once none of
those three match is the invocation treated as a prompt line — `bin/uchi
desk 40` joins `argv.slice(2)` with spaces and sends it as `prompt.run {
line }`. Checking the named subcommands first, not last, is what a
"anything that isn't `setup` or `rpc`" catch-all (an earlier draft of
this plan) gets wrong: `status` isn't `setup` or `rpc` either, so that
phrasing would send the literal text `"status"` to `prompt.run` instead
of ever reaching the `uchi status` handling described below. On `{ ok:
true }`, exit 0 silently (matching a
successful command-line tool's convention). On failure, `prompt.run` can
come back three different shapes (per `core/grammar.mjs`'s `run()`
above), checked in this order — checking `matches.length` first, before
confirming `matches` is even the field present, is what an earlier draft
of this plan did and is exactly the bug: a real write failure has no
`matches` at all, so reaching straight for `.length` on it would throw or
misreport:
- `{ error }` — the write itself failed (Homey rejected it, or the
  request errored): print `error` and exit 1.
- `{ room }` — a bare zone query, not a failure to disambiguate: print
  `room.name` (the name travels with the id from `resolve()`, per
  `core/grammar.mjs` above — `bin/uchi` has no zone map of its own to
  look one up in otherwise) and exit 0 — this is a successful room-query
  result quietly not being a device write, not an error state.
- `{ matches }` — ambiguous or no match: `matches.length > 1` prints each
  candidate's `label`/`why` and exits 1; zero matches prints "no match
  for '<line>'" and exits 1 — the one-shot disambiguation behavior
  design.md's `prompt.resolve` section specifies for a non-interactive
  caller.

Add `uchi status`: calls `state.get`, prints `hero.summary`, and if
`hero.room` is non-null, the room's name and its devices' `why` values —
this is literally "prints the hero line," phase 2's second done-criterion,
verbatim.

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
for `recent.mjs`'s notification-row tests, and a small `users` array
(two fictional users, one `present: true` one `present: false`) shaped
like real `users.getUsers()` entries for `hero.summary`'s presence-line
test, so
`grammar.mjs`/`recent.mjs`/`here.mjs` can be tested against it with no
network and no real Homey — this is what makes those modules unit-testable
the same way phase 1 made `rpc.mjs` unit-testable against a plain dispatch
table.

### `core/test/grammar.test.mjs`, `core/test/recent.test.mjs`, `core/test/here.test.mjs` (new)
Against `fixture.mjs`, `node --test`:
- Grammar: `"desk 40"` resolves to the Desk Lamp with a *converted*
  target of `0.4` (design.md's own first example row, plus the
  percent→normalized conversion this plan adds — asserting the raw
  resolved value, not just that it resolves at all, is what would have
  caught the original percent/normalized gap); `"kitchen+office"`-style
  joins are **not** tested since chaining/join is out of phase 2's scope
  — instead assert that a query naming a multi-kind zone (Living Room:
  lights + speaker + thermostat) with a bare number returns the "needs a
  word" dead end, not a guess; assert `"front door"` resolves to the
  Front Door lock uniquely; assert a bare `"office"` (no verb/value)
  resolves to `{ room: { id: <Office's zone id>, name: "Office" } }`;
  assert two fixture entries
  sharing an exact name (added to the fixture specifically for this
  case) resolve as ambiguous `matches`, not an arbitrary pick.
- Recent: appending a log entry and reading it back renders the expected
  `why`/`line`, including the `dim`/`volume_set` percent-conversion (a
  raw `0.4` entry renders `"40%"`, not `"0.4%"` or `"0.4"`); a
  `cause: "prompt"` entry's `why` includes the `"(you)"` marker and a
  `cause: null` entry's doesn't; an `A → B → A` bounce within 2 seconds
  leaves no row at all (not two, not one net-wrong one); a
  `kind: "notification"` entry renders as `{label: ownerName, why:
  excerpt}` with no `line`; appending the same notification `id` twice
  (simulating a re-poll) doesn't duplicate the row; `seedNotificationIds`
  followed by `appendNotification` for one of those same ids appends
  nothing. (The self-write-echo registry and the serialized `write()`
  function live in `core/index.mjs`, not `log.mjs`/`recent.mjs`, so
  they're exercised by the live verification steps below, not a fixture
  unit test — there's no realtime Homey connection in a fixture-only
  test to echo anything back.)
- Here: `compute(null, ...)` returns `null`; `compute(<an unknown zone
  id>, ...)` also returns `null` (the stale-context guard); `compute(
  <Kitchen's zone id>, ...)` returns Kitchen's 5 lights and no moods
  (none of the three fixture moods are zoned to Kitchen); a fixture
  device with both `onoff` and `dim` renders `why`/`line` from `dim`,
  matching the documented priority order.

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
   in a row whose `why` does **not** end in `"(you)"` (again, the row
   schema has no raw `cause` field to check directly) — this is the
   concrete proof the realtime subscription and the cause-tracking
   limitation both work as documented, not just in theory.
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

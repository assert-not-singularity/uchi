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
from a terminal, `uchi status` prints the hero line."** "Real hero ... data"
here means real presence and total draw, not literally all three of
design.md's named `hero.summary` components — active-mood count is
explicitly out of scope this phase (see `rpc.mjs`'s `state.get` below and
"Deferred past this phase"), since the verified mood shape has no `active`
flag to read one from. Phase 2's own literal done-criterion is `uchi
status` printing the hero line, not every named component being present
in it, so this is a scope decision within that criterion, not a shortfall
against it. That parenthetical —
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
  getable, setable, title, titleShort, lastUpdated, units, min, max}` —
  `min`/`max` are only present on a numeric capability, `undefined` on a
  boolean one like `onoff`/`locked`, and are exactly the fields the
  bare-number range check below reads, so the fixture (below) must
  record real `min`/`max` values on its numeric capabilities, not just
  the fields already needed for percent-conversion). Real capability
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
here) wrapped in a `try`/`catch` that treats an `ENOENT` specifically as
"no file, use every default" — `readFileSync` throws `ENOENT` rather
than returning anything for a missing path, so without this catch a
fresh install with no config file yet (the common case: this config is
optional, unlike the credentials file `readSettings()` requires) would
throw at startup instead of falling back to defaults. Any other read
error (e.g. a permissions problem) still propagates rather than being
silently swallowed as if it were a missing file. On success, `JSON.
parse`s the contents, then treats the parsed result as "no usable
config, use every default" — the same fallback `ENOENT` gets — unless
it's a plain object: `JSON.parse("null")` (or a bare number, string, or
array — all syntactically valid JSON) succeeds and returns exactly that,
not an object, so reading `parsed.notches` off it would throw a
`TypeError` even though nothing about that file was actually malformed.
Checking `parsed !== null && typeof parsed === "object" &&
!Array.isArray(parsed)` before reading any field is what keeps a
syntactically valid but structurally empty config file from crashing
startup the same way a missing file must not. With that check passed
(or defaults applied without it), returns `{ notches, events,
recentRows, people, agent }` with defaults for every field so a missing
or partial file doesn't throw: `{ notches: { light: 10, vol: 5, temp: 1
}, events: {}, recentRows: 20, people: {}, agent: "off" }`. `notches` is
merged one level deep — `{ ...defaults.notches, ...(parsed.notches ??
{}) }` — not replaced
wholesale, so a file that sets only `notches.light` still gets the real
defaults for `notches.vol`/`notches.temp` instead of leaving them
`undefined`; every other top-level field (`agent`, `people`, `events`)
has no nested shape phase 2 reads into, so a plain top-level default is
enough for those. `recentRows` gets one more check beyond a plain
default, since it's the one field phase 2 actually uses as a number
(below): normalized to a finite non-negative integer, capped at 500,
falling back to the default `20` for anything else — `Array.prototype.
slice`'s own permissiveness is the reason this matters, not a
hypothetical: `entries.slice(0, recentRows)` with a config value of
`-1` returns all but the last entry rather than none, and a non-numeric
value like a stray string is silently coerced by the comparison this
normalization replaces, so a malformed config could otherwise bypass
the row limit entirely instead of falling back to a sane default. Phase
2 only *consumes* `recentRows` (in `recent.mjs`, below); `notches` is
read and stored now so the notch grammar
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
`devices.getDevices()` round trip at boot.

### `core/validate.mjs` (extend)
`getDeviceCount`'s only other caller (`uchi setup`'s validator) — listed
here as its own file, not folded silently into the `homey.mjs` bullet
above, since retiring `getDeviceCount` as an export means every one of
its callers is a required call site, not an optional cleanup. Stays
architected as it already is — it doesn't need the full device map,
just the count — so it keeps calling `getDevices(api)` (above) and takes
`Object.keys(...).length` itself inline where it currently calls
`getDeviceCount(api)`, a one-line change.

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
  the raw Homey value — the percent↔normalized conversion happens in
  the caller, not here, keeping this wrapper a pure pass-through — and
  its resolved return value isn't relied on for anything: this is an
  acknowledgment/success signal, not confirmed to echo back whatever
  value Homey actually applied (unverified either way; not something
  this research confirmed), so treating it as "the applied value" would
  itself be an unverified assumption. `write()` (below) uses the
  *requested* value for `to`/`currentValue` instead, an accepted
  approximation for the five capabilities phase 2 writes — each already
  passes `grammar.mjs`'s own `min`/`max` range check before `write()` is
  ever called, so silent clamping is not expected for a request this
  process already validated as in-range; a capability that quietly
  rounds or steps a value beyond that would still show a real, if
  slightly imprecise, `to` in Recent rather than a fabricated one.
- `PERCENT_CAPABILITIES = new Set(["dim", "volume_set"])` with
  `toHomeyValue(capabilityId, percent)` (`percent / 100`) for the two in
  that set, identity for everything else. Verified live against this
  house, not assumed from the `units: "%"` hint alone: every real `dim`
  and `volume_set` capability read has `min: 0, max: 1` — `units: "%"`
  is purely a *display* hint, the actual stored/written value is
  normalized 0–1. `target_temperature` was checked the same way and is
  genuinely real degrees (`min: 4, max: 35` on this house's real
  thermostats) — it is **not** in `PERCENT_CAPABILITIES` and needs no
  conversion, matching design.md's own `"living temp 21"` example (its
  example-prompts table: "Living Room's thermostat target becomes 21°")
  taking a literal degree value — that example itself uses the `temp`
  word, part of the full word grammar phase 2 doesn't implement (see
  "Deferred past this phase"), cited here only for the literal-degree
  convention, not as something phase 2's own bare-number form executes.
  Getting the degrees-vs-percent distinction wrong is exactly how `uchi
  desk 40`
  — phase 2's own literal done-criterion — would fail or clamp to full
  brightness instead of dimming to 40%: without this conversion, `40` is
  sent directly where Homey expects `0.4`.

  `toPercent()` comes in two variants, not one, because rounding is
  appropriate for one caller and actively wrong for the other:
  `toDisplayPercent(capabilityId, homeyValue)` (`Math.round(homeyValue *
  100)`) is for `why` text a human reads (`"dimmed to 40%"`) — whole
  percent is the right amount of precision there. `toLinePercent(
  capabilityId, homeyValue)` (`Math.round(homeyValue * 1000) / 10`, one
  decimal place) is for a `line` meant to be re-executed as an undo:
  rounding a real value like `0.405` to the nearest whole percent gives
  `41`, and running `<device> 41` writes back `0.41`, not the original
  `0.405` — a real precision loss for something specifically promising
  to *undo* a change. One decimal place doesn't make the round-trip
  perfectly exact either (percent-of-a-0–1-range is lossy in general),
  but it's a real, deliberate improvement over whole-percent for exactly
  the one use case (`line`) where the loss is user-visible as "the undo
  didn't fully undo," not just a rounding hair `why`'s prose never
  exposes.
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
  deviceId, deviceName, capabilityId, from, to, cause }`. `append` always
  assigns `ts: Date.now()` itself — every capability entry is appended
  the moment `core/index.mjs` decides it's worth keeping, whether that's
  a real transition observed via `subscribeToDiscreteChanges` (`ts` is
  the instant the realtime callback fires, as close to the actual event
  as this process ever observes it) or a `prompt.run`-caused write (see
  `rpc.mjs` below), where `ts` is stamped once `write()`'s own `await`
  resolves — the moment *this process* learns the write succeeded, not
  necessarily the exact moment Homey applied it, since a slow write's
  completion can lag its real effect by however long that call took.
  There's no delayed or buffered path *within* `log.mjs`/`index.mjs`
  itself that would need a caller-supplied `ts` to correct for, but a
  genuinely slow prompt write is still an accepted, narrow best-effort
  limitation for Recent's ordering: nothing
  in this API surface tells this process exactly when Homey applied a
  write it made, only when the confirmation came back, so a slow write's
  row can appear after a fast external event that actually happened
  later in real time. `id` is a process-local counter `log.mjs` mints
  and assigns here — a capability
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
  row. This dedupe is specific to `append`'s own capability-entry shape
  and never runs for `appendNotification` (below): a notification entry
  has no `from`/`to` fields at all, so if the two functions shared this
  check, every notification would satisfy `from === to` as `undefined
  === undefined` and get silently dropped — `append` and
  `appendNotification` push to the same underlying buffer but are two
  separate functions with two separate entry-acceptance rules, not one
  function branching on `kind`.

  `log.mjs` itself is otherwise a plain buffer: the self-write echo
  check and the `alarm_contact`/`alarm_motion` "going true" filter are
  both realtime-event policy — deciding whether a given raw transition
  is noise at all, before it ever becomes a candidate `append` call —
  and both live in `core/index.mjs`'s `onChange` handler (below), which
  is the one place that sees every raw transition for a key in order;
  `append` only ever receives entries `index.mjs` has already decided
  are worth keeping.
- `appendNotification(entry)` — same buffer, `kind: "notification"`
  (`{ ts, kind: "notification", id, ownerName, excerpt }`, `id` real and
  Homey's own; `ts` is `Date.parse(entry.dateCreated)` — Homey's own
  `dateCreated` string converted once here into the same
  milliseconds-since-epoch shape a capability entry's `ts` already uses,
  not a raw `dateCreated` string field kept alongside it, and not the
  poll time the caller happened to observe it at — `recent.mjs`'s
  `list()` (below) sorts every entry, of either kind, by `ts`, so a
  notification's position in Recent has to reflect when Homey says it
  was actually created, not when this process's poll interval happened
  to notice it. Deduping by `id` against only the last 500 buffered
  entries isn't enough on its own: once a notification is evicted from
  that bounded ring by 500 newer capability entries, `getNotifications()`
  will still return its `id` on every future poll (it's Homey's own
  persistent notification, not a live-only event), and the ring no
  longer remembers having seen it — so the same notification would get
  re-appended, and re-shown as a "new" Recent row, forever. `log.mjs`
  therefore also keeps a separate `Set` of every notification `id` it
  has ever appended, checked instead of scanning the ring, so eviction
  from the display buffer never causes a re-append. This `Set` is
  genuinely unbounded for the life of the process, deliberately, not an
  oversight: capping it at a fixed size and evicting the oldest id once
  full would reintroduce the exact re-append bug it exists to prevent —
  `getNotifications()` returning Homey's own persistent history means
  an evicted id can still come back on a later poll, exactly like the
  bounded display ring above, just with a bigger number before it
  happens. There's no watermark available to bound it safely either:
  this research found no Homey API guarantee about how far back a poll
  can return or how many total notifications it retains, so any fixed
  cap is a correctness risk with no real memory payoff to justify it —
  this house's entire real notification history is 250 entries going
  back weeks (see Context above), so this `Set`'s actual growth over
  even a long-lived core process is a few hundred short strings, not a
  practical memory concern.
- `seedNotificationIds(ids)` — adds every id in `ids` to that same seen
  set *without* appending anything. This is the explicit, named
  operation `core/index.mjs`'s first notification poll needs (below): it
  establishes "these already existed before the core started" as a
  baseline, and `appendNotification` alone can't express "mark as seen,
  but don't create a row" — that's a second, distinct operation on the
  same seen set, not a special-cased call to the first one.
- `tail(n)` — the last `n` entries of either kind, in **append** order
  (newest-appended first), not necessarily chronological (`ts`) order.
  Those two can differ specifically for notification entries: a
  notification's `ts` is Homey's own `dateCreated` (above), not the
  moment this process happened to poll and append it, and the 30-second
  poll cadence means a notification can land in the buffer well after
  its own `ts` — interleaved with capability entries whose `ts` is
  always their real append time, since nothing delays a capability
  entry's `append` call (see `append` above). `tail(n)` still returns
  entries in the order they landed in the array; `core/recent.mjs`'s
  `list()` (below) is what sorts by `ts` before rendering, so "newest
  first" in the row list callers actually see is a real chronological
  ordering, not `log.mjs`'s raw append order.

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

- `list()` sorts by `ts` descending before taking the top `recentRows`,
  not by `tail()`'s raw append order — a notification's `ts` is Homey's
  own `dateCreated`, not this process's poll time, so a notification can
  land in the buffer after capability entries whose real `ts` is later
  than its own (see `log.mjs`'s `tail()` above); sorting by `ts` here is
  what keeps "newest first" true to actual event time rather than to
  whichever order things happened to land in the buffer.
- One row per log entry (no mood/flow-fold grouping yet — folding requires
  knowing *which* entries share a mood/flow cause, and phase 2 has no
  mood/flow attribution at all per the cause-tracking limitation above;
  fold-grouping is meaningful only once that exists, so it's deferred to
  whichever phase actually wires up mood/flow triggering).
- A `kind: "capability"` row: `{ id, kind, label, why, line, in }` —
  `label` is the entry's own `deviceName` (a snapshot from `log.mjs`,
  not a live device-map lookup — `recent.mjs` needs no `devices`
  argument at all), `why` is a plain rendering of the transition (`"→
  on"`, `"dimmed to 40%"`, `"locked"`) built from `capabilityId`/`from`/
  `to` — for `dim`/`volume_set` specifically, `from`/`to` are converted
  through `homey.mjs`'s `toDisplayPercent()` before rendering, since the
  log stores Homey's real normalized `0–1` value (see `core/homey.mjs`
  above), and "dimmed to 0.4" would be wrong to show a user who thinks
  in percent — plus `"(you)"` appended when `cause` is `"prompt"`, for a
  human reading the row. `in` is design.md's own "in/out filter"
  deliverable (its build-order line, quoted in Context above) made
  structural rather than left as text alone: `in: cause === "prompt"`,
  a real boolean field a caller can branch on directly, not a substring
  it has to parse out of `why` itself. This is one field beyond the
  four design.md's protocol section lists for a generic row (`id`,
  `label`, `why`, `line?`) — a deliberate, additive extension of that
  shape for Recent's `kind: "capability"` rows specifically, not a
  restatement of it: design.md names "in/out filter" as an explicit
  phase-2 deliverable without ever specifying a mechanism for it
  anywhere else in the document, and a caller genuinely cannot build a
  reliable filter out of presentation text alone, particularly once
  notification rows (next) are mixed into the same list and their `why`
  is Homey's own arbitrary free text, not something this process
  controls the wording of. `"(you)"` in `why` and `in` as a field serve
  two different consumers — a human reading the row, and code that wants
  to filter the list — and now both exist rather than only the one.
  A `kind: "notification"` row (next) carries `in: false` too, not an
  absent field: a notification is never `prompt`-caused (this process
  only observes them, never creates one), so it's unambiguously "out" —
  but a caller filtering the mixed Recent list with `row.in === false`
  would otherwise silently miss every notification row, since `undefined
  !== false`, forcing a kind-specific special case onto what's supposed
  to be one uniform field across every row Recent returns. `in` is
  present with a real boolean on both row kinds for exactly this reason
  — one consistent contract, not two different implicit rules for two
  row kinds sharing the same list.

  `line` is the grammar line that undoes the change, but only for a
  `capabilityId` phase 2's own grammar can actually execute — `onoff`
  (`"<device name> off"`/`"<device name> on"`) and `locked`
  (`"<device name> unlock"`/`"<device name> lock"`) are verbs the
  grammar recognizes; `dim`/`target_temperature`/`volume_set` are the
  three bare-number targets it recognizes, so their undo line is
  `"<device name> <from-value>"` — `toLinePercent()`-converted (not
  `toDisplayPercent()`) for `dim`/`volume_set`, since this text is meant
  to be typed back in and executed, and rounding it to a whole percent
  the way `why` does would make the "undo" land on a different value
  than the one it's supposed to restore. This line is executable only if
  the device that produced it still has exactly one setable capability
  among `dim`/`target_temperature`/`volume_set` at the moment it's run —
  `grammar.mjs`'s own ambiguity rule for a bare number (above) — which
  `recent.mjs` has no way to check itself: it deliberately renders from
  log entries alone, with no `devices` map (`deviceName` already has to
  travel with the entry as a snapshot for the same reason, above).
  Confirmed empirically against this real house: no real device here has
  more than one of these three `setable` at once (see `grammar.mjs`'s
  own bare-number step above), so this is a documented, accepted
  limitation for a case that doesn't occur in the verified target
  environment, not a gap this phase adds machinery to close — a device
  that did gain a second numeric target later (or in a different house)
  would still show an undo line here that could resolve as `"needs a
  word"` if run, the same way a device renamed since the entry was
  logged can make an undo line resolve differently than intended (below).
  Every other member of
  `DISCRETE_CAPABILITIES` — `speaker_playing` (`setable`, but phase 2's
  grammar has no play/pause verb), `alarm_contact`/`alarm_motion`
  (`getable`-only, not writable at all), `windowcoverings_state` (no verb
  or value form for it yet) — gets `line` omitted, same as the
  already-documented `null`-`from` case, because a line `prompt.run`
  would reject on submission is worse than no line: this list is exactly
  the complement of `grammar.mjs`'s own recognized verbs/targets below,
  so extending grammar's coverage automatically extends which
  capabilities get a real undo line, with no separate list to keep in
  sync by hand. These four still need a `why` — the row contract
  requires it whether or not `line` is present — so `recent.mjs` renders
  it directly for these, not through `grammar.mjs`'s
  `formatCapabilityWhy()` (which only covers the five capabilities a
  `line` can target, above): `speaker_playing`'s boolean `to` renders as
  `"playing"`/`"stopped"`; `alarm_contact`/`alarm_motion` rows are always
  `to: true` (the going-true filter drops every other transition before
  it reaches `log.append`, per `core/index.mjs` below) and render as the
  fixed strings `"open"`/`"motion"` respectively — Homey's own
  convention for what `true` means on each; `windowcoverings_state` is
  Homey's own enum string (`"up"`/`"down"`/`"idle"`), already
  human-readable, and renders as `to` verbatim with no conversion.

  A `line` built from `deviceName` text is only as executable as
  `grammar.mjs`'s own exact-match step (above) makes it: if the house
  has two devices sharing that exact name — nothing stops that; names
  are Homey's, not a namespace phase 2 controls — running the line lands
  in `resolve()`'s existing ambiguous-exact-match handling
  (`matches: [...]`, not a silent pick) exactly the same way typing that
  same text as a fresh query would. This isn't a special failure mode
  for `line` specifically that needs its own handling: it's the same
  ambiguity `prompt.run` already has to handle for *any* input, and a
  renamed device's old Recent rows go through the identical path — the
  line still names whatever device that text resolves to *now*, which
  may no longer be the same device if it was renamed and another device
  since took that name (a real but narrow edge case phase 2 doesn't add
  machinery for beyond what `resolve()` already does).
- A `kind: "notification"` row: `{ id, kind, label, why }` — `label` is
  the entry's real `ownerName` (its owning app/flow/feature name, per the
  Context section above), `why` is its `excerpt` verbatim. No `line`: a
  notification isn't a device state to revert, it's a fact that
  happened. Design.md's core config names an `events` field for exactly
  this kind of row — "name → `{line, ttl}` for doorbell/etc." — mapping
  a notification's own name to a proposed action line (e.g. a doorbell
  notification proposing the front door's unlock line), but phase 2 only
  *reads* `events` from `readCoreConfig()` (above) without wiring it
  into a notification row's `line`, so a notification row stays
  line-less this phase regardless of what `events` contains, until
  whichever phase actually does that lookup.

### `core/grammar.mjs` (new)
Exactly what design.md's repo layout names it: an exact/fuzzy/thing-number
parser, nothing wider yet.

- `resolve(text, { devices, zones })` — the `prompt.resolve` implementation.
  Its return shape is one consistent contract, not a different ad hoc
  object per branch: always `{ matches: [...] }` (`matches` present,
  possibly empty, on *every* return — never omitted), plus optionally
  exactly one of `room: { id, name }` (a bare zone query) or `action: {
  deviceId, capabilityId, value }` (a fully-resolved, ready-to-write
  target — `value` already percent-converted for `dim`/`volume_set`, so
  neither `run()` nor its caller needs to know which capabilities are
  percent-displayed). `run()` (below) is defined entirely in terms of
  this one shape: `action` present means write it, `room` present means
  report the room, neither present means report `matches` as-is
  (ambiguous, or nothing found — `run()` treats both the same way, since
  there's nothing to execute either way). Without one shared success
  shape, `resolve()`'s live-typing callers and `run()`'s own re-resolve
  call could each end up expecting different fields for the same
  underlying result.

  Splits `text` into `thing` and `rest` (first whitespace-delimited token(s)
  forming a name, greedily matched against device/zone names before falling
  back token-by-token — device/zone names are unpredictable-length, e.g.
  "Kitchen Switch"). This is a two-stage process, not five independent
  branches tried in order: stage one finds the **thing** — a specific
  device or zone, or gives up — and stage two decides what `rest` (if
  anything) means for *that* thing. Stage one only ever identifies *which*
  device/zone `text` refers to (or that it's ambiguous, or that it's
  nothing) — it does not by itself produce `resolve()`'s final return
  value.

  Stage one is not exact-then-fuzzy as two fully independent passes run
  one after the other. A full-name match is the degenerate case of a
  prefix match — a prefix that happens to consume the entire name — so
  running an exact pass across *every* candidate length before fuzzy ever
  gets a turn would let a short, low-priority exact match win over a
  longer, more-specific match the input actually typed toward: a zone
  named "Attic" must not swallow a query for "Attic Switch," typed in
  full, merely because "Attic" alone happens to satisfy exact matching at
  a shorter length that gets tried (and stops) before the longer length
  is ever considered. So stage one is one loop over candidate length,
  longest first, checking three priority levels together at *each*
  length before moving to a shorter one:
  1. **Exact** — case-insensitive full match against every device and zone
     `name`, at the current candidate length. A *unique* exact match
     identifies the thing; more than one device/zone sharing a name
     (nothing stops two devices being named identically) makes stage one
     itself ambiguous and `resolve()` returns `matches: [...]` candidates
     immediately, exactly like an ambiguous fuzzy match does — exactness
     is about the string match quality, not a promise of uniqueness, so
     this step must not silently pick one via whatever order
     `Object.values(devices)` happens to iterate in. A tie at this level
     also takes priority over anything level 2/3 would have matched at
     the *same* length — a zone and a device both named exactly "Attic"
     resolve as a 2-way ambiguity, not diluted into a 3-way tie by
     "Attic Switch" also satisfying level 2 at that same length.
     Whenever stage one produces more than one candidate for the *same
     name* — whether an exact match tied on identical names or a fuzzy
     match tied on identical leading tokens (below) — every such
     candidate's `label` is zone-qualified, `"<device name> (<zone
     name>)"`, using `zones` (already in scope here) to look up each
     match's own zone: one shared step applied wherever stage one can
     produce this specific kind of tie, not a fixup limited to the exact
     level alone. This is at least what makes two devices sharing a
     name visually distinguishable in the candidate list, rather than
     both showing the identical string with nothing to tell them apart.
     That's the limit of what
     phase 2 can offer here, not a partial fix left for later: phase 2's
     grammar has no zone-qualified input syntax to *select* one of the
     two by retyping (kinds, zone-scoping, and joins are all deferred,
     see "Deferred past this phase"), so retyping the identical name
     produces the identical ambiguous result again. Two devices sharing
     one exact name are unresolvable by text in phase 2's grammar,
     full stop — a real constraint of this phase's scope, not this
     step's implementation, and one Homey's own naming freedom creates,
     not something `resolve()` can route around. This house has no such
     pair; the fixture adds one deliberately (below) so the ambiguous
     path itself is still tested, distinct from testing that it's
     actually resolvable.
  2. **Token-aligned prefix** — a case-insensitive match against a
     **token-aligned** prefix of the name, checked at the current
     candidate length only after level 1 found nothing at that length:
     split the name on whitespace the same way `text` already is, and
     compare the candidate against the name's own leading tokens joined
     back together, not the raw name string. This is what keeps `"desk"`
     matching only `"Desk Lamp"` (`"desk"` equals its one leading
     token, `"desk"`) and not also this house's `"desktop machine"`
     (`"desk"` is a raw-string prefix of the token `"desktop"`, but not
     equal to it) — the fixture (below) has both, and design.md's own
     `desk 40` example is explicit that `"desk"` matches only the Desk
     Lamp, so an ordinary substring/prefix scan over the whole name
     string is wrong here even though it's the more obvious
     implementation.
  3. **Substring** — checked at the current candidate length only after
     levels 1 and 2 both found nothing at that length: does the candidate
     appear anywhere inside any single token of the name. This is the
     fallback for a single-token (often compound) name with no word
     boundary for level 2 to align a prefix against at all — a real gap
     found once this plan met a real house: a German-style compound light
     name (one long token, no spaces) has no token-aligned prefix shorter
     than the entire word, so without this level, "the least you can
     type" (design.md's own stated grammar principle) would be false for
     any single-token name — you'd always have to type the whole thing.
     The fixture (below) adds one such device so this level has something
     real to resolve against.

     At every level and every length, a *unique* match identifies the
     thing the same way exact does; multiple matches return `matches:
     [...]` candidates (each `{ label, why }`, no `line` yet since stage
     two never ran, and zone-qualified exactly like the exact-level
     duplicate-name case above when two matches tie on the same name).
     Only once *all three* levels find nothing at the current length does
     the loop try the next-shorter length; zero matches at every length is
     a dead end (`matches: []`). None of the three levels ranks or scores
     candidates against each other — a unique hit resolves, more than one
     is always an ambiguous list to disambiguate from, never a silently
     auto-picked "best guess": this grammar writes to a real device, so it
     never guesses when it isn't sure which one you meant.

  Once stage one has identified exactly one thing, stage two looks at
  `rest`:
  3. **A zone thing with empty `rest`** — design.md's grammar explicitly
     supports a bare zone query ("`office` — a bare zone query — lists
     the Office's devices"), and `prompt.resolve`'s protocol shape
     already carries a `room?` field for exactly this, so phase 2 returns
     `{ matches: [], room: { id: zoneId, name: zone.name } }` —
     `matches: []` alongside `room`, per the one-consistent-shape
     contract above, not `room` on its own with the field simply absent.
     The name travels with the id because `bin/uchi` (below) has no zone
     map of its own to look one up in; `resolve()` already has `zones`
     in scope, so it's the one place that can cheaply attach it. No
     `action`: design.md is explicit that a bare zone row has none
     ("**Enter** pins it as Here via `room.pin`," not `prompt.run`) —
     phase 2 doesn't implement `room.pin` (see `rpc.mjs` below), so
     `{ room }` is as far as this goes; a wrapper or `bin/uchi` that
     doesn't yet call `room.pin` can still show the zone was recognized.
  4. Verbs (`on`, `off`, `lock`, `unlock`) — recognized as `rest` for a
     device whose `capabilitiesObj[capabilityId]` is both present *and*
     `setable` (`onoff` for on/off, `locked` for lock/unlock) — checking
     `capabilities`' presence alone isn't enough: Homey's own shape
     distinguishes `getable` from `setable`, and a capability can be
     present and readable without being writable, so a read-only device
     would otherwise resolve here and only fail later, inside
     `prompt.run`, instead of failing resolution up front the way an
     unmatched thing already does. A match here returns `{ matches: [],
     action: { deviceId, capabilityId, value } }` — `value` is `true`
     for `on`/`lock`, `false` for `off`/`unlock`. Anything else in `rest`
     is parsed as a bare number.
  5. A bare number in `rest` requires `rest.trim()` to be non-empty
     *and* `Number(rest.trim())` to be finite — checked in that order,
     before anything below runs. Both checks matter for a different
     reason: `Number("")` (and `Number("   ")`) is `0`, not `NaN`, so a
     device-only query with nothing after it (`"desk"` with no verb or
     value) would otherwise silently fall through the empty-string
     check and resolve as if `"desk 0"` had been typed, writing a
     dimmable light to zero instead of doing nothing — the non-empty
     check is what makes a bare device name (no verb, no number) its own
     defined dead end, `matches: [{ label: thing.name, why: "needs a
     verb or number" }]`, symmetric to a bare *zone* name's defined
     `{ room }` result above, rather than an accident of what `Number()`
     happens to coerce an empty string to. Separately, an ordinary
     `min`/`max` comparison never rejects `NaN` on its own (`NaN < min`
     and `NaN > max` are both `false`), so a non-empty but non-numeric
     `rest` (`"desk abc"`) still needs its own finite check before the
     range check further down, or it would pass the range check as if
     it were in range and reach `setCapabilityValue` with `NaN`. A
     non-finite `rest` is a dead end, `matches: [{ label: thing.name,
     why: "needs a number" }]` — the "one consistent contract" above
     still holds: this is a `matches`-shaped dead end like any other, not
     a new field. A finite number resolves only if the matched thing is a
     **device** (not a zone — see the multi-kind-zone finding above) whose
     `capabilitiesObj` has exactly one `setable` entry among
     `dim`/`target_temperature`/`volume_set` (checked in that order; a
     device is never expected to have more than one in phase 2's real
     data, but the order is deterministic either way) — the same
     `setable` check as verbs, for the same reason. Zero or more-than-one
     such capability is *also* `matches: [{ label: thing.name, why:
     "needs a word" }]` — the real word grammar (design.md's full word
     list) is deferred, so this phase can name the problem but not solve
     every case; it's still strictly better than silently guessing wrong.
     The parsed number is treated as a **percent** for `dim`/`volume_set`
     and converted via `homey.toHomeyValue()` before it's used for
     anything — resolving against the *converted* value, not the raw
     typed number, since a dim capability's real range is `0–1` (see
     `core/homey.mjs` above); `target_temperature` is used as-is, already
     real degrees. The converted value is then checked against that
     capability's own `min`/`max` (real, verified fields — `dim`/
     `volume_set` are `0–1`, this house's real thermostats are `4–35`)
     and out-of-range is `matches: [{ label: thing.name, why: "needs
     <min>–<max>" }]`, with `<min>`/`<max>` interpolated as the
     *user-facing* bounds, not the raw stored ones: `toDisplayPercent()`
     converted for `dim`/`volume_set` (`"needs 0–100"`, not `"needs
     0–1"` — the typed value was already a percent, so the error has to
     speak percent back, not the internal normalized range that would
     read as nonsense against a typed `200`), and the real degree values
     as-is for `target_temperature` (`"needs 4–35"`) — a literal `"out
     of range (min–max)"` placeholder would tell the user nothing about
     what range would actually work, resolved no further than that — the
     same `matches`-as-a-single-candidate shape as the two dead ends
     above,
     not sent to `setCapabilityValue` at all. Skipping this would let
     Homey decide whether to reject or silently clamp an out-of-range
     write; either way, if `write()` still recorded the *requested*
     value as `to` (rather than whatever Homey actually applied),
     `currentValue` and Recent would describe a state the device was
     never actually in. A value that passes every check above returns
     `{ matches: [], action: { deviceId, capabilityId, value:
     convertedValue } }`.
- `run(line, { devices, zones, setCapabilityValue })` — the `prompt.run`
  implementation: re-resolves `line` via `resolve()`. If the result has
  `action` (the one canonical shape every writable resolution produces,
  per the contract above), looks up the actual `device` object from
  `devices` by `action.deviceId` and `await`s
  `setCapabilityValue(device, action.capabilityId, action.value)` —
  `action.value` is already percent-converted, so `setCapabilityValue`'s
  caller (`core/index.mjs`, not this file) never has to know which
  capabilities are percent-displayed. `setCapabilityValue` here is
  **not** `core/homey.mjs`'s thin wrapper of
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
  A `resolve()` result with `room` instead of `action` returns `{ ok:
  false, room }` from `run()` without calling `setCapabilityValue` at
  all — running a room query on `Enter` isn't a write. Anything with
  neither `action` nor `room` (ambiguous or no match — `matches` is
  whatever `resolve()` produced, empty or not) returns `{ ok: false,
  matches }` (`bin/uchi` prints the candidates and exits non-zero, per
  design.md's one-shot-caller behavior), also without calling
  `setCapabilityValue`. `bin/uchi` (below) reports the room case
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
`onoff`/`dim`/`locked`/`target_temperature`/`volume_set`/
`speaker_playing` — `speaker_playing` is included in this filter even
though phase 2's grammar has no play/pause verb for it (recent.mjs
above renders a `why` for it with no `line`, for the same reason): a
speaker whose only setable capability happened to be `speaker_playing`
would otherwise be silently excluded from Here entirely, when
design.md's Here section says "controllable devices," not every device
in the zone,
and the fixture makes the distinction concrete: Kitchen has 5 lights plus
a Kitchen Switch (a physical remote, design.md's own description of it),
and a remote has no setable capability of its own to control — it
triggers flows, it isn't controlled directly — so filtering on
`setable` correctly returns the 5 lights `here.test.mjs` (below) expects,
not 6.

Each surviving device is rendered as `{ id, label, why, line }` matching
the row contract every section uses. A device can have more than one of
the five controllable capabilities at once — an ordinary light has both
`onoff` and `dim` — so picking one needs several passes, not one flat
priority order over all five. First, and before anything else: if the
device has `onoff` present and `setable` **and** its current value is
`false`, `onoff` is the pick, full stop — `why: "off"`, `line: "<device
name> off"` — regardless of what `dim` (or any other capability) reads.
This is the same rule `hero.summary`'s active-device count already
applies (above): a light switched off but still holding a nonzero `dim`
level from before — the normal state after an `onoff`-only "off"
command, since turning a light off doesn't reset its remembered
brightness — is off, full stop, not "dimmed to 40%." Showing the
remembered `dim` level here instead would misdescribe a device that
isn't emitting any light as if it were on at that brightness, and its
`line` would turn the light *on* (Homey's own real behavior for a
nonzero `dim` write) rather than reflect the device's actual current
state — the opposite of what a Here row re-applying its own current
value is supposed to do. Only once that check has passed — `onoff`
absent, not `setable`, or currently `true` — do the remaining two passes
run: `numericTargets` — the device's present-*and*-`setable`
capabilities among `dim`/`target_temperature`/`volume_set` — is computed
exactly the way `grammar.mjs`'s bare-number step (above) does, because
that's the whole point: `grammar.mjs` only accepts a bare number when a
device has **exactly one** of these three, so a `line` built from a
different assumption could name a capability that same input would
actually reject as `"needs a word"`. If `numericTargets.length === 1`,
that capability is the pick for both `why` and `line` — the ordinary
case, and the only one where a numeric `line` is safe to offer at all.
Otherwise (zero or more than one
numeric target — a device with, say, both `dim` and
`target_temperature` setable would otherwise let this row's `dim` pick
generate `"<device> 40"`, which `grammar.mjs` would reject as ambiguous
the moment `prompt.run` tried to execute it, not the working undo the
row promises), the pick falls through to `onoff` then `locked` instead
— checked in that order for present-*and*-`setable`, the first match
wins for both `why` and `line`. Verbs don't have the three-way ambiguity
numbers do: typing `"on"` only ever names `onoff` and `"lock"` only ever
names `locked`, so a device having both `onoff` and `locked` setable
creates no comparable conflict — each verb's own word already picks its
capability, independent of the other. If neither `onoff` nor `locked`
is present and setable either, the next fallback is `speaker_playing`
(present and `setable`) — `why` only, per `recent.mjs`'s own rendering
for it above (`"playing"`/`"stopped"`), never `line`, since phase 2's
grammar has no play/pause verb to execute regardless of which single
device it targets. Only if none of `onoff`/`locked`/`speaker_playing`
is present and setable either — a device whose only controllable
capabilities are two or more ambiguous numeric targets, the one
remaining case the zone-level filter's six capabilities can still
produce — does `why` fall back to `numericTargets[0]`'s current value,
so the row isn't blank, with `line` omitted — the same "no `line` for a
capability `grammar.mjs` can't write this way" rule `recent.mjs` already
applies for its own undo lines (above), applied here for the same
underlying reason: an ambiguous numeric target and a capability
grammar.mjs doesn't recognize at all are both cases where no line phase
2's own grammar could ever run, not merely a capability grammar.mjs
hasn't gotten to yet. `why` is the picked capability's current value —
`formatCapabilityWhy(capabilityId, value)`, the one shared `grammar.mjs`
function, for the five it covers (`toDisplayPercent()`-converted for
`dim`/`volume_set`, plain for `target_temperature`, `"on"`/`"off"`/
`"locked"`/`"unlocked"` for the boolean pair — that `rpc.mjs`'s
`prompt.resolve` handler also calls, above, rather than duplicating the
same formatting), or `recent.mjs`'s own `speaker_playing` rendering
(above) when that's the pick instead; `line`, when present, is the same
`toLinePercent()`-based undo-style line `recent.mjs` builds for a
re-apply of the picked capability, reusing that formatting logic —
factor the shared from-value → line renderer into `grammar.mjs` so
`here.mjs` and `recent.mjs` don't duplicate it.

### `core/index.mjs` (extend)
The very first thing this extended `main()` does, before even calling
`connect(settings)`, is capture `const startupCutoff = Date.now()` —
notification polling (below) needs this value once it starts, but
capturing it only right before the polling loop starts would leave out
however long the Homey connection and the devices/zones/moods/users
fetch below take: a notification created during that window would
already be older than a cutoff captured after it, and would be wrongly
classified as pre-existing history instead of a genuinely new,
current-process notification. Capturing it as the literal first
statement in `main()` is what makes "before core initialization" mean
the actual process start, not just "before the polling loop specifically."

The existing `try { const api = await connect(settings); deviceCount =
await getDeviceCount(api); } catch { ...; process.exit(69); }` declares
`api`/`deviceCount` with `const` scoped to that `try` block — fine in
phase 1, where nothing outside the block ever reads them again. Phase 2
does: notification polling needs `api`, and the subscription/write
machinery below needs `devices`. So `api`, `devices`, `zones`, `moods`,
and `users` are declared with `let` *before* the `try` (initialized to
`undefined`, standard for a value a `try` is about to assign), and the
`try` body assigns `api` and `devices` — `api = await connect(settings);
devices = await homey.getDevices(api);` — rather than re-declaring them
with `const` inside it. A fetch failure here is still exactly the "Homey
unreachable" case that existing block's `exit(69)` handles, unchanged
from phase 1: `devices` (subscriptions, writes, `resolve()`) is load-
bearing for everything phase 2 does, so it stays startup-critical.
`zones`/`moods`/`users` do **not** join that same hard gate, even though
they're fetched in this same startup burst for efficiency (one round of
requests, not deferred to first use) — each is wrapped in its own
`try`/`catch` that defaults to `{}` and logs a warning on failure rather
than exiting: `zones` only feeds Here's room computation, zone-name
matching, and a bare zone query's `{ room }` reply; `moods` only feeds
Here's mood chips; `users` only feeds `hero.summary`'s presence line.
None of the three is needed for `uchi desk 40` itself — a transient
failure fetching moods, for instance, has no business taking down device
writes along with it, the same reasoning that already keeps the
notification poll below from blocking `state.get`/`prompt.run`. A `{}`
default degrades gracefully (an empty zone/mood/user map, not a crash),
and the very next `state.get` call re-fetches all three fresh anyway
(above) — the same call re-fetches `devices` too, so this isn't a
special retry mechanism, just the existing refetch-every-call design
already giving each of these three its own natural retry on the next
request, without this process ever needing to notice or schedule one
itself. `deviceCount` for the startup log line becomes `Object.keys(
devices).length`.

After that block (where phase 1's `console.log("Connected to Homey —
...")` already sits): build `currentValue`, a plain `Map` keyed by
`` `${deviceId}:${capabilityId}` ``, seeded from the startup `devices`
fetch's own `capabilitiesObj` values for every capability in
`DISCRETE_CAPABILITIES`. This one cache is what fixes three related gaps
at once, all stemming from the same root cause — relying on the
`devices` snapshot (refreshed only by `state.get`) for a value that
needs to be current *between* `state.get` calls. Build `startupDeviceNames`
alongside it, a plain `Map` from `deviceId` to `name`, seeded from the
same startup `devices` fetch — `onChange`'s callback (below) is only
ever given `{ deviceId, capabilityId, value }` by `subscribeToDiscreteChanges`
(see `core/homey.mjs` above; it never receives a `device` object of its
own to fall back to), so this small, purpose-built map is what lets it
recover a name for a device the *live*, `state.get`-refreshed `devices`
map no longer has, without inventing a `device` binding that was never
part of the callback's own contract:

- Call `subscribeToDiscreteChanges` **once**, against the device map
  from that startup fetch. Its `onChange` callback **first** captures
  `const from = currentValue.get(key)` — reading the cache, not yet
  writing it — before doing anything else. Whether that captured value
  is used for a self-echo check or a real transition is decided next;
  the callback does not touch the cache until it knows which.
- The callback then checks a `pendingSelfWrites` `Map`, keyed the same
  way, of one **queue** (array) per key, not a single overwritable entry
  — `write()` (below) can start a second write to the same capability as
  soon as the first's Homey call resolves, which can happen before that
  first write's two realtime echoes have both arrived (the echoes are
  independent of the write's own HTTP-style response), so two writes to
  the same key can genuinely have expectations in flight at once; a
  single slot would let the second write's expectation overwrite the
  first's before it's fully consumed. Each queued record is `{ value,
  remaining, timer }` — `remaining` starts at `2` (confirmed live:
  `setCapabilityValue` triggers this callback **twice** with the same
  value, not once, so this isn't a rare double-fire to special-case but
  the expected shape of every self-caused write). On an incoming event,
  the callback searches the key's queue for the first record whose
  `value` matches the new (incoming) value; if found, decrement its
  `remaining` and drop the event (it's an echo, not a real transition)
  **without touching `currentValue`** — `write()` already set the cache
  to this exact value synchronously, the moment its own
  `setCapabilityValue` call succeeded (below), so an echo has nothing
  left to update, and letting it write the cache anyway is actively
  harmful: with two writes to the same key in flight, a late echo for
  the *older* write can arrive after a *newer* write has already moved
  the cache on, and unconditionally overwriting on every echo would
  stomp the newer, correct value back to the older one. The matched
  record is removed once its `remaining` reaches `0` — matching by
  value, not by queue position, is what keeps two overlapping writes'
  echoes from being attributed to each other. Each record's `timer` is a
  fallback: a few seconds after it's created, remove it regardless of
  `remaining`, in case fewer than two echoes ever arrive for some reason
  — a stale record that's never removed would incorrectly swallow a
  later *genuine* external write to the same value. Matching by value is
  a documented, accepted best-effort limitation, not a proof of
  causation: an external write landing on the exact same value while a
  self-write's expectation is still queued (e.g. a physical switch
  toggled to the value `prompt.run` was already setting) is
  indistinguishable from the real echo and gets consumed by it, and the
  genuine echo that follows can then be misattributed as external. The
  same limitation cuts the other way too: if Homey ever applied a
  capability to a value other than the one requested (see `homey.mjs`'s
  `setCapabilityValue` above for why this isn't expected for phase 2's
  five writable capabilities specifically), the real echo would carry
  that different value, wouldn't match the queued record, and would be
  misattributed as an external transition instead of consumed as an
  echo — the same by-value matching trade-off, not a second, separate
  gap. `makeCapabilityInstance`'s listener (`homey.mjs`'s
  `subscribeToDiscreteChanges`, above) exposes only `value` to `onChange`
  — not the raw socket event's `transactionId`/`transactionTime`
  (verified in the Context section above) — so there's no correlation
  ID available at this layer to disambiguate the two; this only affects
  `cause`/`"(you)"` attribution for that one rare, narrow interleaving,
  never the recorded `from`/`to` values themselves, and design.md
  already treats cause as descriptive flavor, not something downstream
  depends on structurally (see "Deferred past this phase"). Records are
  pushed
  *before* the write they belong to is issued (below), which is what
  makes matching against this queue safe against an echo arriving before
  `rpc.mjs` has even called `log.append` for the prompt-caused write — a
  check against the log's own tail instead would be racy exactly in that
  window.
- If the incoming event does **not** match a queued self-write, it's an
  externally-caused event: the callback sets `currentValue` for that key
  to the new value — before any *logging* filtering, though after the
  self-echo check above — and only *then* decides whether to log
  anything. Updating the cache before the logging filter, not after, is
  what keeps a later `alarm_contact`/`alarm_motion` "going true"
  comparison correct: filtering `false` transitions out of `onChange`'s
  *logging* behavior must not also filter them out of what the cache
  remembers, or a `true → false → true` sequence would see the second
  `true` as a no-op against a cache stuck on the first `true`, and lose a
  real Recent row.

  Design.md's only stated time-window behavior for Recent is a fold —
  "changes within 2s of a mood/flow fold under it" — grouping several
  *devices* a single mood/flow activation touched into one row, not
  delaying or cancelling a single key's *own* transitions against each
  other. Phase 2 has no mood/flow attribution at all (see "Deferred past
  this phase"), so there's nothing to fold yet, and folding is out of
  scope here regardless: it groups multiple differently-keyed changes
  under one shared cause, a different operation entirely from anything a
  single capability's own callback could decide by itself. A person
  physically flipping a switch off and back on within two seconds is a
  real interaction with its own Recent-worthy `A → B` and `B → A` rows,
  not noise to hide — nothing in design.md calls for suppressing or
  delaying a single key's own reversal, so this callback doesn't buffer,
  delay, or cancel anything: it calls `log.append({ kind: "capability",
  deviceId, capabilityId, deviceName: devices[deviceId]?.name ??
  startupDeviceNames.get(deviceId), from, to: value, cause: null })`
  directly for every externally-caused
  transition that reaches this point — no pending map, no timer — except
  one: if the capability is `alarm_contact`/`alarm_motion` and `value`
  isn't `true`, the call is skipped entirely, per design.md's "contact/
  motion going true" wording for what counts as Discrete at all — a
  `true → false` transition for these two was never meant to be its own
  Recent row in the first place, independent of any window or reversal.
  `deviceName` reads the *live* `devices` map first (the module-level
  variable `state.get` reassigns on every call, above) — not a `device`
  object, since `onChange` was never handed one (its whole payload is
  `{ deviceId, capabilityId, value }`, per `subscribeToDiscreteChanges`'s
  own contract above) — so a device renamed after startup logs future
  external transitions under its *current* name, matching `log.append`'s
  own "snapshot at append time" contract for `deviceName` (above): the
  snapshot has to actually be taken *at append time*, not at
  subscription-creation time. `startupDeviceNames.get(deviceId)` is the
  fallback for the one case a live lookup can miss — a device removed
  from a later `state.get`'s fresh map (the topology-change limitation
  below) — where the startup snapshot, captured once alongside
  `currentValue` (above), is the only name left to fall back on; it's a
  small map built for exactly this, not a repurposed `device` reference
  that was never in scope here.
  `log.append`'s own `from === to` no-op dedupe (above) still drops a
  duplicate callback reporting the same value again, or the very first
  event on a freshly subscribed key reporting the value `currentValue`
  was already seeded with at startup — no separate no-op check is needed
  here, since `append` already guards against exactly that.

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
`currentValue`, pushes a fresh `{ value: homeyValue, remaining: 2, timer
}` record onto `pendingSelfWrites`' queue for that key (per the queue
design above — pushed, never overwriting an existing record), `await`s
`homey.setCapabilityValue(device, capabilityId, homeyValue)`, and on
success sets `currentValue.set(key, homeyValue)` unconditionally.

This unconditional overwrite has one accepted, documented edge case,
the same kind of best-effort limitation as `pendingSelfWrites`' matching
above: if a genuine external transition lands on this exact key during
the `await` (a real, rare interleaving — Homey's realtime callback and
this continuation both run on the same single-threaded event loop, so
it's a narrow ordering window, never a true concurrent write), that
external value is visible in `currentValue` only until this write's own
continuation runs, at which point it's overwritten with `homeyValue` —
even in the narrower case where this write's own two self-echoes (for
that same `homeyValue`) already arrived *and* a *further* external
change landed after them, both before this `await` itself resolves; the
overwrite would then stomp that later external value with this write's
now-stale one.

A per-key version guard — capture a version before the `await`, only
publish if nothing bumped it in the meantime — looks like the fix, but
it trades this failure mode for a worse one rather than removing it:
a version guard is keyed to "did anything else touch this key," not to
"is my
own value still current," so the *first* time anything external touches
the key during the `await`, the guard permanently blocks this write's
own completion from ever publishing — including in the far more common
case where this write's `homeyValue` is genuinely the latest real value
and the external event that bumped the version was itself the *stale*
one (superseded by this write). Since nothing else is left responsible
for ever writing `homeyValue` into the cache once the guard blocks it,
that case gets stuck on the external value indefinitely, not just until
the next real event for the key. Resolving this correctly would need
this API surface to say *when* each value actually took effect on the
device, not merely *that* it changed — `onChange` is only ever given a
bare `value`, never the `transactionId`/`transactionTime` the raw
socket event actually carries (per the Context section above) — so
there is no ordering information available to make the guard's
suppress/publish choice correctly in both directions at once. Between a
narrow window where a fast overwrite can stomp a genuinely newer value,
and a guard that can just as narrowly get permanently stuck on a stale
one, this plan takes the option that self-corrects on the very next
real event for the key rather than the one that doesn't self-correct at
all. `write()` returns `{ deviceId: device.id, deviceName:
device.name, capabilityId, from, to: homeyValue }` — `deviceName` comes
from the `device` object `write()` was called with, captured here rather
than by `rpc.mjs` reading `devices[change.deviceId].name` after the
`await` returns: `state.get` can replace the whole `devices` map object
while this write is in flight, so a lookup against `devices` *after*
awaiting reads whatever the variable currently points to, not
necessarily the map this call started against — reading `device.name`
directly off the already-resolved object handed to `write()` has no such
window. A rejected `homey.setCapabilityValue` call removes the specific
record this call pushed (identified by object reference, not by value —
another same-key write could have pushed a record with the same value in
the meantime) from the queue, so a failed write doesn't leave a phantom
echo expectation behind, and rethrows, for `grammar.run` to catch (see
above).

`state.get`'s fresh `devices` fetch is also `currentValue`'s only
resync path: whenever a `state.get` call wins the publish-generation
race (above), it also writes each device's real, freshly-fetched
`capabilitiesObj[capabilityId].value` into `currentValue` for every
`DISCRETE_CAPABILITIES` entry that device has — a plain overwrite, the
same accepted-narrow-race treatment `write()`'s own cache update uses
(above), not a new guard. Without this, a realtime event dropped during
a reconnect gap (the WebSocket-style subscription silently missing a
transition, a real possibility this plan doesn't otherwise defend
against) would leave `currentValue` stale *indefinitely* — unlike the
narrow single-write races documented above, which self-correct on the
very next real event for that key, a dropped event has no "next event"
to self-correct with until some unrelated later change happens to the
same key, which could be a long time. Tying reconciliation to
`state.get` bounds the staleness window to "no worse than since the
last `state.get` call" instead, without adding a separate poll or
reconnect-detection mechanism of its own. The same in-flight-write
interleaving this plan accepts elsewhere applies here too: a
`state.get` fetch that happens to resolve while a same-key `write()` is
still awaiting Homey's response can momentarily reconcile `currentValue`
back to the pre-write value, since the fetched snapshot doesn't yet
reflect a write Homey hasn't confirmed — self-corrected moments later
when that `write()`'s own completion applies its `homeyValue`. The
narrower case — a `state.get` fetch that started *before* a real
transition (self-caused or external) and resolves *after* it, so its
now-stale snapshot overwrites a cache value a realtime event already
correctly advanced — has the same resolution as the write-vs-write case
above, not a new one: unlike a dropped realtime event (which has no
guaranteed future correction), every `state.get` call re-fetches
directly from Homey, never from this process's own cache, so the very
*next* `state.get` call — whenever one happens, for any reason, from any
caller — reconciles from a fresh, accurate fetch regardless of how
stale the previous one left things. The staleness window this race can
introduce is bounded by "until the next `state.get` call," the same
bound the reconciliation mechanism itself exists to guarantee, not left
open-ended the way a purely realtime-event-driven correction would be.

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
direct consequence of the "refetch don't resubscribe" choice above, not
a separate decision — phase 2 doesn't attempt
to reconcile subscriptions against topology changes; a core restart
(already the standard recovery path for a settings change, per phase 1)
picks up any added/removed device.

Notification polling is started, not awaited, right after the block
above — `rpc.listen()` (phase 1's existing call, unchanged in phase 2)
must not wait on it: notifications are optional, best-effort Recent
content, and Homey's core device connection already succeeded by this
point (that's what the earlier `exit(69)` gate already guarantees), so
an outage in specifically the notifications endpoint must not delay
`state.get`/`prompt.run` becoming available at all.

The one `startupCutoff` captured at the top of `main()` (above) is
reused for whichever polling attempt turns out to be the seed call —
never recaptured inside the loop. Capturing it fresh on every attempt
instead would let a failed first fetch push the cutoff later on each
retry: a notification created right after core startup but before a
slow or retried connection finally succeeds would then satisfy the
seed comparison against that later value and get silently seeded as
pre-existing history, never shown, despite genuinely falling inside
this process's own current-process window.

The polling itself is one recursive `setTimeout` loop, not a bare
`setInterval`, with a module-level `notificationsSeeded` boolean guard
(`false` until the first successful fetch) — a plain interval-based
retry has no such guard and can't prevent two overlapping attempts (one
slow fetch still in flight when the next retry fires) from each
independently succeeding and each seeding/starting their own polling
cadence. The loop's body: call `homey.getNotifications(api)`; on
success, if `notificationsSeeded` is still `false`, this is the seed
call — for each returned entry, compute `entryTime =
Date.parse(entry.dateCreated)` (Homey's `dateCreated` is an ISO string;
`startupCutoff` is `Date.now()`'s numeric milliseconds-since-epoch, so
comparing the raw string against it directly would compare a string to
a number and produce `NaN`-driven comparisons that are never true,
misclassifying every entry as newer than the cutoff) — mark the entry
seen via `log.seedNotificationIds(...)` (established history, not
appended) if `entryTime <= startupCutoff`, or `log.appendNotification(
...)` it if `entryTime > startupCutoff` (genuinely created after core
startup, not pre-core history — appending it, not just seeding it, is
what keeps a notification created in that narrow window from being
silently absorbed into the baseline and never shown), then set
`notificationsSeeded = true` and schedule the next call in `30_000` ms. If `notificationsSeeded` is already `true` (this is an ordinary
ongoing poll, not the seed), just `appendNotification` any entry whose
`id` isn't already in the seen set, as before, and schedule the next
call in `30_000` ms. On failure: log the error via `console.error` and
schedule a retry — in `5_000` ms if `notificationsSeeded` is still
`false` (still trying to establish the baseline), or in `30_000` ms if
it's already `true` (an ordinary poll just had a transient failure, the
regular cadence already covers retrying it). Scheduling the *next* call
only after the *current* one finishes — success or failure — is what a
recursive `setTimeout` gives for free and a bare `setInterval` doesn't:
there's never a second call in flight while the first is still running,
so nothing can double-seed or start the real cadence twice. Homey's
notification list is real, persistent history (this house alone has 250
real entries going back weeks), not a live-only feed, which is why the
seed/append distinction above exists at all — appending everything
already present on first connect would flood Recent with pre-core
history in one shot. No realtime "notification created" push was found
or verified in `homey-api`'s exposed surface (unlike capability changes,
which genuinely are push-based), so polling is the honest approach here,
not a shortcut; 30s balances staleness against hammering the API for a
row kind that's inherently lower-frequency than capability changes. This
is the notification exception design.md's own "Explicitly decided
against: Polling" entry names — capability state stays fully push-based
and unchanged here; notifications are a different data source with no
push mechanism this research found, so they poll instead of being
dropped from Recent's scope entirely (design.md itself lists
"notifications" as in-scope Discrete content).

### `core/rpc.mjs` (no structural change)
Untouched — phase 1 already factored dispatch as a plain `{method:
handler}` table passed in from `index.mjs`; phase 2 just grows that table
in `index.mjs`. This means no `state.changed` push (design.md's protocol
section) goes out over the socket this phase, even though the realtime
subscription and notification poll below genuinely change server-side
state in between requests — phase 1's `rpc.mjs` only ever dispatches an
incoming request and returns its response; it has no connected-socket
registry or broadcast path to push anything unsolicited to a client, and
phase 2 doesn't add one. This isn't an oversight: `state.changed` exists
for a wrapper that stays connected and needs to know when to re-fetch
without polling, and phase 2's only client, `bin/uchi`, is a one-shot
process — it sends one request, gets one response, and exits, so it has
no connection open to ever receive a push on. Phase 3 ("Omarchy panel,"
per design.md's build order) is the first wrapper that's actually
long-lived, and adding the broadcast path belongs there, against a real
consumer, not here as speculative plumbing with nothing to call it.
Every method below still works correctly without it: `bin/uchi` always
calls `state.get` fresh for each invocation, so it never depends on
being *told* something changed — it just asks.

- `state.get` refetches `devices`/`zones`/`moods`/`users` and publishes
  them into the shared variables the rest of the `methods` table closures
  over (see `core/index.mjs` above) — but the RPC server (phase 1's
  `rpc.mjs`) already handles each incoming line independently, so two
  overlapping `state.get` calls (nothing prevents a client sending two in
  quick succession) can have their fetches resolve out of order: the
  *slower* of the two would otherwise publish its (now stale) snapshot
  *after* the faster one already published a newer one, leaving every
  later Here/grammar/write call reading data older than what a client
  already saw. `state.get`'s handler guards against this with two
  module-level counters, not one: `startedGeneration` increments every
  time a call begins, and each call captures its own value from that
  before starting its four fetches; `publishedGeneration` tracks the
  highest generation that has actually *published* successfully, not
  merely started. After a call's fetches resolve, it publishes to the
  shared variables only `if` its own captured generation is strictly
  greater than the current `publishedGeneration`, and then sets
  `publishedGeneration` to its own generation. Comparing against the
  last *published* generation, not the last *started* one, is what
  keeps a failed newer call from permanently blocking an older one's
  good data: if a newer call's fetches reject, it never reaches the
  publish step at all and never touches `publishedGeneration`, so an
  older, still-in-flight call that later succeeds finds its own
  generation still greater than whatever was last actually published
  and publishes normally — comparing against "started" instead would
  have left the shared maps stuck on a stale snapshot indefinitely,
  since the newer call that "won" the comparison never published
  anything to begin with. The original race this guard exists for is
  still covered: if a *faster* newer call publishes before a *slower*
  older one resolves, the older one's generation is no longer greater
  than the newer one's already-published generation, so it's correctly
  suppressed. A superseded response still returns its own freshly
  fetched data to *its own* caller (nothing wrong with what it fetched,
  only with letting it overwrite something newer), it just doesn't
  publish that snapshot for everyone else to read afterward.
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
- `prompt.resolve` → calls `grammar.resolve(params.text, { devices, zones
  })` but doesn't forward its result as-is: `action` is `resolve()`'s
  internal, write-ready shape for `run()` to re-resolve and consume (see
  `core/grammar.mjs` above), not the public shape design.md's protocol
  section defines for this RPC method (`{ matches: [{ label, line?, why
  }], room? }` — no `action` field). When `resolve()` returns `room`,
  `rpc.mjs` forwards `{ matches: [], room }` unchanged — that's already
  the public shape. When it returns `action`, `rpc.mjs` looks up
  `devices[action.deviceId].name` (synchronous, no `await` in between —
  unlike the write path below, there's no in-flight-write window here
  for `devices` to go stale under) and replies `{ matches: [{ label,
  line: params.text, why }] }` — the documented shape requires `why` on
  every match, not just the ambiguous/dead-end ones, so this branch
  can't omit it either. `why` here is `grammar.mjs`'s own
  `formatCapabilityWhy(action.capabilityId, action.value)` — the same
  shared function `here.mjs`'s per-device row calls to format a
  capability's current value (above), not a second copy of the same
  five-capability formatting duplicated in `rpc.mjs`. `params.
  text` is already a valid line for this exact write, since resolving it
  to an `action` at all means it unambiguously names one, so a live
  wrapper's Enter/Tab can send the original text straight back through
  `prompt.run` with nothing to reconstruct. Any other case (ambiguous, no
  match, or one of
  `resolve()`'s single-candidate dead ends) is already `{ matches: [...]
  }` with no `action` or `room` present, and needs no translation.
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
as named subcommands, checked *before* anything else — checking them
first, not a catch-all phrased as "anything that isn't `setup` or `rpc`,"
is what correctly excludes `status` from being sent to `prompt.run` as
the literal text `"status"`. Only once none of the three named
subcommands match is the invocation treated as a prompt line — `bin/uchi
desk 40` joins `argv.slice(2)` with spaces and sends it as `prompt.run {
line }`. On `{ ok: true }`, exit 0 silently (matching a successful
command-line tool's convention). On failure, `prompt.run` can come back
three different shapes (per `core/grammar.mjs`'s `run()` above), and the
dispatch must check for `error` and `room` *before* touching `matches` —
a real write failure carries no `matches` field at all, so checking
`matches.length` first would throw or misreport on that case:
- `{ error }` — the write itself failed (Homey rejected it, or the
  request errored): print `error` and exit 1.
- `{ room }` — a bare zone query, not a failure to disambiguate: print
  `room.name` (the name travels with the id from `resolve()`, per
  `core/grammar.mjs` above — `bin/uchi` has no zone map of its own to
  look one up in otherwise) and exit 0 — this is a successful room-query
  result quietly not being a device write, not an error state.
- `{ matches }` — ambiguous, no match, or a single-candidate dead end
  (out-of-range, non-numeric, or zero-or-ambiguous-capability, per
  `core/grammar.mjs`'s `resolve()` above — those also return their
  reason as a one-entry `matches` array, not a separate field):
  `matches.length > 0` prints each candidate's `label`/`why` (one line
  each, whether there's one reason or several real candidates to choose
  from) and exits 1; zero matches prints "no match for '<line>'" and
  exits 1 — the one-shot disambiguation behavior design.md's
  `prompt.resolve` section specifies for a non-interactive caller.

Add `uchi status`: calls `state.get`, prints `hero.summary`, and if
`hero.room` is non-null, the room's name and its devices' `why` values —
this is literally "prints the hero line," phase 2's second done-criterion,
verbatim.

A plain prompt line (`bin/uchi desk 40`) never calls `state.get` itself
— only `uchi status` does — so it resolves against whatever `devices`/
`zones` snapshot the core currently holds, which is fresh only if this
is the process's first request since startup or since the last
`state.get`. Phase 1's idle-exit timer (60s of no client connected)
bounds how stale that snapshot can get in practice: a burst of `bin/uchi`
invocations issued close enough together to share one still-running core
process can see a device renamed or added via the Homey app in between
resolve against the pre-rename snapshot until something calls `state.get`
again (an intervening `uchi status`, or a future wrapper's own refresh)
or the core exits idle and the next invocation spawns fresh. Refreshing
`devices`/`zones` on every `prompt.run` too would close this gap
completely, at the cost of an extra HTTP round trip on every write —
directly working against the snappy, one-shot feel `uchi desk 40` (this
phase's own literal done-criterion) is supposed to have; this plan
accepts the narrower, bounded staleness instead of paying that cost on
every single write.

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
`capabilitiesObj` per device, `zone` per device and mood, `min`/`max` on
every numeric capability — required for the range-check test above to
mean anything, not just `value`/`type`/`getable`/`setable`), plus a small
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
- Grammar: `"desk 40"` resolves to `{ matches: [], action: { deviceId:
  <Desk Lamp's id>, capabilityId: "dim", value: 0.4 } }` (design.md's own
  first example row, plus the percent→normalized conversion this plan
  adds — asserting the exact resolved `action`, not just that it
  resolves at all, is what would have caught the original
  percent/normalized gap); a value outside a capability's `min`/`max`
  (e.g. a temperature past 35°) returns the out-of-range dead end, not a
  clamped or rejected write attempt; `"kitchen+office"`-style joins are
  **not** tested since chaining/join is out of phase 2's scope — instead
  assert that a query naming a multi-kind zone (Living Room: lights +
  speaker + thermostat) with a bare number returns the "needs a word"
  dead end, not a guess; assert `"front door unlock"` (design.md's own
  example, with the verb) resolves to `{ matches: [], action: { deviceId:
  <Front Door's id>, capabilityId: "locked", value: false } }`; assert a
  bare `"front door"` (a device with no verb or value) resolves to the
  "needs a verb or number" dead end, not `"front door 0"`'s effect — the
  regression test for `Number("")` coercing to `0` instead of `NaN`;
  assert a bare `"office"` (no verb/value) resolves to `{ matches: [],
  room: { id: <Office's zone id>, name: "Office" } }`; assert two fixture
  entries sharing an exact name (added to the fixture specifically for
  this case, in two different zones) resolve as ambiguous `matches`,
  not an arbitrary pick, with each candidate's `label` zone-qualified
  and distinct from the other's.
- Recent: appending a log entry and reading it back renders the expected
  `why`/`line`, including the `dim`/`volume_set` percent-conversion (a
  raw `0.4` entry renders `"40%"`, not `"0.4%"` or `"0.4"`); a
  `cause: "prompt"` entry's `why` includes the `"(you)"` marker and
  renders `in: true`, and a `cause: null` entry's `why` doesn't and
  renders `in: false`; a `kind: "notification"` entry renders as
  `{label: ownerName, why: excerpt, in: false}` with no `line`; appending
  the same notification `id` twice (simulating a re-poll) doesn't
  duplicate the row; `seedNotificationIds` followed by
  `appendNotification` for
  one of those same ids appends nothing. (The self-write-echo registry,
  the serialized `write()` function, and the `alarm_contact`/
  `alarm_motion` going-true filter all live in `core/index.mjs`'s
  `onChange` handler, not `log.mjs`/`recent.mjs`, and need a real
  realtime connection to exercise meaningfully — covered by the live
  verification steps below, not a fixture unit test.)
- Here: `compute(null, ...)` returns `null`; `compute(<an unknown zone
  id>, ...)` also returns `null` (the stale-context guard); `compute(
  <Kitchen's zone id>, ...)` returns Kitchen's 5 lights and no moods
  (none of the three fixture moods are zoned to Kitchen); a fixture
  device with both `onoff` and `dim` renders `why`/`line` from `dim`,
  matching the documented priority order.

## Verification (run these, in order)

1. `cd core && node --test` — all of phase 1's existing test plus the
   three new suites above (grammar, recent, here), against the fixture,
   no real Homey needed.
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

- **Active-mood count in `hero.summary`** — design.md names it as the
  third component of Hero's summary line ("presence, active moods, total
  draw"), alongside presence and total draw, both of which phase 2 does
  implement (see `rpc.mjs`'s `state.get` above). The verified mood shape
  (`{id, name, preset, devices, zone, uri}`) has no `active` flag, and
  nothing in phase 2 calls `moods.setMood` (mood activation is deferred,
  next bullet) — tracking "moods activated since core startup" would
  track an event that can never happen yet. Revisit once mood activation
  itself is real and there's a genuine "active" signal to summarize.
- **The `state.changed` push and a connected-socket broadcast path** —
  `core/rpc.mjs` stays a plain request/response dispatcher this phase
  (see `core/rpc.mjs` above); phase 2's only client, `bin/uchi`, is
  one-shot and never has a connection open to push to. Belongs in phase
  3, the first long-lived wrapper (Omarchy panel), against a real
  consumer that actually needs to know when to re-fetch without polling.
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
  expected, just growth. **Light color and color temperature are a
  different kind of gap, not just an unbuilt item on this list** — see
  design.md's "Known gap, not yet designed" note under the prompt grammar:
  `light_hue`/`light_saturation`/`light_temperature` are real, confirmed
  capabilities on live devices with no word or value syntax designed for
  them at all, unlike the items above, which already have a named word or
  syntax waiting to be implemented. Design the syntax before building it.
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

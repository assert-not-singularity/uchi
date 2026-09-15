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
and apply a bare number to its one obvious capability. The full grammar
(words, verbs beyond on/off, notches, scale, chaining, kinds, `grp`/`ungrp`)
is explicitly **not** phase 2 — see "Deferred past this phase" below.

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
  of these), call `device.makeCapabilityInstance(capabilityId, (value) =>
  onChange({ deviceId: device.id, capabilityId, value }))`. This is the
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
entries, oldest dropped first. Not persisted to disk: design.md's Habits
(phase 5) is the feature that actually needs a *durable*, multi-week log
("each of your interactions is logged with a full house+desktop snapshot");
Recent (this phase) only ever shows the last `recentRows` entries of the
current process's lifetime, so an in-memory buffer that resets on core
restart is sufficient and avoids designing a durable log format twice.
Revisit this file when phase 5 actually needs persistence.

- `append(entry)` — a capability entry is `{ ts, kind: "capability",
  deviceId, capabilityId, from, to, cause }`; a notification entry (below)
  is `{ ts, kind: "notification", id, ownerName, excerpt }`. `kind`
  discriminates the two in `recent.mjs`. For a capability entry, `cause`
  is `"prompt"` when the write went through `prompt.run` (see `rpc.mjs`
  below) and `null` for everything observed via `subscribeToDiscreteChanges`
  that we didn't just cause ourselves; a notification entry's real
  `ownerName` (`"Anwesenheit"`, `"Flow"`, `"Apps"`, ...) *is* its cause —
  no `null` case there, per the verified `getNotifications()` finding
  above. Two independent kinds of noise get suppressed before an
  incoming capability change is appended, both confirmed against this
  real house, not assumed:
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
    flicker, not two real changes. This is a different case from the echo
    above (there the *repeated* value is the same as what we just wrote;
    here the capability *returns* to what it was *before* the most recent
    logged change) — track the pending `A → B` entry for 2 seconds after
    appending it, and if a `B → A` arrives inside that window, remove the
    pending entry instead of appending the revert, leaving no trace of
    either half.
- `appendNotification(entry)` — same buffer, `kind: "notification"`;
  deduped by `id` (the notification's own real id) rather than by time
  window, since `getNotifications()` is polled (see `index.mjs` below)
  and would otherwise re-append the same still-present entries every poll.
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
- A `kind: "capability"` row: `{ id, label, why, line }` — `label` is
  `"<device name>"`, `why` is a plain rendering of the transition
  (`"→ on"`, `"dimmed to 40%"`, `"locked"`) built from
  `capabilityId`/`from`/`to`, plus `"(you)"` appended when `cause` is
  `"prompt"` (design.md's "in/out filter" — the closest honest rendering
  of in/out attribution phase 2's data actually supports for this row
  kind), `line` is the grammar line that undoes it (`"<device name>
  <from-value>"` for a value-bearing capability, `"<device name>
  off"`/`"<device name> on"` for `onoff`, `"<device name>
  unlock"`/`"<device name> lock"` for `locked`). A `null` `from` (the
  device's first-ever observed value this process) has no undo line —
  `line` is omitted from that row.
- A `kind: "notification"` row: `{ id, label, why }` — `label` is the
  entry's real `ownerName` (`"Anwesenheit"`, `"Flow"`, `"Apps"`), `why` is
  its `excerpt` verbatim. No `line`: a notification isn't a device state
  to revert, it's a fact that happened, matching design.md's own doorbell
  example ("a doorbell is simply the newest change... carrying `haustür
  unlock` instead" — an *event-table* line, which is `events` in
  `readCoreConfig()`, not something derived from the notification text
  itself; phase 2 doesn't implement the event-table lookup, so a
  notification row is line-less until whichever phase wires `events` up).

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
     device whose `capabilities` include the matching capability
     (`onoff` for on/off, `locked` for lock/unlock); anything else in
     `rest` is parsed as a bare number.
  4. A bare number in `rest` resolves only if the matched thing is a
     **device** (not a zone — see the multi-kind-zone finding above) whose
     `capabilities` contains exactly one of `dim`/`target_temperature`
     /`volume_set` (checked in that order; a device is never expected to
     have more than one in phase 2's real data, but the order is
     deterministic either way). Zero or more-than-one such capability is a
     dead end with `why: "needs a word"` — the real word grammar
     (design.md's full word list) is deferred, so this phase can name the
     problem but not solve every case; it's still strictly better than
     silently guessing wrong.
- `run(line, { devices, zones, setCapabilityValue })` — the `prompt.run`
  implementation: re-resolves `line` via `resolve()`; if it resolves to
  exactly one device+verb/value, calls `setCapabilityValue` and returns
  `{ ok: true }`; otherwise returns `{ ok: false, matches }` (ambiguous or
  no match — `bin/uchi` prints the candidates and exits non-zero, per
  design.md's one-shot-caller behavior).

No `?` (list applicable words), no chaining (`,`/`;`), no exclusions
(`-thing`), no join (`thing+thing`), no kinds (`son`/`light`/`temp` as a
`thing`), no notches/scale — all explicitly out of scope, see "Deferred
past this phase."

### `core/here.mjs` (new)
`compute(zoneId, { devices, zones, moods })` → `{ id, name, moods: [...],
devices: [...] }` or `null` if `zoneId` is `null` (no `machineRoom` known
yet, per the `context.set` finding above). `moods` filters the mood map by
`mood.zone === zoneId`; `devices` filters the device map by `device.zone
=== zoneId`, each rendered as `{ id, label, why, line }` matching the row
contract every section uses (`why` here is just the device's current
primary value, e.g. `"40%"`/`"on"`; `line` is the same undo-style line
`recent.mjs` builds for a re-apply, reusing that formatting logic — factor
the shared from-value → line renderer into `grammar.mjs` so `here.mjs` and
`recent.mjs` don't duplicate it).

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
...")` already sits): call `subscribeToDiscreteChanges` wiring each
change into `log.append(...)` (with a fresh-value dedupe check against
the device's last-known value so the *first* fetch's already-current
values don't get logged as "changes" the instant subscriptions start),
and hold `devices`/`zones`/`moods` plus an in-memory `context` object
(`{ machineRoom: null, idle: null, mic: null, media: null }`, updated
only by `context.set`) in variables the `methods` table's closures
below can read. Device/zone/mood maps are refreshed by re-fetching on
each `state.get` call rather than kept live-updated from CRUD events —
phase 2 has no device-added/removed test scenario to justify the extra
complexity of consuming `Manager`'s own `.create`/`.update`/`.delete`
events; a per-call refetch is one extra HTTP round trip and correctness
now, revisit only if `state.get` latency becomes a real problem.

Also start a `setInterval(..., 30_000)` polling `homey.getNotifications(api)`
and calling `log.appendNotification(...)` for any entry whose `id` isn't
already in the log — no realtime "notification created" push was found or
verified in `homey-api`'s exposed surface (unlike capability changes,
which genuinely are push-based), so polling is the honest approach here,
not a shortcut; 30s balances staleness against hammering the API for a
row kind that's inherently lower-frequency than capability changes.

### `core/rpc.mjs` (no structural change)
Untouched — phase 1 already factored dispatch as a plain `{method:
handler}` table passed in from `index.mjs`; phase 2 just grows that table
in `index.mjs`:

- `state.get` → real `{ hero, recent, attention: [], here, habits: [] }`.
  `hero` is `{ room: here.mjs's compute(context.machineRoom, ...) result,
  summary: <one-line string> }` — `summary` is built from the same
  `devices`/`zones`/`moods` maps: count of devices with `onoff===true` or
  `dim>0`, sum of `measure_power` values across all `capabilitiesObj`
  entries (Watts, confirmed present in this house), count of active moods
  (a mood has no "active" flag in the verified shape above — approximate
  "active" as "activated within the process lifetime" via a small
  in-memory set updated whenever `moods.setMood` runs; moods activated
  before the core started aren't retroactively knowable, which is an
  acceptable phase-2 gap since mood activation itself isn't implemented
  yet — see below). `recent` is `recent.mjs`'s `list()`. `attention`/
  `habits` stay the literal empty arrays from phase 1 (unchanged — those
  are phases 4/5).
- `context.set` → merges the given fields into the in-memory `context`
  object; no response body needed beyond `{}` (design.md lists no `result`
  shape for it).
- `prompt.resolve` → `grammar.resolve(params.text, { devices, zones })`.
- `prompt.run` → `grammar.run(params.line, { devices, zones,
  setCapabilityValue: (device, capId, value) => { homey.setCapabilityValue
  (device, capId, value); log.append({ ..., cause: "prompt" }) } })` — the
  log-append happens here, at the call site that *knows* it's a
  prompt-caused write, not inside `homey.mjs`'s thin wrapper, keeping the
  cause-tagging logic in one place next to the only thing that can honestly
  claim it.

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
   showing the new value and a Recent row with `cause: "prompt"`.
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
- **CRUD-event-driven live device/zone/mood maps** — re-fetching per
  `state.get` call is phase 2's deliberate choice; only revisit if it's
  measurably too slow against a real house.
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

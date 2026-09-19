# Uchi — design reference

## What it is

A command-line interface to a Homey Pro smart home. The prompt is the primary mode of
interaction — everything else (Recent, Attention, Here, Habits) is reporting and
suggestion, and most rows those sections show are themselves a proposed prompt line,
runnable with Enter. Some are purely informational (a sensor reading in Attention,
say) and carry no line at all.

## Architecture: core + wrappers

Two processes, one contract:

- **The core** (`core/`, Node ≥ 22) owns the Homey connection (`homey-api`, local API,
  realtime capability events — no polling), the append-only log, the situation model,
  attribution, event handling, and every computed list the panel shows. It is a
  newline-JSON RPC server over a Unix socket, JSON-RPC-styled but not the literal
  spec — see Protocol below.
- **A wrapper** draws UI, handles input, and forwards desktop context (`context.set`)
  that only it can know: idle state, mic-live, media-playing, which room the machine
  is in. It never ranks, never parses the grammar, never talks to Homey directly.

The first wrapper is an Omarchy 4 shell plugin (Quickshell/QML: bar pill + panel).
A TUI and a CLI (`bin/uchi`) are other clients of the same socket. Nothing about the
core should assume Omarchy exists.

**What the split explicitly refuses:**
- No backend abstraction — Homey only, not a multi-vendor smart-home layer.
- No wrapper framework — a wrapper is any program that speaks the socket protocol.
- No remote access — the socket is local; a second machine runs its own core.
- No versioning ceremony beyond one `protocol` integer in the hello handshake.

## Protocol (newline-delimited JSON, over `$XDG_RUNTIME_DIR/uchi.sock`)

JSON-RPC-styled, not the literal JSON-RPC 2.0 spec (no batching, no fixed error
codes). One JSON object per line, of two kinds:

- **Request/response** — wrapper → core carries `{ "id": N, "method": "...",
  "params": {...} }`; core → wrapper echoes the same `id` with
  `{ "id": N, "result": {...} }` or `{ "id": N, "error": { "message": "..." } }`.
  `id` is a per-connection counter the sender picks, so a client can match a
  response to its request even if a push arrives in between.
- **Push** — core → wrapper only, unsolicited, carries no request `id`: always
  an `event` key names the push (`{ "event": "state.changed", ... }`). That's
  the discriminator a client checks — not whether `id` is present, since the
  `event` push type below also carries its own `id` field as ordinary payload
  (the row being reported), not a request correlation id.

Methods and pushes, by name (`params`/`result` shapes only, envelope omitted):

```
// wrapper → core
hello            { client, protocol }                      → { protocol, homey, connected }
state.get        {}                                        → { hero, recent[], attention[], here, habits[] }
context.set      { mic, idle, media, machineRoom }
prompt.resolve   { text }                                  → { matches: [{ label, line?, why }], room? }
prompt.run       { line }                                   // also what bin/uchi sends
row.dismiss      { id }        row.snooze { id, days }      row.mute { id }
room.pin         { zone }      room.unpin {}

// core → wrapper, pushed
state.changed    { sections: [...] }        // wrapper re-fetches what changed
event            { id, kind, title, urgency, line? }
connection       { connected, reason? }
```

Every row the core returns carries `id`, `label`, `why`, and — if it has one — `line`:
the grammar line that row proposes. A wrapper renders those four fields and sends
`line` to `prompt.run` on Enter, or into the prompt field on Tab. **There is no
per-section action method for the action a row proposes** — that always goes
through `prompt.run`, including what rows in Recent/Attention/Habits propose and
what `bin/uchi` sends on the command line.

`row.dismiss`/`row.snooze`/`row.mute` and `room.pin`/`room.unpin` are the
deliberate exception: they act on the row or the panel itself, not on a device,
so there's no grammar line for them at all — "snooze this specific alert 30
days" isn't a sentence you'd type. Those five methods exist because `prompt.run`
has nothing to send them.

`prompt.resolve` is called on every keystroke, not just on Enter — it's the
safe, side-effect-free half of the pair; `prompt.run` is the one-shot call that
actually does something, on Enter only. The core does all matching centrally,
so calling it live costs nothing architecturally, and nothing meaningful in
latency either: the socket is local, not a network call, so per-keystroke round
trips need no debouncing for correctness. An interactive wrapper renders
whatever `matches` currently holds as a live candidate list; a one-shot caller
with no interactive loop (`bin/uchi`) instead prints the candidates and exits
non-zero when there's more than one, asking for one more distinguishing
keystroke rather than guessing.

## The prompt grammar

```
[thing[+thing…]] [-thing…] [word] [value] [, segment…]

thing    device name · zone name · mood · flow · kind (son=every Sonos,
         light=every light, temp=every thermostat) · omitted = whole house
word     capability: temp · light · vol
         verb:       off on play pause next grp ungrp lock unlock
value    absolute  40
         step      +10  -10
         scale     *2   /2      (levels only: dim, volume — clamps at 0/100)
         notch     ++   --      (one fixed step per kind, from core config)
chain    , or ;    a segment starting with a word inherits the previous subject
?        lists the words that apply to the current match
```

Resolution order: **exact** match → **fuzzy** match → **grammar** parse → **agent**
(only on Enter, only if 1–3 found nothing; must return one chain in this same
grammar or its output is rejected — it never runs directly, and it can never touch
`lock`/unlock verbs).

Exact and fuzzy aren't two independent passes over the whole input: a full-name
match is the degenerate case of a prefix match (a prefix that happens to consume
the entire name), so both are priority levels checked together at each candidate
length, longest length first — a same-length exact match wins over a same-length
partial-prefix match (so a zone named "Attic" doesn't dilute a query for
"Attic Switch," typed in full, into a false three-way tie), and a longer match
of either kind still wins over a shorter one. Fuzzy itself has two levels: a
token-aligned prefix (the candidate must equal a name's own leading word(s)
verbatim — "desk" matches "Desk Lamp" but not "Desktop Machine"), then, only if
that finds nothing, a substring check against any single token of the name —
the fallback for a single-token (often compound) name with no word boundary to
align a prefix against at all. Neither fuzzy level ranks or scores candidates:
a unique hit resolves, more than one is an ambiguous candidate list exactly like
exact match's own tie case, never a silently auto-picked "best guess" — this
grammar writes to real devices, so it never guesses when it isn't sure.

The system always wants the least you can type. Every match — thing, word, or
an otherwise-ambiguous value target — narrows as you type rather than requiring
a fully-qualified line up front: enough keystrokes to be unique resolves
outright, and anything less that still narrows the field is a candidate to pick
from, not something to keep typing past. The rules below (word prefixes, the
value-target default) are instances of this one principle, not separate ones.

Sign disambiguation: a sign before digits is a step (`+10`); before a name it's an
exclusion (`-kitchen`) or (as `+`) a join (`kitchen+office`); alone, doubled, it's a
notch (`kitchen++`).

Several devices can share the exact same literal Homey name (a common naming
pattern, not a hypothetical — many houses have more than one "Ceiling Light").
When that produces an ambiguous match, a trailing zone name narrows it to one
device (`ceiling light kitchen`), checked only against the zones the ambiguous
candidates actually span — an unrelated zone whose name happens to contain the
same letters never competes. This is device-then-zone order only; there's no
reverse form.

A token that names a kind (`son`, `light`, `temp`) is parsed as the `thing`, not
the `word`, whenever it appears in thing position — so `temp -bedroom 20` reads
as the kind *every thermostat*, excluding the Bedroom's, with no separate `word`
needed since the kind already names the one capability that kind controls.

When `word` is omitted, a bare `value` targets the thing's own obvious
capability — a light's level, a thermostat's target, a speaker's volume — which
only resolves when the thing has exactly one of those. A thing with more than
one (a zone with lights, a speaker, *and* a thermostat) requires an explicit
`word`; the grammar rejects the ambiguous form with `?` rather than guessing.

`grp` and `ungrp` are the two words that take a trailing operand — a zone list
naming where to look for members of the thing's kind: `son grp living+office`
groups the Living Room's and Office's Sonos speakers. Every other word
(`off on play pause next lock unlock`) takes none. `grp`/`ungrp` run through
Homey's flow-action-card mechanism, not a capability write.

A `word` needs only its shortest unambiguous prefix, at least two characters:
`li` matches `light` (`lock` starts `lo`), `gr` matches `grp` (`ungrp` starts
`un`). This is prefix matching against the fixed twelve-word list, not the
fuzzy matching used for device/zone/mood/flow names — the list is small and
known in advance, so uniqueness is checked once, never against live house
state. An ambiguous prefix (`l` alone, matching both `light` and `lock`)
behaves like any other ambiguous grammar form: `?` lists the candidates rather
than guessing.

**Known gap, not yet designed:** light color (hue/saturation) and color
temperature (warm–cool) have no word or value form anywhere in this grammar.
Real lights expose them as their own capabilities (`light_hue`,
`light_saturation`, `light_temperature`, distinct from `dim`), confirmed live
against a real house — this isn't a hypothetical. Unlike the items under
"Explicitly decided against" below, this was never evaluated and rejected;
it's simply missing. Design it (a `color` word, a value syntax for hue/
saturation, and how it interacts with `light_mode`) before any phase claims
color control as done.

## Config: two files, two owners

- **Wrapper-local**, e.g. `~/.config/omarchy/shell.json` for the Omarchy plugin:
  only what that wrapper alone needs — `machineRoom`, an optional bar label.
- **Core config**, `~/.config/uchi/config.json`, shared by every wrapper:
  `notches` (per-kind step sizes, e.g. `{"light":10,"vol":5,"temp":1}`), `events`
  (name → `{line, ttl}` for doorbell/etc.), `recentRows`, `people` (for name-based
  attribution), `agent` (`"off" | "default" | "claude"`).

Rule of thumb for where a new setting goes: **if two wrappers could disagree about
it, it belongs in the core's config, not a wrapper's.**

The Homey API token lives at `~/.local/state/omarchy/settings/uchi.json`, mode
`0600`, written by `uchi setup` (gum prompt in a floating terminal), read only by
the core. Never in either config file. This path is deliberately
Omarchy-specific for now — it matches the one real wrapper that exists and
`uchi setup`'s own home. `core/` staying wrapper-agnostic elsewhere doesn't
extend to this path yet; a future non-Omarchy wrapper (a bare CLI/TUI install
with no Omarchy plugin system around it) would need this made configurable or
moved under a generic XDG path — an explicit scope decision, not an oversight,
since no such wrapper exists yet to design it against.

## Panel sections (what the core computes, wrappers only render)

- **Hero** — the wrapper's own room (from `machineRoom`), plus a one-line summary of
  what's happening elsewhere (presence, active moods, total draw).
- **Recent** — last discrete state changes, newest first, with cause and an undo
  `line`. Discrete = onoff, dim, locked, contact/motion going true, playing state,
  targets, moods, flows, presence, notifications. Explicitly **excludes** every
  `measure_*`/`meter_*` continuous reading. Changes within 2s of a mood/flow fold
  under it. A Homey Group's member-device changes fold into the group's own row,
  not one row per member; a device's coincident `onoff` + numeric-target change
  folds into one row (the `onoff` transition's wording wins over the specific
  level reached); a numeric-target-only change (a scene's smooth transition, say)
  debounces so its intermediate steps settle into one row rather than logging
  each step.
- **Attention** — alarms (active, pinned) → faults (unreachable > 1h, battery < 15%,
  snoozable) → anomalies (> 3 spreads from the hourly baseline, baseline shown) →
  open loops (something on far longer than its own history, with an off `line`).
- **Here** — `machineRoom` by default, or a room pinned via `room.pin` (until
  `room.unpin` or the next room query overrides it) — its moods as chips, its
  controllable devices. Never inferred from desktop activity, in either case.
  (An inference ladder for a hypothetical laptop wrapper is out of scope for v1.)
- **Habits** — 1–3 suggested `line`s. Not time-bucket counting: each of *your*
  interactions is logged with a full house+desktop snapshot; measurements are
  normalized (log-scale + per-device z-score from Insights, not banded — avoids
  threshold flapping); train a **logistic regression** per interaction nightly on
  the decayed log (accepted suggestions weighted half, 8-week half-life); score
  only interactions seen ≥ 4 times; show the top 3 above a threshold with their
  count. A one-hidden-layer net on the same normalized inputs is the natural
  upgrade once feature interactions matter — same log, same row shape, no rewrite.
  Silent for the first two weeks (no log yet). Training examples are only your own
  interactions (from this panel, or your named devices); everyone else's activity
  is context/features only, never an example — this is what keeps a second
  household member's habits from leaking into suggestions, without any attribution
  system beyond device naming.

## Keyboard (interactive wrappers)

Typing, `↑`/`↓` (or `j`/`k`) to move the cursor over a `prompt.resolve`
candidate list, `Enter` to run the highlighted candidate's `line` through
`prompt.run`, and `Esc`/`Backspace` to clear the prompt or close the panel.
That's the complete set.

Every other key this section once specified — `Tab`, `Shift+Tab`, `h`/`l`
(notch step), `x` (dismiss/mute), `s` (snooze), and `a` (all off) — is
deliberately absent, not just unbound. A capability like `onoff` can't tell a
light from a socket keeping other equipment powered, so a hotkey that acts on
"whatever's under the cursor" or "everything in this room" with no per-device
judgment is unsafe by construction; see "Explicitly decided against" below.
`row.dismiss`/`row.snooze`/`row.mute` still exist as RPC methods (Attention/
Habits rows can propose them once phase 4/5 build the sections that need
them) — only the blind keyboard shortcuts for them are rejected.

A one-shot caller (`bin/uchi`) has none of this — see `prompt.resolve` above
for how it handles the same ambiguity without an interactive loop to navigate.

## Example prompts

A fictional house, reused below and worth reusing again for the recorded-house
test fixture — every device named anywhere in this document is declared here,
so the fixture is reproducible on its own:

- **Kitchen** — 5 lights, a Kitchen Switch (a physical remote).
- **Living Room** — 4 lights (including a Floor Lamp), a TV, a Sonos speaker, a
  thermostat, a Sofa Switch (a physical remote).
- **Office** — a Desk Lamp, a Sonos speaker, the desktop machine itself (a
  metered smart plug), a space heater (another metered smart plug), a Do Not
  Disturb switch.
- **Bedroom** — a Bedside Lamp, a window contact, a thermostat.
- **Hallway** — a motion sensor, the Front Door lock.
- **Bathroom** — no devices used in any example below.

Moods: Movie Night, Morning, Bedtime. One flow: Bedtime Routine.

| Prompt | Result |
|---|---|
| `desk 40` | "Desk" matches only the Desk Lamp — dims it to 40% |
| `living temp 21` | Living Room's thermostat target becomes 21° |
| `kitchen+office light 20` | Kitchen and Office lights both dim to 20% — `word` is required since the Office also has a speaker |
| `temp -bedroom 20` | Every thermostat except the Bedroom's is set to 20° |
| `living light /2` | Living Room's lights halve from wherever they are, keeping the scene's shape rather than flattening it to one level — `word` is required here since the room also has a speaker and a thermostat |
| `son grp living+office` | Groups the Living Room's and Office's Sonos speakers |
| `front door unlock` | Unlocks the Front Door |
| `movie night` | Activates the Movie Night mood |
| `office` | A bare zone query — lists the Office's devices (and any moods scoped to it); **Enter** pins it as Here via `room.pin`, until unpinned or another room is queried |
| `desk?` | Lists the words that apply to what's typed so far |

## Example: a Friday evening

Same fictional house. It's 22:48; a desktop machine in the Office has been
drawing over 100W all evening — the kind of session the situation model has
learned to associate with the suggestions below, purely from correlating this
wattage band with past habits, no mode ever named or classified. Someone else
in the household is home, in the Living Room.

**Recent** (newest first, each with its cause):
- Living Room TV — paused · the Homey app · 22:03
- Kitchen lights — 5 lights → off · Kitchen Switch · 21:30
- Movie Night (mood) — TV, 4 lights, Speaker · Sofa Switch · 19:42

**Attention:**
- Hallway motion sensor — battery 6%, been this way for weeks, nobody's looked
- Office space heater — on for 6 hours; usually off within 30 minutes of the
  room reaching its target, `line: heater off`
- Bedroom window — open 40 minutes, the room is cooling and heating starts at
  23:00 (a sensor reading, so no action line — just a warning)

**Habits** (each row is a situation match, not a clock):
- "Desk Lamp to 20%, Speaker on" — desk lamp near 20% with the speaker on, 9 of
  the last 11 evenings
- "Do Not Disturb on" — the microphone is live on this desktop, 5 of the last 6
  times that happened during a call
- "Bedtime Routine" (flow) — after 22:30 with Movie Night paused, 9 of the last
  10 nights; turns off 7 lights, the TV, and the speaker

## Repo layout (target)

```
uchi/
  manifest.json              # Omarchy plugin manifest, at repo root
  Service.qml                # wrapper: spawn-or-connect to core, context.set
  BarWidget.qml               # wrapper: the bar pill
  Panel.qml                  # wrapper: prompt + 4 sections, keyboard
  core/
    index.mjs                # entry: settings, connect to Homey, start rpc.mjs, idle exit
    rpc.mjs                   # socket server + JSON-RPC dispatch/framing
    homey.mjs                 # homey-api: events in, verbs out
    config.mjs                 # phase 1: read the credentials file only (written by
                               # `uchi setup`); phase 2 adds reading the separate shared
                               # core config, ~/.config/uchi/config.json (see Config above)
    validate.mjs               # one-shot: validate address+token over stdin, for `uchi setup`
    log.mjs                   # append/tail/snapshot
    recent.mjs attention.mjs here.mjs habits.mjs
    grammar.mjs                # exact/fuzzy/thing-number parser
    model.mjs                  # normalize, nightly train, score
    package.json + package-lock.json + node_modules  # vendored, lockfile pinned — `omarchy plugin add` runs no install hooks
    test/                       # node --test, against a recorded house fixture
  bin/uchi                    # CLI: thin client on the same socket
  tui/                         # later
  docs/design.md               # this file
```

## Build order (phased; each phase has a concrete "done" check)

1. **Skeleton** — manifest; `core/` with `homey-api` vendored (connect, print
   device count); the socket server and JSON-RPC dispatch (`hello`, a stubbed
   `state.get`); `uchi setup`/`uchi rpc` as a CLI client; a minimal Service.qml
   (spawn-or-connect, an `IpcHandler` that pings through the socket). Enough to
   prove the whole QML→socket→core→socket→QML path once, before any real
   feature sits on top of it. Done: `omarchy plugin validate` passes, core
   prints device count, `uchi rpc hello ...` round-trips through the actual
   socket, and `omarchy shell uchi ping` confirms the QML side believes it's
   connected (cached state, not a fresh round trip on that call — see Protocol
   above).
2. **Core, for real** — `state.get` returns real hero/Here data, verbs, log
   with causes, Recent (log-derived, in/out filter, undo lines), grammar
   (exact/fuzzy/thing-number). `bin/uchi` gains real commands. Tests against a
   recorded house fixture. Done: `uchi desk 40` works from a terminal,
   `uchi status` prints the hero line.
3. **Omarchy panel** — BarWidget.qml (pill, 5 states), Panel.qml (prompt +
   Recent + Here, menu rows), `context.set` wired to real desktop signals.
   Done: the example prompts above resolve and run in the real panel, minus the
   agent path.
4. **Attention** — faults from live state, event table (expiry + actions),
   notifications out at correct urgency, nightly Insights baselines, anomalies,
   open loops. Done: matches the Friday-evening example above (the fault, the
   open loop), plus a live event — a doorbell notification, say — arriving as
   the newest Recent row with an action attached.
5. **Habits** — needs phase 2's log to have run for a while first. Normalization,
   nightly logistic regression, scored suggestions with true counts and WHY lines,
   mute, 2-week silence period.
6. **Agent path** (behind `"agent":"off"` default) + TUI wrapper (near-free once
   the protocol exists).
7. **Publish** to plugins.omarchy.org after `omarchy plugin validate` + `qmllint`.

Phases 1–3 are the product. 4–5 are what differentiates it from every other
smart-home panel (including the reference implementation studied during design,
the community Home Assistant Omarchy plugin at github.com/konradk/hass). 6 is the
payoff of the core/wrapper split.

## Explicitly decided against

- Zone-tree panel with a curated pinned list (v1) — replaced by Here (fixed) +
  prompt room-query.
- Polling — replaced by `homey-api` realtime events, for capability state:
  `makeCapabilityInstance` genuinely pushes every capability change, no
  polling needed. Notifications are the one exception: `homey-api` exposes
  no realtime "notification created" push, only `getNotifications()` as a
  point-in-time fetch, so Recent's notification rows (phase 2) poll it on
  a fixed interval instead — capability state stays fully push-based.
- Per-row action methods for what a row proposes — replaced by `prompt.run` and
  the `line` every row carries. (Dismiss/snooze/mute and pin/unpin stay as
  their own methods — they act on the row or panel, not a device, so there's
  no grammar line for them.)
- Floor-plan / spatial navigation mode — replaced by `<room> <verb>` prompt lines.
- Inferring Here from recent signals ("who's in which room") on a desktop —
  it's a fixed config value; the ladder-based inference only matters for a
  hypothetical laptop wrapper, deferred.
- A blind "all off" keyboard shortcut — a device's `onoff` capability can't
  distinguish a light from a socket keeping other equipment powered, and an
  ambient scan of "whatever's in this room" makes no per-device judgment at
  all. Any future bulk action needs an explicitly typed grammar `kind`
  (`light`/`son`/`temp`) and its own decision about which capabilities are
  safe to include — never a keyboard shortcut with no thing named.

# Uchi — Phase 1 ("Skeleton") implementation plan

## Context

Uchi is a command-line interface to a Homey Pro smart home, designed as a Node.js
"core" service (owns the Homey connection, ranking, state) behind a JSON-RPC-over-
Unix-socket protocol, with an Omarchy 4 shell plugin as its first UI wrapper. The
full product design lives in `docs/design.md` in this repo (already written).

This plan covers only **phase 1**: prove the foundational pieces — the Homey
connection, the IPC transport, and the plugin's install/validate path — actually
work on this real system, before any panel UI or ranking logic is built on top of
them. Everything in phases 2+ depends on getting these right once.

The following API and platform facts are load-bearing for this plan and are
verified against real code on this machine, not assumed from memory or docs:

- **`homey-api` (v3.20.0, real package pulled and read):** `createLocalAPI({address,
  token})` is standalone, no Homey SDK needed. Realtime capability updates are
  `device.makeCapabilityInstance(capabilityId, listener)`, which auto-connects
  per device — not the top-level `devices.connect()`, which only streams device
  add/remove events, never capability values. `device.zoneName` is a dead
  deprecated getter returning `undefined` — zone names need `zones.getZone({id})`.
  Moods, flows, and flow card actions (needed later for Sonos grouping) are all
  real and confirmed.
- **Omarchy/Quickshell (real files on this machine, Omarchy 4.0.3-1, Quickshell
  0.3.1-1):** Quickshell has a native `Socket` QML type (`QLocalSocket`-backed,
  client-only) already used in production by the installed `quickshell.spotify`
  plugin for exactly this newline-JSON-over-Unix-socket pattern — confirmed by
  reading `BackendClient.qml` directly. The real validator
  (`/usr/share/omarchy/bin/omarchy-plugin-validate`) and a real service+bar-widget
  manifest (`omarchy.media`) were read in full. Node.js is **not** an Omarchy
  dependency, but a fresh install provisions it anyway: `mise-bin` is in the base
  package set, and `all.sh` unconditionally runs `mise-work.sh` at first-boot
  provisioning, which installs Node via mise (bundled tarball, network fallback) —
  confirmed by reading both scripts directly. So `command: ["node", ...]` in a
  spawned `Process` can be relied on in the common case; only a broken/removed
  mise install is an unhandled edge case, deliberately deferred past phase 1 (see
  decisions below).

Phase-1 constraints: address and token live together in one settings file;
`uchi setup` validates the token live against Homey rather than deferring to
core startup; a minimal `bin/uchi` (setup + a raw rpc debug command) is
pulled into phase 1 so it's terminal-verifiable without installing into
Omarchy's plugin system yet; the "mise itself is gone" doctor/fallback flow
is deferred past phase 1.

## Files to create

### `manifest.json` (repo root)
The phase-1 manifest declares only the `service` kind — the plugin has no
visible UI yet, just the spawn-or-connect core lifecycle:
```json
{
  "schemaVersion": 1,
  "id": "uchi",
  "name": "Uchi",
  "version": "0.1.0",
  "kinds": ["service"],
  "keepLoaded": true,
  "entryPoints": { "service": "Service.qml" }
}
```
`kinds` omits `"bar-widget"` until `BarWidget.qml` exists (phase 3) — that
file doesn't exist yet, so there's no `entryPoints.bar-widget` to declare
against it. `keepLoaded: true` matches `omarchy.media`/`omarchy.idle` — without
it the service (and the core process/socket it owns) gets torn down when nothing
is displaying it. `id: "uchi"` passes the real validator's regex and reserved-
namespace checks (confirmed by reading `omarchy-plugin-validate`).

### `Service.qml` (repo root)
Plain `Item { id: root }` — no blocking loops; work happens in child elements.
Mirror `~/.config/omarchy/plugins/quickshell.spotify/BackendClient.qml`'s
`Socket`/`SplitParser`/`Loader`/reconnect-`Timer` shape exactly (verified real
and load-bearing, including the comment that a failed `Socket` must be recreated
via the `Loader`, never reused):

- `property var shell: null` and `property var manifest: null` — both must be
  declared even though `shell` is unused in phase 1; the host injects by
  property-existence check (confirmed against `shell.qml`), and `manifest` is
  needed to derive `pluginDir` for spawning `core/index.mjs`.
- `readonly property string pluginDir: manifest ? manifest.__sourceDir : ""`.
- The socket and the single-instance lock both live under
  `Quickshell.env("XDG_RUNTIME_DIR")`, resolved through that API (not the
  shell-style `$XDG_RUNTIME_DIR` — that's shorthand for prose, not valid QML —
  confirmed real syntax in `BackendClient.qml`, which this section was meant
  to mirror exactly), and required, not optional: `readonly property string
  runtimeDir: Quickshell.env("XDG_RUNTIME_DIR")`, `readonly property string
  socketPath: root.runtimeDir + "/uchi.sock"`, `readonly property string
  lockPath: root.runtimeDir + "/uchi.lock"`, `readonly property bool
  runtimeDirMissing: root.runtimeDir === ""`. `runtimeDirMissing` gates
  everything below it: the reconnect `Loader`'s `active` binding includes
  `!root.runtimeDirMissing`, so an empty `runtimeDir` never lets `socketPath`/
  `lockPath` fall through to root-level paths (`/uchi.sock`, `/uchi.lock`) or
  spawn anything against them — `/tmp`-style squatting isn't the only risk a
  bare string concatenation has if left unguarded. Phase 1 has no pill UI yet
  (the manifest is `service`-only; `BarWidget.qml` doesn't exist until phase
  3), so for now this surfaces as `console.error(...)` and a disabled
  `Loader` rather than a pill — wire `runtimeDirMissing` into an actual pill
  state once `BarWidget.qml` exists. Every real desktop session has
  `XDG_RUNTIME_DIR` set (`systemd-logind` provides it), so this is a fail-fast
  on a genuinely broken environment, not a realistic day-to-day case.
- Core lifecycle: `Socket { path: root.socketPath }` behind a `Loader` with a
  reconnect `Timer`; on sustained connect failure, spawn `Process { command:
  ["flock", "-n", "-E", "75", root.lockPath, "node", pluginDir +
  "/core/index.mjs"] }`, then retry the socket connect. `flock(1)` (part of
  `util-linux`, present on every Arch/Omarchy install — no Node dependency
  needed) holds a real kernel-level exclusive lock on `lockPath` for the
  wrapped process's entire lifetime and releases it automatically on any exit,
  including a crash; `-n` fails immediately rather than waiting if another
  instance already holds it, and `-E 75` makes that specific failure exit with
  code 75 (`EX_TEMPFAIL` in BSD `sysexits.h`) instead of colliding with
  whatever exit code `node` itself might produce. Code 75 is reserved
  exclusively for this: `core/index.mjs` never calls `process.exit(75)` for
  any reason of its own (its two explicit exit codes are 78 and 69, below),
  and an uncaught crash defaults to Node's own code 1 — so 75 reaching
  `Service.qml` always means `flock`, never `node`, keeping the two cases
  reliably distinguishable. This replaces an entire class of PID-file/reclaim
  logic built on `open`/`write`/`rename`/`unlink`, none of which offer a true
  atomic compare-and-swap to build real ownership on top of — `flock` gives a
  kernel-held lock instead. The spawned `Process`'s `exited(exitCode, ...)`
  signal is checked before retrying:
  - **75** — `flock` itself couldn't get the lock. Usually this means a live
    core genuinely exists somewhere: keep retrying the *socket connect*,
    don't spawn again — spawning again would just hit 75 immediately. But
    `-E 75` is also what `flock` returns if it can't open or lock `lockPath`
    at all (an unwritable or invalid runtime directory), not only "someone
    else holds it" — capture and log the spawned `Process`'s stderr on a 75
    exit (`flock` prints its own reason there) so a persistent filesystem
    problem stays visible instead of silently looking identical to "another
    core is running" forever.
  - **78** — `node` ran, and exited with its own documented
    "settings missing/invalid" code (`sysexits.h`'s `EX_CONFIG`, see
    `core/index.mjs` below). This is not transient, but it also isn't
    permanent: `uchi setup` can write valid credentials at any later time, so
    the `Timer` backs off to a slow retry (every 30s) rather than either a
    tight respawn loop or stopping altogether — stopping outright would leave
    the plugin stuck until a manual reload if it was ever enabled before
    `uchi setup` ran.
  - **69** — `node` ran, settings were fine, but the initial Homey connection
    itself failed (`sysexits.h`'s `EX_UNAVAILABLE`, see `core/index.mjs`
    below). Homey being briefly offline or rebooting isn't a code bug and
    isn't the user's fault the way missing settings are, so this gets the same
    slow-retry-forever policy as 78, not the bounded-backoff-then-stop policy
    below — nothing about retrying harder or faster fixes an unreachable
    Homey, and stopping outright would leave the plugin down until a manual
    reload for a condition that resolves itself.
  - **0** — the core's own clean, intentional shutdown (the 60s idle-exit
    timer, see `core/index.mjs` below, exits 0 when it fires). Not a crash:
    skip the backoff below and just let the existing reconnect `Timer`'s
    normal socket-connect retry trigger a fresh spawn if another client shows
    up needing the core again — there's nothing to report and nothing to
    recover from.
  - **any other nonzero code** — a genuine crash (from `node`, since `flock`
    only ever contributes 75 or forwards `node`'s own exit code, and `node`
    itself only ever chooses 0, 78, or 69 deliberately). Retried with a fresh
    spawn, but with bounded exponential backoff — capped at a handful of
    attempts with a growing delay — so a persistent crash surfaces as a
    stable failure state instead of consuming CPU in a tight spawn/exit loop.
- `onConnectionStateChanged: if (connected) sendHello()` — the moment the
  `Socket` connects, send a `hello` request; without this, nothing ever
  populates the cached handshake state `ping()` depends on, and every ping
  would report the error case forever even on a genuinely live connection.
  `sendHello()`'s response handler (in `handleLine`, alongside whatever else
  is dispatched) sets a `handshakeOk` property on success — matched by the
  request's `id` *and* the absence of an `event` key, the same rule `bin/uchi
  rpc` uses, so a future `event`/`state.changed` push carrying that same `id`
  as ordinary row data is never mistaken for the `hello` reply. Disconnect
  clears `handshakeOk` back to unset, so a stale `"ok"` never lingers across a
  dropped connection before the next `hello` completes.
- `IpcHandler { target: "uchi"; function ping(): string {...} }` — `IpcHandler`
  functions are synchronous: they must return before the event loop gets a
  chance to deliver a `Socket` reply, so `ping()` cannot itself send `hello`
  and wait for the answer. It returns cached state instead — `"ok"` if
  `Socket.connected` is currently true and `handshakeOk` is set (per above),
  an error string otherwise. `omarchy shell uchi ping` therefore reports the
  QML side's last-known connection state, not a fresh live round trip on
  every call — that live round trip is what `bin/uchi rpc hello ...` is for,
  since a Node CLI script can genuinely await one.

### `core/index.mjs`
Entry point. On start: read settings (see below), connect to Homey via
`core/homey.mjs`, print device count to stdout (this literally satisfies
`docs/design.md`'s phase-1 done-criterion), start the RPC server from
`core/rpc.mjs`, and run an idle-exit timer that is *stopped entirely* while
the connected-client count is above zero — not merely reset on each connect,
which could be misread as counting connected time toward the idle window — and
starts a fresh 60-second countdown both at server startup (zero clients from
the first instant) and at every later transition to zero clients, tracked on
connect/disconnect events, not on individual messages, so a wrapper that holds
the socket open without sending anything for a minute doesn't get its core
killed out from under it, and a core that's started but never gets a single
client (a direct terminal invocation left running, say) still idle-exits
instead of waiting forever for a transition that never happens (cheap now,
expensive to retrofit later — call this out in the code as intentional). If
settings are missing/invalid, print a clear stderr message and exit(78) — the
BSD `sysexits.h` code for a configuration error, and the specific code
`Service.qml` checks to tell "not set up yet" apart from a transient crash
worth retrying — rather than half-starting. If settings are valid but the
initial `core/homey.mjs` connection attempt itself fails (Homey offline,
rebooting, unreachable on the network), print a clear stderr message and
exit(69) (`sysexits.h`'s `EX_UNAVAILABLE`) instead of letting the error
propagate as an uncaught exception — that would surface as Node's generic
crash code and get bucketed with real bugs under `Service.qml`'s
bounded-backoff-then-stop policy, when an unreachable Homey should instead
get the same retry-forever-slowly treatment as missing settings (see
`Service.qml` above).

### `core/rpc.mjs`
The Unix-socket server + JSON-RPC dispatch/framing, factored out of `index.mjs`
specifically so it's unit-testable without a real Homey connection (dispatch
table passed in as a plain `{method: handler}` object).

No single-instance logic lives in this module at all — `flock(1)` (see
`Service.qml` above) already guarantees exactly one `core/index.mjs` process
is ever running before any of this module's code executes, so `listen()`
just unconditionally unlinks any pre-existing socket file (safe: `flock`
already proved nobody else legitimately holds it) and binds. A PID-file-based
guard was deliberately rejected here: Node's plain `fs` primitives
(`open`/`write`/`rename`/`unlink`) have no true atomic compare-and-swap, so
any handwritten stale-lock-reclaim scheme built on them has an inherent gap
between checking staleness and taking ownership. `flock`'s kernel-held lock
has no such gap.

This guarantee only holds if *every* invocation goes through `flock`,
manual ones included — an unwrapped `node core/index.mjs` would run this
same unconditional unlink without ever having proven exclusivity, and could
delete a live, `flock`-protected instance's socket file out from under it.
So there is no sanctioned unwrapped path: Verification step 4 below runs
`core/index.mjs` the same `flock`-wrapped way `Service.qml` does, and that's
the only way this module is ever meant to start.

Per-connection framing: `readline.createInterface({input: socket})`, one
JSON-RPC object per line — the direct Node equivalent of the QML side's
`SplitParser`.

Phase-1 dispatch table:
- `hello` → `{ protocol: 1, homey: { address }, connected: <bool> }`.
- `state.get` → stub `{ hero: null, recent: [], attention: [], here: null,
  habits: [] }` — proves the framing/dispatch machinery end-to-end now; real
  content is phases 2+.

### `core/homey.mjs`
Thin wrapper: `connect({address, token})` → `HomeyAPI.createLocalAPI({address,
token, debug: false})`; `getDeviceCount()` → `Object.keys(await
api.devices.getDevices()).length`. Nothing else yet — no realtime capability
instances until phase 2.

### `core/validate.mjs`
One-shot script, not the server: reads `{address, token}` as JSON from stdin,
calls `core/homey.mjs`'s `connect()`, prints the device count and exits 0 on
success, or prints the error to stderr and exits 1. Its only caller is `uchi
setup`, invoked as a child process — this is what lets setup validate live
without `bin/uchi` importing `homey-api` itself, keeping "only the core talks
to Homey" intact.

### `core/config.mjs`
Reads only — `~/.local/state/omarchy/settings/uchi.json`, schema `{ "address":
"...", "token": "..." }`, both together per the confirmed decision. Writing it
is `uchi setup`'s job alone (see `bin/uchi` below); the core never writes its
own settings file, matching "written by `uchi setup`, read only by the core"
stated in the Config section above — this module doesn't get its own write
path just because it's convenient to colocate.

Before trusting the file's contents: open it with `fs.open(path,
fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)`, not a plain path-based
read — `O_NOFOLLOW` rejects a symlink outright rather than following it,
which a path-based `fs.stat`/`fs.readFile` pair would silently do (a symlink
to some unrelated, legitimately-`0600` file would otherwise pass a
path-based check while actually pointing somewhere else). Then `fs.fstat`
*that open descriptor*, not the path again, and reject (clear error, refuse
to start) anything whose mode has any group/other bits set — checking the
descriptor rather than re-stating the path closes the gap where the path
could be swapped between the check and the read. `uchi setup` always writes
`0600`, but this file can outlive a single `setup` run: a stale copy from
before setup ever ran, or one `chmod`ed more permissive after the fact, would
otherwise still be trusted. Read the JSON from that same descriptor once it
passes. The error message should say to re-run `uchi setup` (which always
writes a fresh `0600` file), not just fail silently.

Then validate the parsed shape before it ever reaches `core/homey.mjs`:
`address` and `token` must both be present and non-empty strings. Skipping
this lets malformed JSON or an empty/missing field reach
`HomeyAPI.createLocalAPI` directly, where it fails as a *connection* error —
misclassified as exit 69 (Homey unreachable, retry forever) when it's
actually exit 78's case (bad configuration, needs `uchi setup` re-run).

### `core/package.json`
`"type": "module"`, `"private": true`, `"engines": {"node": ">=22"}`,
`"dependencies": {"homey-api": "3.20.0"}` (pinned exact, not a range — vendored
deps shouldn't float).

### `core/node_modules/` and `core/package-lock.json` (vendored)
`npm install --omit=dev` inside `core/` once, to generate the lockfile, then
commit both `node_modules/` and `package-lock.json`. Pinning only `homey-api`'s
own version in `package.json` doesn't pin its transitive tree — `homey-api`'s
own dependencies (`engine.io-client`, `form-data`, `jsonwebtoken`, `node-fetch`,
`socket.io-client`) are declared with `^` ranges, so a bare `npm install` rerun
later could resolve different transitive versions than what's committed. Two
different operations, not one: to *reproduce* the exact committed tree (a
clean rebuild, or verifying the checkout matches the lockfile), use `npm ci
--omit=dev` — it installs exactly what `package-lock.json` says and refuses
to resolve anything else. To *update* the vendored tree to newer transitive
versions is a separate, deliberate step (`npm update --omit=dev`, or bumping
a range and reinstalling) that regenerates the lockfile first; only after
reviewing and committing that new lockfile does `npm ci --omit=dev` reproduce
the new pinned state. `npm ci` alone never changes what's pinned.
Requires editing the repo's existing `.gitignore`, which currently has a
blanket `node_modules/` line that would silently exclude this — **remove that
line** (this repo's only legitimate `node_modules` is `core/`'s vendored one,
so there's nothing left for the blanket rule to usefully exclude).

### `core/test/rpc.test.mjs`
`node --test` against `core/rpc.mjs` directly: spin up the dispatch server on a
temp socket path, connect a plain `net.Socket` client, send a `hello` request
with an `id`, assert the response echoes that same `id` alongside `result`. No
real Homey needed.

### `bin/package.json`
`{ "private": true, "type": "module" }` — `bin/uchi` is extensionless (a
shebang script, not `bin/uchi.mjs`), and Node picks CommonJS vs ESM for an
extensionless file from the nearest ancestor `package.json`'s `"type"` field,
defaulting to CommonJS if none is found; `core/package.json`'s `"type":
"module"` doesn't reach outside `core/`, and the repo has no root
`package.json`. Without this file, `bin/uchi`'s `import.meta.url` and any
static `import` would fail immediately under plain CommonJS resolution.

### `bin/uchi`
Node script (`#!/usr/bin/env node`), no dependencies of its own — it never
imports `homey-api` directly, keeping "only the core talks to Homey" intact.
Committed with the executable bit set (`chmod +x bin/uchi` before the first
commit that adds it — a shebang alone doesn't make a file runnable; without
this, `bin/uchi setup` fails with `Permission denied`). Resolves `core/`'s
files relative to its *own* location via `fileURLToPath(import.meta.url)`,
never the caller's cwd and never `process.argv[1]` (that's not guaranteed to
be the script's real directory — it can be relative to the caller's cwd, or
point at a symlink, which would break exactly this resolution when `bin/uchi`
is installed as a symlink or invoked from another directory) — this is a CLI,
invoked from wherever, not always the repo root.
- `uchi setup` — `gum input` (address) / `gum input --password` (token) via
  `child_process`, then spawns `node core/validate.mjs` (resolved from
  `bin/uchi`'s own directory, per above) as a one-shot child process, piping
  `{address, token}` to its stdin as JSON (never as argv, which `ps` can see),
  per the confirmed decision to fail loudly on a typo rather than discovering
  it later. `mkdir`s the settings dir at `0o700` first, then explicitly
  `chmod`s it to `0o700` regardless of whether it was just created or already
  existed — same reason as the file below: a mode argument on `mkdir` is
  silently ignored if the directory is already there, so a pre-existing,
  more-permissive directory would otherwise stay that way. Only once the
  validate child exits 0 does `uchi setup` write the full settings object,
  `{address, token}` (not the token alone — the schema requires both): to a
  freshly created `0o600` temp file in that directory — never straight to the
  final path, which could already be a symlink placed there before setup ran,
  and never write-then-`chmod`, which leaves a window where the file briefly
  sits at the OS's default, more permissive mode — then `fs.rename`s the temp
  file into place, atomically replacing whatever was at the final path in one
  step.
- `uchi rpc <method> [paramsJson]` — a generic raw JSON-RPC debug client against
  the socket (`uchi rpc hello '{"client":"cli","protocol":1}'`), using only Node
  builtins (`net`, `readline`). Sends one request with an `id`, then reads
  lines until one arrives whose `id` matches *and* which has no `event` key —
  matching on `id` alone isn't enough, since the `event` push type carries its
  own `id` as ordinary row data, which could coincidentally equal the request's
  `id`. Anything else — no `id` match, or an `id` match that turns out to carry
  an `event` key — is an unsolicited push (`connection`, and from phase 2 on,
  `state.changed`/`event`) and is skipped, not mistaken for the response.
  Forward-compatible with phase 2's real commands.

### `.gitignore` (edit)
Remove the blanket `node_modules/` line (see `core/node_modules/` above).

## Verification (run these, in order)

1. `omarchy plugin validate .` from the repo root — must pass against the
   phase-1 (`service`-only) manifest.
2. `cd core && node --test` — runs straight against the committed,
   already-vendored tree, no install step at all: `npm ci` would still
   reinstall the exact pinned versions from the registry, but it deletes and
   recreates `core/node_modules/` from scratch to do it, which needs network
   access and can leave the working tree modified — pointless when the
   vendored tree is already sitting there checked out. Proves the RPC framing
   in isolation, no Homey needed. `npm ci --omit=dev` stays the right command
   for *reproducing* the vendored tree from a clean checkout (see
   `core/node_modules/` above) — just not for verifying one that already
   exists.
3. `bin/uchi setup` — enter a real Homey address + token; confirm it fails
   loudly on a wrong value, then succeeds; `stat -c '%a'
   ~/.local/state/omarchy/settings/uchi.json` must print `600`.
4. `: "${XDG_RUNTIME_DIR:?not set}"` first, to fail loudly instead of
   silently targeting a root-level path — then `flock -n -E 75
   "$XDG_RUNTIME_DIR/uchi.lock" node core/index.mjs` run directly in a
   terminal, the same `flock`-wrapped form `Service.qml` uses (see
   `core/rpc.mjs` above for why an unwrapped `node core/index.mjs` isn't a
   supported way to run this at all). Stdout must show something like
   "Connected to Homey — N devices", satisfying the phase-1 done criterion
   literally, independent of Quickshell.
5. Immediately, in another terminal, while step 4's process is still up:
   `bin/uchi rpc hello '{"client":"cli","protocol":1}'` and `bin/uchi rpc
   state.get '{}'` — raw socket round trip, no Quickshell involved. Run this
   right after step 4, not after a pause — the idle-exit timer (see
   `core/index.mjs` above) starts counting down from the moment the core
   starts with zero clients, so a core left alone for a full 60s before this
   step will have already exited.
6. Install locally to prove the QML side for real: symlink the repo into
   `~/.config/omarchy/plugins/uchi`, `omarchy-shell shell rescanPlugins`,
   `omarchy plugin enable uchi` — Service.qml should spawn or connect to the
   core within a few seconds. Then `omarchy shell uchi ping` from a terminal:
   `ping()` reports cached connection state, so `"ok"` confirms the QML side
   believes it's connected (proving spawn-or-connect and the `Socket`
   handshake worked), not a fresh round trip on that call — step 5's `bin/uchi
   rpc hello ...` is what proves a live round trip through the actual socket.

## After this phase

Phase 2's `core/homey.mjs` must use the verified-correct APIs: per-device
`makeCapabilityInstance` for realtime updates, not the CRUD-only top-level
`devices.connect()`, and `zones.getZone({id})` for zone names, since
`device.zoneName` is a dead deprecated getter. `docs/design.md` never named a
specific method for either — it stays at "`homey-api`, realtime capability
events" — so there's nothing to correct there; let `core/homey.mjs`'s own code
and tests be the source of truth for the exact calls.

## Implementation approach

**Not a workflow/ultracode task.** ~10 tightly coupled files sharing a protocol
(`rpc.mjs`'s framing must match `Service.qml`'s `SplitParser`; `config.mjs`'s
schema must match what `bin/uchi setup` writes and `core/index.mjs` reads) —
fanning this out to parallel agents risks drift across a shared contract for too
small a file count to be worth the coordination cost. Build it as one continuous
thread. A `/code-review`-style workflow pass across the finished diff (dimensions:
correctness, security — this code handles a token file — simplification) is a
good fit *after* phase 1 lands, reviewing independent-ish already-written code
rather than authoring foundational coupled code from scratch. Needs an explicit
ask or "ultracode" each time; not a default.

**Start the actual coding in a fresh session.** `CLAUDE.md`, `docs/design.md`,
and this file are already committed at the repository root, so a fresh session
started there is fully grounded without any prior conversation carried over —
it just needs: "implement phase 1 per `docs/phase-1-plan.md`." The
`lean-implementer` persona already installed via preflight is the right one to
drive it.

**Testing loop, confirmed present on this machine:** `wtype` (keystroke
injection), `grim`+`slurp` (screenshots, what `omarchy capture screenshot`
wraps), `hyprctl dispatch`. `ydotool` is absent. Most of phases 1–2 verify
headlessly (`node --test`, `bin/uchi rpc ...`) with no display needed; the
screenshot+wtype loop only matters once there's QML to look at, phase 3 on.

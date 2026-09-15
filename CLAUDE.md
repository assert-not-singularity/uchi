# Uchi — AI agent instructions

A command-line interface to a Homey Pro smart home: a Node core behind a Unix socket,
with an Omarchy 4 shell plugin as its first UI wrapper.

This file is a **thin index**, not a manual. Deep conventions live in focused files that load
only when relevant: personas in `.claude/agents/`, task-triggered skills in `.claude/skills/`,
and file-scoped rules in `.claude/rules/`. Keep this file lean — add a fact only when an agent
needs it and cannot derive it from the code or the docs.

## Always-on standards

@.claude/standards/working-style.md

## Orient yourself

- Full design (architecture, protocol, prompt grammar, panel sections, build phases,
  and *why* each decision was made) → `docs/design.md` — read this before any
  architectural change, not just the code.
- Repo overview / current code layout → `README.md` (not written yet; the repo is
  pre-code — see `docs/design.md`'s "Repo layout (target)" for the intended shape)
- Domain terms (thing/word/value/line, Recent/Attention/Here/Habits, "the core" vs
  "a wrapper") are all defined in `docs/design.md` — do not guess at them.

## Project-specific facts

- **The core/wrapper split is load-bearing, not incidental.** All ranking, grammar
  parsing, and Homey communication live in `core/`. A wrapper (the Omarchy plugin,
  later a TUI) only renders state and forwards desktop context. If you're tempted to
  put logic in `Service.qml`/`Panel.qml` beyond drawing and forwarding, it almost
  certainly belongs in `core/` instead — see `docs/design.md`'s
  "Architecture: core + wrappers" section.
- **The action a row proposes always goes through `prompt.run`.** There is no
  per-row/per-section method for *that* — a Recent/Attention/Habits row's proposed
  action is just a grammar `line` sent the same way typed input is; don't add a
  bypass. `row.dismiss`/`row.snooze`/`row.mute` and `room.pin`/`room.unpin` are a
  deliberate, separate exception: they act on the row or panel itself, not a
  device, so there's no grammar line for them — see `docs/design.md`'s Protocol
  section before assuming these should route through `prompt.run` too.
- **The core is the only thing that talks to Homey**, via `homey-api`'s local API
  (realtime events, not polling). Wrappers never import `homey-api`.
- **Dependencies under `core/` are vendored**, not installed on demand — the Omarchy
  plugin installer never runs install hooks.
- **`.claude/.preflight-base/` intentionally diverges from the live `.claude/` files
  it mirrors.** It's the pristine upstream snapshot `preflight:update`'s 3-way merge
  uses as a base — never edit it to match a local customization, or a future update
  silently drops that customization. If it disagrees with the live copy, the live
  copy is authoritative; the disagreement is the diff `/preflight:update` is meant
  to preserve, not a bug to fix.

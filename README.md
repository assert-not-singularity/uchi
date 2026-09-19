# Uchi

A command-line interface to a Homey Pro smart home: a Node core behind a Unix
socket, with an Omarchy 4 shell plugin as its first UI wrapper.

See [`docs/design.md`](docs/design.md) for the full design — architecture,
protocol, prompt grammar, and panel sections.

## Status

Phases 1–3 of the build order in `docs/design.md` are done: the core owns the
Homey connection, the grammar, and the append-only log; the Omarchy plugin
renders a bar pill and a prompt panel (Recent + Here) wired to real desktop
context. Attention (phase 4) and Habits (phase 5) aren't built yet — `core/`
has no `attention.mjs`, `habits.mjs`, or `model.mjs`.

## How to use it

Click the bar pill to open the panel, or type in the prompt directly. A line
names a thing (device, zone, or mood) and, if it needs one, a verb or value:

- `desk 40` — dims the Desk Lamp to 40%
- `front door unlock` — unlocks the Front Door
- `movie night` — activates the Movie Night mood
- `office` — lists the Office's devices and pins it as Here

`↑`/`↓` moves the cursor over a candidate list when a line is ambiguous;
`Enter` runs the highlighted line. See `docs/design.md`'s "Example prompts"
table for the full grammar (zones, kinds like `light`/`son`/`temp`, step/
scale/notch values, chaining). The same lines work from a terminal via
`bin/uchi <line>` — see below.

## Running it

`uchi setup` (via `gum`) writes the Homey address and API token to
`~/.local/state/omarchy/settings/uchi.json`, mode `0600`. `Service.qml` spawns
the core and connects over `$XDG_RUNTIME_DIR/uchi.sock`; `bin/uchi <line>`,
`bin/uchi status`, and `bin/uchi rpc <method> [paramsJson]` talk to the same
socket from a terminal.

### Local development

Quickshell's plugin loader rejects a `bar-widget` entry point reached through
a symlinked plugin folder ("File name case mismatch" — misleading, but that's
what it means; the `service` kind tolerates a symlink, `bar-widget` doesn't).
`make dev-mount` bind-mounts this repo onto
`~/.config/omarchy/plugins/uchi` so the loader sees a real directory while
edits still land here; `make dev-unmount` reverses it. A bind mount doesn't
survive a reboot — re-run `make dev-mount` after one.

After editing QML, use `omarchy-restart-shell` (a full restart) — `omarchy-shell
shell rescanPlugins` doesn't reliably pick up new files or QML changes.

## Testing

```
cd core && node --test
```

`core/test/fixture.mjs` is a deliberately fictional house matching
`docs/design.md`'s own examples — tests never use real household data.

## License

[MIT](LICENSE), except `core/`, which is [GPLv3 or later](core/LICENSE) as of
commit `4d3e7aa` forward (not retroactive — see that file) — the core owns
the Homey connection, grammar, and ranking logic; wrappers (the Omarchy
plugin, a future TUI) stay MIT so anyone can build one without adopting GPL
themselves.

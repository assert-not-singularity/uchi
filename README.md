# Uchi

A command-line interface to a Homey Pro smart home: a Node core behind a Unix
socket, with an Omarchy 4 shell plugin as its first UI wrapper.

See [`docs/design.md`](docs/design.md) for the full design — architecture,
protocol, prompt grammar, and panel sections — and
[`docs/phase-1-plan.md`](docs/phase-1-plan.md) for the current build phase.

## Status

Early development; not yet installable or usable end to end.

## License

[MIT](LICENSE), except `core/`, which is [GPLv3](core/LICENSE) — the core owns the
Homey connection, grammar, and ranking logic; wrappers (the Omarchy plugin, a
future TUI) stay MIT so anyone can build one without adopting GPL themselves.

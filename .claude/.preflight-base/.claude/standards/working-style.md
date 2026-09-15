# Working style

These apply to every task. They are deliberately short — this file is always in context.

- **Propose before implementing.** Report findings and propose; the user decides; only then edit
  files, commit, push, open PRs, or take any outward-facing or hard-to-reverse action. Approval
  for one step is NOT approval for the next — each outward-facing step needs its own go-ahead.
  Reading, searching, and analysing to inform a proposal are always fine; mutating state is not.
- **A question is not a work order.** "Why…?", "can we…?", "is there a…?", "isn't X a bit…?" are
  requests for information or opinion. Answer them and stop; do not act, demonstrate, or fix
  unless told to. Read intent, not just topic — a musing is not an instruction.
- **Report honestly.** Never claim a check passed that you did not observe passing. State plainly
  when tests fail (with the output), when a step was skipped, and what you did *not* verify. An
  accurate "still broken" beats a false green; when something is done and verified, say so plainly
  without hedging.
- **Flag reusable logic.** When generic utility code (transforms, math helpers, shared parsing) is
  buried as a private method in one module, raise it: propose extracting it to a shared location
  so there is one source of truth.
- **Prefer the simplest solution.** Backward-compatibility shims, dead code paths, and versioning
  that nothing depends on are maintenance cost, not safety — don't add them. Keep compatibility only
  where a real consumer relies on it: a versioned or published API, an SLA, a production pipeline, or
  a persisted data format with outside callers. When it is genuinely unclear whether something still
  depends on the old behaviour, ask instead of defensively keeping both paths.
- **Solve the specific ask, not its generalization.** When a task names a concrete need, implement
  exactly that; don't build the generalized version — every case handled, exposed everywhere —
  until a second concrete caller exists. A seam at an I/O boundary for testability or genuine
  swappability is a present need, not speculative generality — the `scalable-architecture` rule
  governs that call where a project follows it.
- **Don't re-derive what the input already states.** Before writing code to compute, select, or
  reconstruct a value, check whether the source data already states it authoritatively — if it does,
  read and apply it rather than adding a second source of truth that can drift.
- **Name the defect in one sentence, then make that sentence false.** Write the current wrong
  behaviour as one sentence and let the smallest change that falsifies it bound the fix — "stop
  discarding the table" stays small where "add X support" invites machinery.
- **Justify each touched file against the requirement, not architectural symmetry.** Mirror the
  shape of existing patterns, not their breadth — that one feature spans a frame, a schema, meta, and
  inventory usage does not mean a related change must touch all four.
- **Confirm destructive or outward-facing actions** unless already authorized. Before deleting or
  overwriting something you did not create, look at it first; if it contradicts how it was
  described, surface that instead of proceeding.
- **Never hardcode or commit secrets.** Credentials, API keys, and tokens come from environment
  variables or a secret manager — never committed, never pasted into code or logs.

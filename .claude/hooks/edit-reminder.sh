#!/bin/bash
# PreToolUse hook (Edit|Write): injects a short working-style checklist as
# non-blocking context right before an edit, so it's a fresh nudge at the
# moment of writing code instead of static background loaded once at
# conversation start. See .claude/standards/working-style.md for the full
# rules this condenses — always exits 0, never blocks or asks for approval.

CHECKLIST='Working-style check before this edit: (1) does existing code already do part of this — reuse it, don'"'"'t re-implement; (2) solve the specific ask, not a generalized version of it; (3) no dead code, no unneeded compat shims; (4) don'"'"'t re-derive a value the input already states; (5) verify (tests/run) before calling it done.'

jq -n --arg ctx "$CHECKLIST" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'

exit 0

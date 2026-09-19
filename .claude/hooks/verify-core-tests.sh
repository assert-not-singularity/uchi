#!/bin/bash
# Stop hook: a real deterministic gate for "verify before calling it done" —
# a PreToolUse reminder can only nudge; this can actually block. If core/
# has uncommitted .mjs changes, re-run the test suite before letting the
# turn end, and block with the failure output if it's red. Exit 2 + the
# hookSpecificOutput block below is what Claude Code's Stop event reads as
# "block" (docs: exit 0 lets the turn end, exit 2 blocks it).

cd "$CLAUDE_PROJECT_DIR" || exit 0

CHANGED=$(git status --porcelain -- 'core/*.mjs' 2>/dev/null)
if [ -z "$CHANGED" ]; then
  exit 0
fi

cd core || exit 0

# Can't verify without vendored deps installed — a git worktree only carries
# tracked files, and node_modules is gitignored (vendored on disk in the
# main checkout, not committed), so a fresh worktree never has it. Don't
# block on an environment gap that has nothing to do with the actual
# change — that's exactly the infinite-block loop the docs warn about.
if [ ! -d node_modules ]; then
  exit 0
fi

TEST_OUTPUT=$(node --test 2>&1)
TEST_EXIT=$?

if [ "$TEST_EXIT" -ne 0 ]; then
  # Strip ANSI color codes — node --test always colorizes, even piped, and
  # raw escape sequences in the block reason are unreadable noise.
  TAIL=$(printf '%s' "$TEST_OUTPUT" | sed -E 's/\x1b\[[0-9;]*m//g' | tail -c 3000)
  jq -n --arg reason "core/*.mjs changed and \`node --test\` is failing — fix before ending the turn:

$TAIL" '{
    hookSpecificOutput: {
      hookEventName: "Stop",
      permissionDecision: "block",
      permissionDecisionReason: $reason
    }
  }'
  exit 2
fi

exit 0

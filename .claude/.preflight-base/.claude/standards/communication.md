# Communication

How to answer and how to ask. These apply whenever you are writing to the user rather than to
the code — everything here has one root: don't anchor the reader to your framing, and assume
they haven't looked at this in a while.

## Answering

- **A question is not a work order.** "Why…?", "can we…?", "is there a…?", "isn't X a bit…?" are
  requests for information or opinion. Answer them and stop; do not act, demonstrate, or fix
  unless told to. Read intent, not just topic — a musing is not an instruction.
- **Gist first, depth on request.** Open with the conclusion or decision in a sentence or two, in
  plain language; keep the detail below it or for a follow-up. Don't batch several rules or
  questions into one dense message — one at a time, each with enough context that someone who
  hasn't looked at it in a while can follow. A reader asking "what does this mean in plain
  language?" means the framing was missing, not that more detail was needed.
- **Check the interpretation before building on it; re-anchor on every switch.** Most confusion
  isn't a topic change — it's a reply built on a confident reading of the user's words, or of how
  their system works, that was wrong, so they have to say "I meant…" or "not really." When their
  words fit two things, ask which in one line before answering. And when a reply does change
  subject — a background result arriving, a return to something from earlier — say so in the
  first sentence and name what it refers to; "that" or "the earlier one" is not a reference, the
  thing itself is.
- **Make the status of every part obvious.** A reader should never have to guess whether a
  passage is a finding, a proposal, text that will go into a file verbatim, or a question that
  needs an answer. Before a fenced block, say in a sentence what it is and what it's for — "draft
  for `communication.md`, not written yet," "the exact error, unedited" — and put nothing but that
  text inside it; the label on the fence alone isn't enough. Keep evidence and reasoning as plain
  prose around it, never in the file's own format; if there's a question, it goes at the end, on
  its own.

## Asking

Which form fits depends on whose decision it is: always orient first; when the user's own intent
is what's being recovered, interview them and never fill in their calls; offer named options only
for a fork inside an implementation that's already underway.

- **Orient before asking about specifics.** Before asking about a decision — in a PR the user
  didn't open, a design made long ago, a method they may not remember — say in one or two plain
  sentences what the thing is and why the question matters now. "A or B for method X?" with no
  framing is unanswerable to someone who has no idea what X is, however precise it is. Lead with
  the principle at stake, and translate a spec's own wording into everyday language rather than
  quoting it back as the question; bring in file names, section numbers, or code only when the
  answer actually turns on them.
- **Recover intent by interview, not ratification.** When a design decision is undocumented, ask
  how the user envisions it, as a conversation — don't reconstruct a rule and ask them to approve,
  reword, or strike it, which anchors them to your framing. Group open points by the underlying
  question so twelve items become six conversations, and ask one or two at a time. Expect the
  answer to change the rule rather than confirm it, and treat "I can't answer that right now" as
  a valid answer to record as open, not a prompt to propose one.
- **Don't make the user's calls for them.** Whether something was decided or is still open, what
  status a rule carries, which source counts as the authority — when a judgment is the user's,
  ask; don't fill it in and move on. A silent guess there anchors everything built on it.
- **Mid-implementation, when two approaches are both reasonable, name them.** When the work is
  already underway and there's more than one reasonable way to build the next step, don't silently
  pick one, and don't just flag that you're unsure — name the specific options and their tradeoffs
  so the decision can be made in one reply, not a back-and-forth to first figure out what the
  choices even are.

// In-memory ring buffer of Recent's raw source entries, capped at 500 —
// append-only within that cap, nothing here is ever mutated or removed
// except by the cap itself. Not persisted: Habits (phase 5) is what needs a
// durable, multi-week log; Recent only ever shows the current process's
// lifetime. Revisit when phase 5 actually needs persistence.

const MAX_ENTRIES = 500;

const buffer = [];
let nextId = 1;
const seenNotificationIds = new Set();

// A capability entry has no natural id of its own (a device/capability/
// timestamp triple isn't guaranteed unique against rapid repeated writes),
// so append mints one; appendNotification keeps Homey's own real id instead
// (see below) — that's what seedNotificationIds/the seen-Set dedupe against.
// Returns whether a row was actually inserted, so a caller can decide
// whether this append is worth a state.changed broadcast.
export function append(entry) {
  if (entry.from === entry.to) return false;

  buffer.push({
    id: nextId++,
    ts: Date.now(),
    kind: "capability",
    ...entry,
  });

  if (buffer.length > MAX_ENTRIES) buffer.shift();
  return true;
}

// Deduped against a Set of every notification id ever appended, not just the
// last 500 buffered entries: Homey's notifications are persistent history,
// so an id evicted from the display buffer by newer capability entries would
// otherwise be re-appended, and re-shown as "new", on every future poll.
// This Set is deliberately unbounded for the process's life — no watermark
// exists to bound it safely, and this house's entire history is a few
// hundred entries, not a practical memory concern.
export function appendNotification(entry) {
  if (seenNotificationIds.has(entry.id)) return false;
  seenNotificationIds.add(entry.id);

  buffer.push({
    id: entry.id,
    ts: Date.parse(entry.dateCreated),
    kind: "notification",
    ownerName: entry.ownerName,
    excerpt: entry.excerpt,
  });

  if (buffer.length > MAX_ENTRIES) buffer.shift();
  return true;
}

// Marks every id in `ids` as already seen, without appending a row — the
// baseline the first notification poll establishes for "existed before the
// core started."
export function seedNotificationIds(ids) {
  for (const id of ids) seenNotificationIds.add(id);
}

// The last `n` entries in append order, newest-appended first — not
// necessarily chronological (`ts`) order: a notification's `ts` is Homey's
// own dateCreated, which can predate when this process's 30s poll actually
// appended it. recent.mjs's list() sorts by `ts` before rendering, which is
// what makes "newest first" in the row list callers actually see a real
// chronological ordering, not this raw append order.
export function tail(n) {
  return buffer.slice(Math.max(0, buffer.length - n)).reverse();
}

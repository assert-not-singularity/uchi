import { toDisplayPercent } from "./homey.mjs";
import { lineFor } from "./grammar.mjs";

// The five capabilities grammar.mjs's own verbs/bare-number step can
// execute — exactly the set a real undo `line` can target. Every other
// DISCRETE_CAPABILITIES member still needs a `why`, just no `line`.
const LINEABLE_CAPABILITIES = new Set(["onoff", "locked", "dim", "target_temperature", "volume_set"]);

// A plain rendering of the transition itself (from → to), not a capability's
// current-value description — distinct from grammar.mjs's formatCapabilityWhy,
// which formats one value, not a change.
function formatTransitionWhy(capabilityId, from, to) {
  switch (capabilityId) {
    case "onoff":
      return `→ ${to ? "on" : "off"}`;
    case "locked":
      return to ? "locked" : "unlocked";
    case "dim":
      return `dimmed to ${toDisplayPercent(capabilityId, to)}%`;
    case "volume_set":
      return `volume ${toDisplayPercent(capabilityId, to)}%`;
    case "target_temperature":
      return `target ${to}°`;
    case "speaker_playing":
      return to ? "playing" : "stopped";
    case "alarm_contact":
      return "open";
    case "alarm_motion":
      return "motion";
    case "windowcoverings_state":
      return String(to);
    default:
      return String(to);
  }
}

function capabilityRow(entry) {
  let why = formatTransitionWhy(entry.capabilityId, entry.from, entry.to);
  if (entry.cause === "prompt") why += " (you)";

  const row = {
    id: entry.id,
    kind: "capability",
    label: entry.deviceName,
    why,
    in: entry.cause === "prompt",
  };

  if (LINEABLE_CAPABILITIES.has(entry.capabilityId) && entry.from !== null && entry.from !== undefined) {
    row.line = lineFor(entry.deviceName, entry.capabilityId, entry.from);
  }

  return row;
}

function notificationRow(entry) {
  return { id: entry.id, kind: "notification", label: entry.ownerName, why: entry.excerpt, in: false };
}

// Derives Recent rows from log.mjs's buffer — takes both the entries and the
// row limit as plain arguments, never reading config itself, so this stays
// testable against a fixture with no dependency on the machine's real
// ~/.config/uchi/config.json.
export function list(entries, recentRows) {
  const sorted = [...entries].sort((a, b) => b.ts - a.ts);
  const top = sorted.slice(0, recentRows);
  return top.map((entry) => (entry.kind === "notification" ? notificationRow(entry) : capabilityRow(entry)));
}

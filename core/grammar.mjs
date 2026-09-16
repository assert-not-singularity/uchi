import {
  toHomeyValue,
  toDisplayPercent,
  toLinePercent,
  PERCENT_CAPABILITIES,
  NUMERIC_TARGETS,
} from "./homey.mjs";

const VERB_WORDS = new Set(["on", "off", "lock", "unlock"]);

function things(devices, zones) {
  const result = [];
  for (const d of Object.values(devices)) result.push({ kind: "device", id: d.id, name: d.name, zone: d.zone, ref: d });
  for (const z of Object.values(zones)) result.push({ kind: "zone", id: z.id, name: z.name, ref: z });
  return result;
}

function qualifyLabel(thing, zones) {
  if (thing.kind !== "device") return thing.name;
  const zone = zones[thing.zone];
  return zone ? `${thing.name} (${zone.name})` : thing.name;
}

// Stage one, unified: a full-name match is just the degenerate case of a
// prefix match (a prefix that happens to consume the whole name), so exact,
// token-prefix, and substring matching aren't three independent passes —
// they're priority levels checked together at each candidate length, tried
// longest-first. Running exact fully across every length before fuzzy ever
// gets a turn would let a short, low-priority exact match win over a
// longer, more-specific prefix match the user actually typed toward — e.g.
// a zone named "Attic" must not swallow a query for "Attic Switch"
// (typed in full) merely because "Attic" alone happens to satisfy exact
// matching at a shorter length. Checking all three levels at the *same*
// length, longest length first, is what keeps both properties true at once:
// a full-name match still wins over a same-length partial match (the
// "Attic" vs "Attic Switch" case, both level A at k=1), and a longer,
// more of the input consumed still wins over a shorter one regardless of
// which level matched it.
function matchThing(tokens, all) {
  for (let k = tokens.length; k >= 1; k--) {
    const candidate = tokens.slice(0, k).join(" ").toLowerCase();

    // Level A — exact: candidate equals the thing's whole name. A tie here
    // (two things sharing the identical name) is ambiguous at this level,
    // not diluted by weaker matches at the same length.
    const exact = all.filter((t) => t.name.toLowerCase() === candidate);
    if (exact.length > 0) return { matches: exact, consumed: k };

    // Level B — token-aligned prefix: the candidate must equal
    // (case-insensitively) the name's own leading tokens joined back
    // together, not a raw substring/prefix scan of the whole name string.
    // This is what keeps "desk" matching only "Desk Lamp" and not
    // "Desktop Machine" — "desk" is a raw-string prefix of "Desktop", but
    // not equal to it as a whole token.
    const prefix = all.filter((t) => {
      const nameTokens = t.name.trim().split(/\s+/);
      if (nameTokens.length < k) return false;
      return nameTokens.slice(0, k).join(" ").toLowerCase() === candidate;
    });
    if (prefix.length > 0) return { matches: prefix, consumed: k };

    // Level C — substring: the candidate appears anywhere inside one of
    // the name's tokens. The fallback for a single-token (often compound)
    // name with no word boundary to align a prefix against at all — e.g.
    // a German compound light name — where token-aligned matching alone
    // would otherwise demand typing the entire word. No scoring: a unique
    // substring hit resolves, more than one is still an ambiguous
    // candidate list, exactly like the other two levels — this never
    // auto-picks a "best guess" for something that writes to a real
    // device.
    const substring = all.filter((t) =>
      t.name
        .trim()
        .split(/\s+/)
        .some((nameToken) => nameToken.toLowerCase().includes(candidate))
    );
    if (substring.length > 0) return { matches: substring, consumed: k };
  }

  return { matches: [], consumed: 0 };
}

function ambiguous(matches, zones) {
  return { matches: matches.map((t) => ({ label: qualifyLabel(t, zones), why: "ambiguous — pick one" })) };
}

function deadEnd(label, why) {
  return { matches: [{ label, why }] };
}

// The one shared function for a capability's current-value description —
// used by here.mjs (a device's current state) and rpc.mjs's prompt.resolve
// (a resolved write's target value). Covers only the five capabilities
// resolve()'s bare-number/verb steps can ever produce an action for.
export function formatCapabilityWhy(capabilityId, value) {
  switch (capabilityId) {
    case "onoff":
      return value ? "on" : "off";
    case "locked":
      return value ? "locked" : "unlocked";
    case "dim":
    case "volume_set":
      return `${toDisplayPercent(capabilityId, value)}%`;
    case "target_temperature":
      return `${value}°`;
    default:
      return String(value);
  }
}

// The shared from-value → line renderer here.mjs and recent.mjs both reuse
// for a re-apply of one of the five writable capabilities. Returns null for
// anything else — a capability grammar.mjs has no verb or value form for.
export function lineFor(deviceName, capabilityId, value) {
  switch (capabilityId) {
    case "onoff":
      return `${deviceName} ${value ? "on" : "off"}`;
    case "locked":
      return `${deviceName} ${value ? "lock" : "unlock"}`;
    case "dim":
    case "volume_set":
      return `${deviceName} ${toLinePercent(capabilityId, value)}`;
    case "target_temperature":
      return `${deviceName} ${value}`;
    default:
      return null;
  }
}

// prompt.resolve's implementation: always { matches: [...] } plus optionally
// exactly one of room or action — see docs/phase-2-plan.md's grammar.mjs
// section for why this one shape is load-bearing for run() below.
export function resolve(text, { devices, zones }) {
  const trimmed = text.trim();
  if (trimmed === "") return { matches: [] };

  const tokens = trimmed.split(/\s+/);
  const all = things(devices, zones);

  const matched = matchThing(tokens, all);
  if (matched.matches.length === 0) return { matches: [] };
  if (matched.matches.length > 1) return ambiguous(matched.matches, zones);

  const thing = matched.matches[0];
  const rest = tokens.slice(matched.consumed).join(" ").trim();

  if (thing.kind === "zone") {
    if (rest === "") return { matches: [], room: { id: thing.id, name: thing.name } };
    // Words/kinds beyond a bare zone query are the full word grammar,
    // deferred past this phase — a zone with anything after it is a dead end.
    return deadEnd(thing.name, "needs a word");
  }

  const device = thing.ref;
  const capsObj = device.capabilitiesObj ?? {};

  if (VERB_WORDS.has(rest.toLowerCase())) {
    const word = rest.toLowerCase();
    if ((word === "on" || word === "off") && capsObj.onoff?.setable) {
      return { matches: [], action: { deviceId: device.id, capabilityId: "onoff", value: word === "on" } };
    }
    if ((word === "lock" || word === "unlock") && capsObj.locked?.setable) {
      return { matches: [], action: { deviceId: device.id, capabilityId: "locked", value: word === "lock" } };
    }
    // Recognized word, unsupported by this device — falls through to the
    // bare-number step below, which rejects it as non-numeric.
  }

  if (rest === "") return deadEnd(thing.name, "needs a verb or number");

  const numeric = Number(rest);
  if (!Number.isFinite(numeric)) return deadEnd(thing.name, "needs a number");

  const setableNumeric = NUMERIC_TARGETS.filter((id) => capsObj[id]?.setable);
  if (setableNumeric.length !== 1) return deadEnd(thing.name, "needs a word");

  const capabilityId = setableNumeric[0];
  const value = PERCENT_CAPABILITIES.has(capabilityId) ? toHomeyValue(capabilityId, numeric) : numeric;
  const { min, max } = capsObj[capabilityId];

  if (value < min || value > max) {
    const displayMin = PERCENT_CAPABILITIES.has(capabilityId) ? toDisplayPercent(capabilityId, min) : min;
    const displayMax = PERCENT_CAPABILITIES.has(capabilityId) ? toDisplayPercent(capabilityId, max) : max;
    return deadEnd(thing.name, `needs ${displayMin}–${displayMax}`);
  }

  return { matches: [], action: { deviceId: device.id, capabilityId, value } };
}

// prompt.run's implementation: re-resolves `line` and, if it names an
// action, performs it through the caller-supplied setCapabilityValue (the
// serialized write function core/index.mjs owns) rather than
// homey.mjs's thin wrapper directly.
export async function run(line, { devices, zones, setCapabilityValue }) {
  const result = resolve(line, { devices, zones });

  if (result.action) {
    const device = devices[result.action.deviceId];
    try {
      const change = await setCapabilityValue(device, result.action.capabilityId, result.action.value);
      return { ok: true, change };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  if (result.room) return { ok: false, room: result.room };
  return { ok: false, matches: result.matches };
}

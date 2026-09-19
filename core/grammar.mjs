import {
  toHomeyValue,
  toDisplayPercent,
  toLinePercent,
  PERCENT_CAPABILITIES,
  NUMERIC_TARGETS,
} from "./homey.mjs";

const VERB_WORDS = new Set(["on", "off", "lock", "unlock"]);

// design.md's own per-kind names for the core config's `notches` map —
// distinct from Homey's capability ids, since a person configures step
// sizes by kind ("light", "vol", "temp"), not by raw capability name.
const CAPABILITY_KIND = { dim: "light", volume_set: "vol", target_temperature: "temp" };

// The inverse of CAPABILITY_KIND: design.md's capability word (light/vol/
// temp), typed after a zone, to which Homey capability it disambiguates —
// derived rather than hardcoded a second time, so the two mappings can
// never drift apart.
const WORD_CAPABILITY = Object.fromEntries(Object.entries(CAPABILITY_KIND).map(([capabilityId, word]) => [word, capabilityId]));

// design.md's value grammar: absolute (40), step (+10/-10, relative to the
// capability's current display value), scale (*2//2, levels only), notch
// (++/--, one fixed per-kind step from core config). Sign disambiguation is
// design.md's own rule, not a guess: a sign before digits is always a step,
// never an explicitly-signed absolute value — there is no grammar form for
// a negative absolute value at all.
function parseValue(rest) {
  if (/^[+-]\d+(\.\d+)?$/.test(rest)) return { kind: "step", amount: Number(rest) };
  if (/^[*/]\d+(\.\d+)?$/.test(rest)) {
    const factor = Number(rest.slice(1));
    // "/0" divides to Infinity, which the clamp below would silently turn
    // into a write at the capability's maximum — reject it as an invalid
    // value instead of quietly changing the device to 100%.
    if (rest[0] === "/" && factor === 0) return null;
    return { kind: "scale", op: rest[0], factor };
  }
  if (rest === "++") return { kind: "notch", direction: 1 };
  if (rest === "--") return { kind: "notch", direction: -1 };
  const amount = Number(rest);
  return Number.isFinite(amount) ? { kind: "absolute", amount } : null;
}

// .trim() on both names: a real house has devices whose stored Homey name
// carries a leading/trailing space (confirmed live — two of three otherwise
// identically named "Deckenleuchte"s had one, the third didn't), which
// broke exact-match ties between devices meant to be indistinguishable by
// name alone — one would exact-match and "resolve" alone while its
// identically-named siblings only matched as weaker substring hits.
function things(devices, zones) {
  const result = [];
  for (const d of Object.values(devices)) result.push({ kind: "device", id: d.id, name: d.name.trim(), zone: d.zone, ref: d });
  for (const z of Object.values(zones)) result.push({ kind: "zone", id: z.id, name: z.name.trim(), ref: z });
  return result;
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

// A single common letter can substring-match most of a real house (level C
// falls back to this at k=1) — capped so a wrapper's candidate list stays
// something a person can actually scan, not a rendering hazard.
const MAX_AMBIGUOUS_MATCHES = 20;

// `zone` is a separate field, not baked into `label` — a client renders it
// as its own dimmed suffix the same way it does for a Recent row's zone,
// rather than every row kind inventing its own "name (zone)" text.
//
// `rest` (whatever of the input wasn't consumed reaching this ambiguous
// set — a trailing word/value the tie swallowed, since none of these
// things resolved far enough to apply it) is echoed back so a client can
// pick one candidate and re-resolve "<label> <zone> <rest>" — the zone
// qualifier is the only thing that can turn one of these into a fully
// resolvable line, so the client reconstructs and re-runs one rather than
// this function guessing which candidate was meant.
// The one shape a "candidate the prompt can act on" row takes, wherever it's
// built — an ambiguous pick, a dead end still needing more input, or a fully
// resolved action still awaiting Enter. `kind` ("device" | "zone") lets a
// client tell a device candidate from a zone candidate apart, since both can
// share the exact same name; `deviceClass` is Homey's own device.class, the
// only reliable way to pick an icon (capabilityId alone can't tell a light
// from a socket, both commonly controlled via plain onoff).
function candidateRow(label, why, { kind, zone, deviceClass, line } = {}) {
  const row = { label, why };
  if (kind) row.kind = kind;
  if (zone) row.zone = zone;
  if (deviceClass) row.deviceClass = deviceClass;
  if (line) row.line = line;
  return row;
}

function ambiguous(matches, zones, rest) {
  const result = {
    matches: matches.slice(0, MAX_AMBIGUOUS_MATCHES).map((t) => candidateRow(t.name, "ambiguous — pick one", {
      kind: t.kind,
      zone: t.kind === "device" ? zones[t.zone]?.name : undefined,
      deviceClass: t.kind === "device" ? t.ref.class : undefined,
    })),
  };
  if (rest) result.rest = rest;
  return result;
}

function deadEnd(label, why, zone, deviceClass) {
  return { matches: [candidateRow(label, why, { zone, deviceClass })] };
}

// prompt.resolve's preview of an already-resolved action, before Enter runs
// it — index.mjs's RPC handler is the only caller, since this is a rendering
// concern of that one response, not something resolve()'s own return shape
// (still needed raw by run()) should carry.
export function previewRowForAction(action, devices, zones, line) {
  const device = devices[action.deviceId];
  const why = formatCapabilityWhy(action.capabilityId, action.value);
  return candidateRow(device?.name, why, { zone: zones[device?.zone]?.name, deviceClass: device?.class, line });
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

// A device thing, once resolved to exactly one, plus whatever's left of the
// input — the word/value half of the grammar. Split out from resolve() so
// both an ordinary single match and a zone-narrowed one (see narrowByZone
// below) reach it the same way. Every dead end carries the device's own
// zone (not just the ambiguous list that came before it) — the zone that
// distinguished this device a moment ago shouldn't vanish the instant it
// resolves to one.
// Applies a parsed value form to one device's already-known capability —
// shared by a single device's own unique numeric target (resolveDevice) and
// a zone+word batch (resolveZoneWord), where the capability comes from the
// word instead and is applied to several devices, each stepping/scaling
// from its own current value. Returns { value } on success, { why } (a
// grammar.mjs dead-end reason, not thrown) when this device can't take it.
function applyValue(device, capabilityId, parsed, notches) {
  const capsObj = device.capabilitiesObj ?? {};
  const isPercent = PERCENT_CAPABILITIES.has(capabilityId);

  // Scale is levels-only (dim, volume) per design.md — a thermostat has no
  // "half of 21 degrees" reading to scale.
  if (parsed.kind === "scale" && !isPercent) return { why: "needs a word" };

  const { min, max } = capsObj[capabilityId];
  const displayMin = isPercent ? toDisplayPercent(capabilityId, min) : min;
  const displayMax = isPercent ? toDisplayPercent(capabilityId, max) : max;
  const currentDisplay = isPercent ? toDisplayPercent(capabilityId, capsObj[capabilityId].value) : capsObj[capabilityId].value;

  let displayValue;
  let clamps = false;
  if (parsed.kind === "absolute") {
    displayValue = parsed.amount;
  } else if (parsed.kind === "step") {
    displayValue = currentDisplay + parsed.amount;
  } else if (parsed.kind === "scale") {
    displayValue = parsed.op === "*" ? currentDisplay * parsed.factor : currentDisplay / parsed.factor;
    clamps = true; // "clamps at 0/100" per design.md
  } else {
    // notch: one fixed step per kind, from core config — clamps rather
    // than dead-ending, since a low-friction quick-adjust dial shouldn't
    // suddenly error out at the boundary.
    const step = notches?.[CAPABILITY_KIND[capabilityId]] ?? 1;
    displayValue = currentDisplay + parsed.direction * step;
    clamps = true;
  }

  if (clamps) {
    displayValue = Math.max(displayMin, Math.min(displayMax, displayValue));
  } else if (displayValue < displayMin || displayValue > displayMax) {
    return { why: `needs ${displayMin}–${displayMax}` };
  }

  return { value: isPercent ? toHomeyValue(capabilityId, displayValue) : displayValue };
}

function resolveDevice(device, rest, zones, notches) {
  const capsObj = device.capabilitiesObj ?? {};
  const zoneName = zones[device.zone]?.name;

  if (VERB_WORDS.has(rest.toLowerCase())) {
    const word = rest.toLowerCase();
    if ((word === "on" || word === "off") && capsObj.onoff?.setable) {
      return { matches: [], action: { deviceId: device.id, capabilityId: "onoff", value: word === "on" } };
    }
    if ((word === "lock" || word === "unlock") && capsObj.locked?.setable) {
      return { matches: [], action: { deviceId: device.id, capabilityId: "locked", value: word === "lock" } };
    }
    // Recognized word, unsupported by this device — falls through to the
    // value step below, which rejects it as not a recognized value form.
  }

  if (rest === "") return deadEnd(device.name, "needs a verb or number", zoneName, device.class);

  const parsed = parseValue(rest);
  if (!parsed) return deadEnd(device.name, "needs a number", zoneName, device.class);

  const setableNumeric = NUMERIC_TARGETS.filter((id) => capsObj[id]?.setable);
  if (setableNumeric.length !== 1) return deadEnd(device.name, "needs a word", zoneName, device.class);

  const capabilityId = setableNumeric[0];
  const applied = applyValue(device, capabilityId, parsed, notches);
  if (applied.why) return deadEnd(device.name, applied.why, zoneName, device.class);

  return { matches: [], action: { deviceId: device.id, capabilityId, value: applied.value } };
}

// design.md's word list is 12 entries (3 capability words + 9 verbs), each
// needing only its shortest unambiguous 2+ character prefix — but the 3
// capability words alone (light/temp/vol) never collide at 2 characters
// (li/te/vo), so prefix-matching only against these three, without the
// verbs sharing word position, is unambiguous on its own. Extend this once
// the verb words (grp/ungrp/etc.) also need word position.
function matchWord(token) {
  if (!token || token.length < 2) return null;
  const lower = token.toLowerCase();
  return Object.keys(WORD_CAPABILITY).find((word) => word.startsWith(lower)) ?? null;
}

// A zone with more than one controllable capability type needs a word to
// say which one a trailing verb/value applies to (design.md's
// `kitchen+office light 20` example, minus the "+office" join, deferred).
// Every device in the zone with that capability gets it applied at once —
// each stepping/scaling from its own current value, since "the kitchen's
// lights" isn't one shared number. A device that can't take the given value
// (out of its own range, on the absolute/step forms that dead-end rather
// than clamp) is skipped rather than failing the whole batch — one device's
// narrower range shouldn't block every other device the word matched.
function resolveZoneWord(zoneThing, restTokens, devices, notches) {
  const word = matchWord(restTokens[0]);
  if (!word) return deadEnd(zoneThing.name, "needs a word");

  const capabilityId = WORD_CAPABILITY[word];
  const members = Object.values(devices).filter(
    (d) => d.zone === zoneThing.id && d.capabilitiesObj?.[capabilityId]?.setable
  );
  if (members.length === 0) return deadEnd(zoneThing.name, `no ${word} here`);

  const valueText = restTokens.slice(1).join(" ").trim();
  if (valueText === "") return deadEnd(zoneThing.name, "needs a verb or number");

  const lowerValue = valueText.toLowerCase();
  if (lowerValue === "on" || lowerValue === "off") {
    const actions = members
      .filter((d) => d.capabilitiesObj?.onoff?.setable)
      .map((d) => ({ deviceId: d.id, capabilityId: "onoff", value: lowerValue === "on" }));
    if (actions.length === 0) return deadEnd(zoneThing.name, `no ${word} here`);
    return { matches: [], actions };
  }

  const parsed = parseValue(valueText);
  if (!parsed) return deadEnd(zoneThing.name, "needs a number");

  const actions = [];
  for (const device of members) {
    const applied = applyValue(device, capabilityId, parsed, notches);
    if (applied.value !== undefined) actions.push({ deviceId: device.id, capabilityId, value: applied.value });
  }
  if (actions.length === 0) return deadEnd(zoneThing.name, "needs a different value");
  return { matches: [], actions };
}

// A trailing zone name is the only way to reach one specific device when
// several share the exact same literal Homey name — a real, common naming
// pattern (this house's own fixture has two "Reading Lamp"s), not a
// hypothetical. Word/value semantics never apply to a still-ambiguous set
// (every existing grammar form requires a single resolved thing first), so
// there's no competing interpretation for the leftover tokens to be
// disambiguated against here — trying them as a zone is the only thing that
// can possibly resolve further.
//
// Matched against the candidates' own zones first, not every zone in the
// house — confirmed live against a real house: "decken fl" must narrow to
// Flur among {Küche, Badezimmer, Flur, Schlafzimmer} even though "fl" is
// also a substring of "Pflanzen", a zone none of these candidates are even
// in and so isn't a real competing interpretation. Only if that first pass
// doesn't narrow to one does it check the whole house's zones for a clean
// "no match there" when the trailing text names a real zone that just
// isn't one of the candidates'.
//
// A leading recognized word (on/off/lock/unlock) skips zone-narrowing
// entirely, checked before either zone pass — confirmed live that "decke
// on" (a plain verb, not a zone guess at all) fuzzy-substring-matches
// "Nutzerkonten" ("Nutzer**kon**ten"), hijacking the whole ambiguous list
// into one bogus "no match in Nutzerkonten" row. Once the leftover text is
// a known word, it's never a zone guess, so there's no reason to try
// matching it as one at all — simpler and more direct than narrowing what
// counts as a zone match to dodge the collision.
function narrowByZone(candidates, restTokens, zones, notches) {
  if (restTokens.length === 0) return null;
  if (VERB_WORDS.has(restTokens[0].toLowerCase())) return null;

  const toZoneThings = (list) => list.map((z) => ({ kind: "zone", id: z.id, name: z.name }));

  const relevantZoneIds = new Set(candidates.map((t) => t.zone));
  const relevantZones = [...relevantZoneIds].map((id) => zones[id]).filter(Boolean);
  const relevantMatch = matchThing(restTokens, toZoneThings(relevantZones));

  if (relevantMatch.matches.length === 1) {
    const zone = relevantMatch.matches[0];
    const narrowed = candidates.filter((t) => t.zone === zone.id);
    const afterZone = restTokens.slice(relevantMatch.consumed).join(" ").trim();
    if (narrowed.length > 1) return ambiguous(narrowed, zones, afterZone);
    return resolveDevice(narrowed[0].ref, afterZone, zones, notches);
  }

  const anyMatch = matchThing(restTokens, toZoneThings(Object.values(zones)));
  if (anyMatch.matches.length === 1) return deadEnd(anyMatch.matches[0].name, "no match there");

  return null;
}

// prompt.resolve's implementation: always { matches: [...] } plus optionally
// exactly one of room or action. run() below reuses this same shape.
export function resolve(text, { devices, zones, notches }) {
  const trimmed = text.trim();
  if (trimmed === "") return { matches: [] };

  const tokens = trimmed.split(/\s+/);
  const all = things(devices, zones);

  const matched = matchThing(tokens, all);
  if (matched.matches.length === 0) return { matches: [] };

  const rest = tokens.slice(matched.consumed);

  if (matched.matches.length > 1) {
    // Zone-narrowing only makes sense among devices — a tie that includes a
    // zone (e.g. "Attic" the zone vs. "Attic" the device) has no zone of
    // its own to narrow by, and stays exactly as ambiguous as today.
    if (matched.matches.every((t) => t.kind === "device")) {
      const narrowed = narrowByZone(matched.matches, rest, zones, notches);
      if (narrowed) return narrowed;
    }
    return ambiguous(matched.matches, zones, rest.join(" ").trim());
  }

  const thing = matched.matches[0];
  const restText = rest.join(" ").trim();

  if (thing.kind === "zone") {
    if (restText === "") return { matches: [], room: { id: thing.id, name: thing.name } };
    // A bare `kind` thing with no zone at all (design.md's "light off" =
    // every light in the house) and +/- zone joining/exclusion are deferred
    // past this phase — resolveZoneWord only covers one zone at a time.
    return resolveZoneWord(thing, rest, devices, notches);
  }

  return resolveDevice(thing.ref, restText, zones, notches);
}

// prompt.run's implementation: re-resolves `line` and, if it names an
// action, performs it through the caller-supplied setCapabilityValue (the
// serialized write function core/index.mjs owns) rather than
// homey.mjs's thin wrapper directly.
export async function run(line, { devices, zones, setCapabilityValue, notches }) {
  const result = resolve(line, { devices, zones, notches });

  if (result.action) {
    const device = devices[result.action.deviceId];
    try {
      const change = await setCapabilityValue(device, result.action.capabilityId, result.action.value);
      return { ok: true, change };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  if (result.actions) {
    // Each device writes independently — one device rejecting (offline,
    // Homey error) shouldn't undo or block the others a zone+word batch
    // already resolved to a value for.
    const settled = await Promise.allSettled(
      result.actions.map((a) => setCapabilityValue(devices[a.deviceId], a.capabilityId, a.value))
    );
    const changes = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
    if (changes.length > 0) return { ok: true, changes };
    const firstError = settled.find((s) => s.status === "rejected")?.reason;
    return { ok: false, error: firstError?.message ? firstError.message : String(firstError) };
  }

  if (result.room) return { ok: false, room: result.room };
  return { ok: false, matches: result.matches };
}

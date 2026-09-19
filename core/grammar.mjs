import {
  toHomeyValue,
  toDisplayPercent,
  toLinePercent,
  PERCENT_CAPABILITIES,
  NUMERIC_TARGETS,
} from "./homey.mjs";

const VERB_WORDS = new Set(["on", "off", "lock", "unlock"]);

// play/pause aren't in VERB_WORDS itself — that set is shared with
// narrowByZone (skip a zone-narrowing guess on any recognized verb) and
// resolveCapabilityAction's zone-level bare-verb handling, neither of
// which knows speaker_playing exists; broadening VERB_WORDS would make the
// zone-level path mishandle "play"/"pause" as onoff. "next" (skip track)
// isn't included either — no fixture/spec confirms which capability or
// flow action it should trigger, so it stays unimplemented rather than
// guessed at.
const SPEAKER_VERB_WORDS = new Set(["play", "pause"]);

// design.md's own per-kind names for the core config's `notches` map —
// distinct from Homey's capability ids, since a person configures step
// sizes by kind ("light", "vol", "temp"), not by raw capability name.
const CAPABILITY_KIND = { dim: "light", volume_set: "vol", target_temperature: "temp" };

// The inverse of CAPABILITY_KIND: design.md's capability word (light/vol/
// temp), typed after a zone, to which Homey capability it disambiguates —
// derived rather than hardcoded a second time, so the two mappings can
// never drift apart.
const WORD_CAPABILITY = Object.fromEntries(Object.entries(CAPABILITY_KIND).map(([capabilityId, word]) => [word, capabilityId]));

// A word's own icon hint, for a scope-summary row (previewRowForBatch/
// pendingScope) — Panel.qml's classIcon expects a Homey device class
// ("light"/"speaker"/"thermostat"), not a capability id or a design.md
// word, so this is its own small map rather than reusing WORD_CAPABILITY:
// the word "light" always means light-class devices even when the actual
// capability written ends up being onoff (bare "off"), not dim.
const WORD_ICON_CLASS = { light: "light", vol: "speaker", temp: "thermostat" };

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

// design.md's kind (son=every Sonos, light=every light, temp=every
// thermostat) — the thing-position form of a capability, distinct from the
// word-position form (WORD_CAPABILITY) sharing two of its three names.
// "vol" has no kind counterpart (design.md never says "every
// volume-having device"); "son" has no fixture-testable one yet either —
// nothing marks a device as Sonos-branded rather than just any speaker, so
// it's left out until there's a real way to identify one, rather than
// matching every speaker under a name that promises only Sonos ones.
const THING_KINDS = { light: "dim", temp: "target_temperature" };

// .trim() on both names: a real house has devices whose stored Homey name
// carries a leading/trailing space (confirmed live — two of three otherwise
// identically named "Deckenleuchte"s had one, the third didn't), which
// broke exact-match ties between devices meant to be indistinguishable by
// name alone — one would exact-match and "resolve" alone while its
// identically-named siblings only matched as weaker substring hits.
function things(devices, zones, moods) {
  const result = [];
  for (const d of Object.values(devices)) result.push({ kind: "device", id: d.id, name: d.name.trim(), zone: d.zone, ref: d });
  for (const z of Object.values(zones)) result.push({ kind: "zone", id: z.id, name: z.name.trim(), ref: z });
  for (const m of Object.values(moods ?? {})) result.push({ kind: "mood", id: m.id, name: m.name.trim(), ref: m });
  for (const [word, capabilityId] of Object.entries(THING_KINDS)) {
    result.push({ kind: "thingKind", id: word, name: word, capabilityId });
  }
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
// One candidate length's worth of matching, all three tiers — split out of
// matchThing() so the exhaustive search in resolve() below can check every
// length independently, not just stop at the first one that matches
// anything (which is all a single greedy pass ever needed).
function matchAtLength(tokens, k, all) {
  const candidate = tokens.slice(0, k).join(" ").toLowerCase();

  // Level A — exact: candidate equals the thing's whole name. A tie here
  // (two things sharing the identical name) is ambiguous at this level,
  // not diluted by weaker matches at the same length.
  const exact = all.filter((t) => t.name.toLowerCase() === candidate);
  if (exact.length > 0) return exact;

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
  if (prefix.length > 0) return prefix;

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
  if (substring.length > 0) return substring;

  return [];
}

// A single greedy pass — the longest length with any match at all, full
// stop. Still what the "nothing resolves anywhere" fallback in resolve()
// below reduces to (see fallbackResult), just no longer the whole algorithm.
function matchThing(tokens, all) {
  for (let k = tokens.length; k >= 1; k--) {
    const matches = matchAtLength(tokens, k, all);
    if (matches.length > 0) return { matches, consumed: k };
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

function deadEnd(label, why, zone, deviceClass, kind) {
  return { matches: [candidateRow(label, why, { zone, deviceClass, kind })] };
}

// A genuine dead end (this exact input can never complete, no matter what's
// typed next — the word doesn't apply here, the value's out of range) that
// nonetheless already resolved real grammar structure first: a recognized
// capability word/kind, a valid join/exclusion scope. resolve() prefers
// this over a raw, uninformative name tie when nothing anywhere completes —
// the word/kind/join/exclusion it matched is real signal, not noise to
// discard alongside dead ends that matched nothing at all. Distinct from
// pendingScope below, which isn't a dead end at all.
function progressedDeadEnd(label, why, zone, deviceClass) {
  return { ...deadEnd(label, why, zone, deviceClass), progressed: true };
}

// A scope's own label, qualified with the capability word that picked it —
// "Wohnzimmer light", not just "Wohnzimmer" — so a row for a capability-
// scoped batch reads as "the lights in Wohnzimmer," not as the Wohnzimmer
// zone itself (which a bare room query already means). Skipped when the
// word IS the label (a bare kind thing like "light" passes its own name as
// both — "light light" would just repeat it) or there's no word at all (a
// bare verb like "hallway unlock" needs no capability word to begin with).
function scopeDisplayLabel(label, word) {
  return word && word.toLowerCase() !== label.toLowerCase() ? `${label} ${word}` : label;
}

// NOT a dead end — a scope (zone/kind/join/exclusion) and its capability are
// already resolved, the person just hasn't typed a value/verb yet. Any valid
// one typed next completes it, unlike progressedDeadEnd's cases (no amount
// of typing fixes "no vol here"). Carries memberIds so a caller can preview
// which devices are actually in scope even before a value exists — the
// same visibility a completed batch already gets from its own per-device
// breakdown (previewRowForAction), just previewed one step earlier.
function pendingScope(label, word, memberIds) {
  return {
    matches: [
      candidateRow(scopeDisplayLabel(label, word), "needs a verb or number", { kind: "zone", deviceClass: WORD_ICON_CLASS[word] }),
    ],
    progressed: true,
    scopeLabel: label,
    scopeWord: word,
    memberIds,
  };
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

// A completed zone/kind/join/exclusion batch's own summary row — the
// obvious, topmost choice for running the whole batch as typed, ahead of
// the per-device breakdown previewRowForAction already builds for each of
// its members. Labeled with the capability word too (scopeDisplayLabel),
// same as pendingScope's own row — "Wohnzimmer light," not just
// "Wohnzimmer," so it reads as the lights in that zone, not the zone
// itself. Distinct from mergeReadings' own batch-row branch
// (candidateRowForReading): that one has no `line` of its own, since a tied
// candidate has to be picked and re-resolved first — this one's line is
// simply the original input, since re-running it is exactly this batch,
// with no tie to resolve away. index.mjs is the only caller — like
// previewRowForAction, this is prompt.resolve's own preview concern, not
// part of resolve()'s return shape run() still needs raw.
export function previewRowForBatch(scopeLabel, scopeWord, actions, devices, zones, line) {
  const { capabilityId, value } = actions[0];
  return candidateRow(scopeDisplayLabel(scopeLabel, scopeWord), formatCapabilityWhy(capabilityId, value), {
    kind: "zone",
    deviceClass: WORD_ICON_CLASS[scopeWord],
    line,
  });
}

// One member of a pendingScope's own scope, previewed before any value
// exists — the same per-device visibility previewRowForAction gives a
// completed batch, one step earlier. No `line`: there's nothing to run yet,
// same as deadEnd's own rows never carry one.
export function previewRowForPendingMember(deviceId, devices, zones) {
  const device = devices[deviceId];
  return candidateRow(device?.name, "needs a verb or number", { zone: zones[device?.zone]?.name, deviceClass: device?.class });
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

  if (SPEAKER_VERB_WORDS.has(rest.toLowerCase()) && capsObj.speaker_playing?.setable) {
    return { matches: [], action: { deviceId: device.id, capabilityId: "speaker_playing", value: rest.toLowerCase() === "play" } };
  }

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

// A bare verb (on/off/lock/unlock) needs no capability word or kind at
// all — every device in scope with the relevant capability takes it
// directly, same priority resolveDevice already gives a verb over value
// parsing for a single device. Returns null (not a dead end) when the verb
// isn't recognized or nothing in scope takes it, so the caller falls
// through to word/kind resolution instead — e.g. a zone whose only
// controllable capability is target_temperature still needs to try that
// path for "on"/"off", since locked/onoff never come from kind-inference.
function tryScopedVerb(scopeDevices, restTokens, label) {
  const firstToken = (restTokens[0] ?? "").toLowerCase();
  if (!VERB_WORDS.has(firstToken)) return null;
  const isLockVerb = firstToken === "lock" || firstToken === "unlock";
  const capabilityId = isLockVerb ? "locked" : "onoff";
  const value = isLockVerb ? firstToken === "lock" : firstToken === "on";
  const members = scopeDevices.filter((d) => d.capabilitiesObj?.[capabilityId]?.setable);
  if (members.length === 0) return null;
  return { matches: [], actions: members.map((d) => ({ deviceId: d.id, capabilityId, value })), scopeLabel: label };
}

// A capability already known (a kind thing already IS the capability, a
// zone/join/exclusion scope has already picked one via a word or
// single-kind inference) applied across whichever devices in scope have
// it. A device that can't take the given value (out of its own range, on
// the absolute/step forms that dead-end rather than clamp) is skipped
// rather than failing the whole batch — one device's narrower range
// shouldn't block every other device the word matched. `on`/`off` as a
// bare value still means onoff even though the capability picked was
// dim/etc — "light on" turns the lights on, it doesn't try to set dim to
// the word "on".
function applyScopedValue(members, capabilityId, valueTokens, notches, label, word) {
  const valueText = valueTokens.join(" ").trim();
  if (valueText === "") return pendingScope(label, word, members.map((d) => d.id));
  const lowerValue = valueText.toLowerCase();
  if (lowerValue === "on" || lowerValue === "off") {
    const actions = members
      .filter((d) => d.capabilitiesObj?.onoff?.setable)
      .map((d) => ({ deviceId: d.id, capabilityId: "onoff", value: lowerValue === "on" }));
    if (actions.length === 0) return progressedDeadEnd(label, `no ${word ?? "on/off"} here`);
    return { matches: [], actions, scopeLabel: label, scopeWord: word };
  }

  const parsed = parseValue(valueText);
  if (!parsed) return progressedDeadEnd(label, "needs a number");
  const actions = [];
  for (const device of members) {
    const applied = applyValue(device, capabilityId, parsed, notches);
    if (applied.value !== undefined) actions.push({ deviceId: device.id, capabilityId, value: applied.value });
  }
  if (actions.length === 0) return progressedDeadEnd(label, "needs a different value");
  return { matches: [], actions, scopeLabel: label, scopeWord: word };
}

// A word glued directly to a notch with no space — "temp++" — the same
// sign-doubled-after-a-name notch design.md shows for a thing (`kitchen++`)
// applied to a word instead. Split into two tokens so matchWord/parseValue
// each see exactly the form they already know how to parse; a token that
// isn't a recognized word with a glued notch passes through unchanged.
function splitGluedNotch(restTokens) {
  const first = restTokens[0];
  if (!first || !(first.endsWith("++") || first.endsWith("--"))) return restTokens;
  const word = first.slice(0, -2);
  const notch = first.slice(-2);
  if (!matchWord(word)) return restTokens;
  return [word, notch, ...restTokens.slice(1)];
}

// A device scope with more than one controllable capability type needs a
// word to say which one a trailing verb/value applies to; exactly one
// makes the word optional, the same "bare value targets the thing's own
// obvious capability" default resolveDevice already applies to a single
// device (design.md doesn't scope that rule to devices alone). Shared by
// every "batch a capability write across several devices" entry point — a
// single zone, a joined zone list — so each only has to compute *which*
// devices are in scope, not how a word/verb/value gets applied once they
// are. A `kind` thing skips this entirely (resolveKind below): its
// capability is already fixed by the kind itself.
function resolveCapabilityAction(scopeDevices, rawRestTokens, notches, label) {
  const restTokens = splitGluedNotch(rawRestTokens);

  const verbReading = tryScopedVerb(scopeDevices, restTokens, label);
  if (verbReading) return verbReading;

  const word = matchWord(restTokens[0]);
  let capabilityId;
  let valueTokens;
  if (word) {
    capabilityId = WORD_CAPABILITY[word];
    valueTokens = restTokens.slice(1);
  } else {
    const kinds = new Set();
    for (const d of scopeDevices) {
      for (const id of NUMERIC_TARGETS) if (d.capabilitiesObj?.[id]?.setable) kinds.add(id);
    }
    if (kinds.size !== 1) return progressedDeadEnd(label, "needs a word");
    capabilityId = [...kinds][0];
    valueTokens = restTokens;
  }

  const members = scopeDevices.filter((d) => d.capabilitiesObj?.[capabilityId]?.setable);
  if (members.length === 0) return progressedDeadEnd(label, `no ${word} here`);

  return applyScopedValue(members, capabilityId, valueTokens, notches, label, word);
}

function resolveZoneWord(zoneThing, restTokens, devices, notches) {
  const zoneDevices = Object.values(devices).filter((d) => d.zone === zoneThing.id);
  return resolveCapabilityAction(zoneDevices, restTokens, notches, zoneThing.name);
}

// A single "+"/"!"-fragment resolved as a zone name — reuses matchAtLength's
// own exact/prefix/substring tiers (the same three levels "wohn" alone
// already resolves through), scoped to zones only, so "wohn+arb" fuzzy-
// matches exactly as well as "wohn" does on its own instead of demanding
// each joined/excluded part be typed in full. Returns null on no match *or*
// a genuine tie (two zones both matching "arb," say) — never guesses which
// one was meant for something that goes on to write to real devices.
function matchZoneByName(text, zones) {
  const zoneThings = Object.values(zones).map((z) => ({ kind: "zone", id: z.id, name: z.name.trim(), ref: z }));
  const matches = matchAtLength([text], 1, zoneThings);
  return matches.length === 1 ? matches[0].ref : null;
}

// A bare `kind` (design.md: son/light/temp) with no zone at all — every
// device across the whole house with that one capability, optionally minus
// one excluded zone (`!thing`, a single token, checked before the value —
// a kind thing already IS the capability, so unlike resolveZoneWord there's
// no separate word to match first, and no kind-inference needed either).
// Multi-token excluded zone names and joined exclusions (`!a+b`) aren't
// supported yet — every exclusion design.md itself shows is a single zone.
function resolveKind(kindThing, restTokens, devices, zones, notches) {
  let scopeDevices = Object.values(devices).filter((d) => d.capabilitiesObj?.[kindThing.capabilityId]?.setable);
  let valueTokens = restTokens;

  if ((restTokens[0] ?? "").startsWith("!")) {
    const excludedZone = matchZoneByName(restTokens[0].slice(1), zones);
    if (!excludedZone) return progressedDeadEnd(kindThing.name, "no match there");
    scopeDevices = scopeDevices.filter((d) => d.zone !== excludedZone.id);
    valueTokens = restTokens.slice(1);
  }

  return applyScopedValue(scopeDevices, kindThing.capabilityId, valueTokens, notches, kindThing.name, kindThing.name);
}

// A leading `+`-joined thing-list (design.md's "kitchen+office light 20")
// — each part fuzzy-matched as its own zone (matchZoneByName), their device
// sets unioned before the shared word/value handling applies. Returns null
// (not a dead end) when the leading token has no "+" at all, or any part
// fails to name a real zone, so resolve()'s normal matching still gets a
// chance at whatever this input actually is.
function tryJoinedZones(tokens, devices, zones, notches) {
  if (!tokens[0]?.includes("+")) return null;
  const matchedZones = tokens[0].split("+").map((part) => matchZoneByName(part, zones));
  if (matchedZones.some((z) => !z)) return null;

  const zoneIds = new Set(matchedZones.map((z) => z.id));
  const scopeDevices = Object.values(devices).filter((d) => zoneIds.has(d.zone));
  const label = matchedZones.map((z) => z.name).join("+");
  return resolveCapabilityAction(scopeDevices, tokens.slice(1), notches, label);
}

// A leading `!thing` with no thing before it at all — design.md's
// "omitted = whole house" thing, immediately excluding one zone from it.
// Distinct from resolveKind's own exclusion handling: there the capability
// is already fixed by the kind itself; here it still needs a word (or a
// single-capability-kind inference), same as an ordinary zone.
function tryBareExclusion(tokens, devices, zones, notches) {
  if (!tokens[0]?.startsWith("!")) return null;
  const excludedZone = matchZoneByName(tokens[0].slice(1), zones);
  if (!excludedZone) return null;

  const scopeDevices = Object.values(devices).filter((d) => d.zone !== excludedZone.id);
  return resolveCapabilityAction(scopeDevices, tokens.slice(1), notches, `everything except ${excludedZone.name}`);}

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
  if (anyMatch.matches.length === 1) return deadEnd(anyMatch.matches[0].name, "no match there", undefined, undefined, "zone");

  return null;
}

// One length's worth of readings: what happens to whatever matched at this
// k, given the tokens left over. A unique thing produces exactly one
// reading (resolveDevice/resolveZoneWord/a room query, complete or not). A
// tie produces one reading per tied device (each independently resolved
// against the *same*, full leftover text, not just the zone-narrowed one)
// plus, for an all-device tie, the zone-narrowed reading if the leftover
// text qualifies one candidate by zone — narrowByZone already returns null
// when it doesn't apply, so this never adds a reading a device-name tie
// couldn't actually produce.
// One thing, whatever kind it is, resolved against the leftover text — the
// single-entity half of readingsAt, reused for both a unique match and each
// member of a tie. A bare mood (like a bare zone's room query) only counts
// once there's nothing left to explain — trailing text after a mood name
// has no grammar of its own to mean anything, so it's simply not a
// reading, the same as an empty rest not being a reading for a device.
function readingForThing(thing, restTokens, restText, devices, zones, notches) {
  if (thing.kind === "zone") {
    if (restText === "") return { matches: [], room: { id: thing.id, name: thing.name } };
    return resolveZoneWord(thing, restTokens, devices, notches);
  }
  if (thing.kind === "mood") {
    return restText === "" ? { matches: [], mood: { id: thing.id, name: thing.name } } : null;
  }
  if (thing.kind === "thingKind") {
    return resolveKind(thing, restTokens, devices, zones, notches);
  }
  return resolveDevice(thing.ref, restText, zones, notches);
}

// One length's worth of readings: what happens to whatever matched at this
// k, given the tokens left over. A unique thing produces exactly one
// reading (resolveDevice/resolveZoneWord/resolveKind/a room or mood query,
// complete or not). A tie produces one reading per tied entity (each
// independently resolved against the *same*, full leftover text, not just
// the zone-narrowed one) plus, for an all-device tie, the zone-narrowed
// reading if the leftover text qualifies one candidate by zone —
// narrowByZone already returns null when it doesn't apply, so this never
// adds a reading a device-name tie couldn't actually produce.
function readingsAt(matches, restTokens, devices, zones, notches) {
  const restText = restTokens.join(" ").trim();

  if (matches.length === 1) {
    const reading = readingForThing(matches[0], restTokens, restText, devices, zones, notches);
    return reading ? [reading] : [];
  }

  const readings = [];
  if (matches.every((t) => t.kind === "device")) {
    const narrowed = narrowByZone(matches, restTokens, zones, notches);
    if (narrowed) readings.push(narrowed);
    for (const t of matches) readings.push(resolveDevice(t.ref, restText, zones, notches));
  } else {
    // A tie spanning entities of different kinds (a name collision, e.g.
    // "Attic" the zone and "Attic" the device) — zone-narrowing doesn't
    // apply (no zone of its own to narrow a zone by), so each entity just
    // gets its own attempt at the same leftover text. A bare room/mood
    // reading (empty rest) is deliberately not a candidate here: it needs
    // no further input, but that's not the same as being what the person
    // meant — another tied entity is just as likely, and letting the bare
    // reading silently outrank it for being "complete" would be exactly
    // the silent guess this grammar never makes.
    for (const t of matches) {
      if (t.kind === "zone" || t.kind === "mood") {
        if (restText !== "") {
          const reading = readingForThing(t, restTokens, restText, devices, zones, notches);
          if (reading) readings.push(reading);
        }
      } else if (t.kind === "thingKind") {
        readings.push(resolveKind(t, restTokens, devices, zones, notches));
      } else {
        readings.push(resolveDevice(t.ref, restText, zones, notches));
      }
    }
  }
  return readings;
}

function isComplete(reading) {
  return reading.action !== undefined || reading.actions !== undefined || reading.room !== undefined || reading.mood !== undefined;
}

// Converts a single complete reading into the candidateRow shape a client
// renders — the same shape ambiguous()/deadEnd() already build, so a
// merged list of candidates looks identical whether the tie came from here
// or from there.
function candidateRowForReading(reading, devices, zones) {
  if (reading.room) return candidateRow(reading.room.name, "room", { kind: "zone" });
  if (reading.mood) return candidateRow(reading.mood.name, "mood", { kind: "mood" });

  if (reading.action) {
    const { deviceId, capabilityId, value } = reading.action;
    const device = devices[deviceId];
    return candidateRow(device.name, formatCapabilityWhy(capabilityId, value), {
      kind: "device",
      zone: zones[device.zone]?.name,
      deviceClass: device.class,
      line: lineFor(device.name, capabilityId, value),
    });
  }

  // A batch: every action shares the same capability/value (resolveZoneWord
  // applies one word/value uniformly), so the first stands for all of them,
  // and the zone they share is read off any one of their own devices rather
  // than threaded through as a separate parameter.
  const { capabilityId, value } = reading.actions[0];
  const zoneId = devices[reading.actions[0].deviceId]?.zone;
  return candidateRow(zones[zoneId]?.name ?? "", formatCapabilityWhy(capabilityId, value), { kind: "zone" });
}

// Two device-action readings can resolve to the exact same literal name (a
// device tied on name across zones, e.g. two "Reading Lamp"s) — their line
// would otherwise be identical too, so picking either candidate and running
// it lands back on the same tie instead of the specific one that was
// chosen. Only rebuilt for an actual collision: a device whose own name
// already contains its zone ("Living Room Light 2") must not get it
// prepended a second time when its label is already unique in this list.
function mergeReadings(complete, devices, zones) {
  const rows = complete.map((r) => candidateRowForReading(r, devices, zones));

  const labelCounts = new Map();
  for (const row of rows) labelCounts.set(row.label, (labelCounts.get(row.label) ?? 0) + 1);

  rows.forEach((row, i) => {
    const reading = complete[i];
    if (labelCounts.get(row.label) > 1 && row.kind === "device" && row.zone && reading.action) {
      const { capabilityId, value } = reading.action;
      row.line = lineFor(`${row.label} ${row.zone}`, capabilityId, value);
    }
  });

  return { matches: rows };
}

// Nothing resolved completely anywhere — the same single greedy pass as
// before, except preferring a dead end from a *unique* thing match over one
// from a tie that never narrowed, regardless of which length either came
// from. A tie's own dead end ("pick one of these three") isn't more
// informative just because a longer prefix happened to find it — e.g.
// "living room light" ties on "Living Room Light 2/3/4" at a longer length,
// but "Living Room" alone, uniquely matched, resolves the word and dead-ends
// on the specific, more useful "needs a verb or number".
function fallbackResult(tokens, all, devices, zones, notches) {
  for (let k = tokens.length; k >= 1; k--) {
    const matches = matchAtLength(tokens, k, all);
    if (matches.length === 1) return readingsAt(matches, tokens.slice(k), devices, zones, notches)[0];
  }
  for (let k = tokens.length; k >= 1; k--) {
    const matches = matchAtLength(tokens, k, all);
    if (matches.length === 0) continue;
    const restTokens = tokens.slice(k);

    // Before dumping the raw tie, check whether any tied entity's own
    // reading already recognized a word/kind — a reading with real progress
    // (progressedDeadEnd or pendingScope) is a far more useful answer than
    // "pick one of these names" when the word that would have picked one
    // was right there in the input. Same k-priority as everything else
    // here: only checked once no *longer* k found a unique match at all.
    // A single progressed reading is returned whole (not just its .matches)
    // so pendingScope's scopeLabel/scopeWord/memberIds survive for index.mjs
    // to build a per-member preview from, same as a completed batch gets.
    const progressed = readingsAt(matches, restTokens, devices, zones, notches).filter((r) => r.progressed);
    if (progressed.length === 1) return progressed[0];
    if (progressed.length > 1) return { matches: progressed.flatMap((r) => r.matches) };

    if (matches.every((t) => t.kind === "device")) {
      const narrowed = narrowByZone(matches, restTokens, zones, notches);
      if (narrowed) return narrowed;
    }
    return ambiguous(matches, zones, restTokens.join(" ").trim());
  }
  return { matches: [] };
}

// design.md's chain: `,`/`;` splits independent segments, each resolved on
// its own — except a segment that starts with a word, no thing of its own,
// which inherits the previous segment's subject. Inheritance is applied
// directly (calling resolveCapabilityAction against the previous subject's
// own zone) rather than by reconstructing "<subject> <segment>" as text and
// re-resolving it: the reconstructed text can hit the exact same
// same-name-tie collision ordinary zone+word queries do (see
// mergeReadings), which would derail chain resolution into a candidate
// list instead of the single batch a chain segment always wants. Every
// segment's actions are concatenated into one combined batch — a chain
// isn't itself a candidate to pick from, it's several things to do at once.
function resolveChain(segments, opts) {
  let subjectZone = null;
  const actions = [];

  for (const segment of segments) {
    let result = null;

    if (subjectZone) {
      const inherited = resolveCapabilityAction(
        Object.values(opts.devices).filter((d) => d.zone === subjectZone.id),
        segment.split(/\s+/),
        opts.notches,
        subjectZone.name
      );
      if (inherited.action || inherited.actions) result = inherited;
    }
    if (!result) result = resolve(segment, opts);

    if (result.action) actions.push(result.action);
    if (result.actions) actions.push(...result.actions);

    const firstAction = result.action ?? result.actions?.[0];
    if (firstAction) {
      const zoneId = opts.devices[firstAction.deviceId]?.zone;
      if (zoneId) subjectZone = { id: zoneId, name: opts.zones[zoneId]?.name };
    } else if (result.room) {
      subjectZone = { id: result.room.id, name: result.room.name };
    }
  }

  return actions.length > 0 ? { matches: [], actions } : { matches: [] };
}

// design.md's `?` — the words that apply to a resolved device, not a
// candidate to run. Only a device is covered here: a zone's own applicable
// words are exactly the capability words a multi-kind zone would need
// (already surfaced piecemeal in its dead ends), and there's no established
// row shape yet to extend for one the way ambiguous()/deadEnd() cover
// devices. Sorted for a stable, scannable order — this is a list a person
// reads, not a batch of actions where order never mattered before.
function applicableWords(device) {
  const capsObj = device.ref.capabilitiesObj ?? {};
  const words = [];
  if (capsObj.onoff?.setable) words.push("on", "off");
  if (capsObj.locked?.setable) words.push("lock", "unlock");
  if (capsObj.speaker_playing?.setable) words.push("play", "pause");
  const numeric = NUMERIC_TARGETS.filter((id) => capsObj[id]?.setable);
  if (numeric.length === 1 && CAPABILITY_KIND[numeric[0]]) words.push(CAPABILITY_KIND[numeric[0]]);
  return words.sort();
}

function resolveWordsQuery(thingText, devices, zones, moods) {
  if (thingText === "") return { matches: [] };
  const matched = matchThing(thingText.split(/\s+/), things(devices, zones, moods));
  if (matched.matches.length !== 1 || matched.matches[0].kind !== "device") return { matches: [] };
  const device = matched.matches[0];
  return { matches: [], words: { label: device.name, list: applicableWords(device) } };
}

// prompt.resolve's implementation. Enumerates every length the input could
// split at (not just the longest one that matches anything), collects every
// reading that comes back complete regardless of which length it came from,
// and merges them: one complete reading anywhere wins outright, more than
// one comes back as a candidate list instead of silently picking the
// longest, and none falls back to the previous single-pass behavior — see
// docs/design.md's "Resolving a query is not just matching a thing".
export function resolve(text, { devices, zones, notches, moods }) {
  const trimmed = text.trim();
  if (trimmed === "") return { matches: [] };

  if (trimmed.endsWith("?")) return resolveWordsQuery(trimmed.slice(0, -1).trim(), devices, zones, moods);

  const segments = trimmed.split(/[,;]/).map((s) => s.trim()).filter((s) => s !== "");
  if (segments.length > 1) return resolveChain(segments, { devices, zones, notches, moods });

  const tokens = trimmed.split(/\s+/);
  const all = things(devices, zones, moods);

  const complete = [];

  // A leading `+`-joined thing-list or a leading bare `!exclusion` are both
  // token-internal forms the ordinary per-length matching below never
  // considers (it matches whole, unsplit tokens) — tried once, up front,
  // rather than woven into the k loop.
  const joined = tryJoinedZones(tokens, devices, zones, notches);
  if (joined && isComplete(joined)) complete.push(joined);
  const excluded = tryBareExclusion(tokens, devices, zones, notches);
  if (excluded && isComplete(excluded)) complete.push(excluded);

  for (let k = tokens.length; k >= 1; k--) {
    const matches = matchAtLength(tokens, k, all);
    if (matches.length === 0) continue;
    for (const reading of readingsAt(matches, tokens.slice(k), devices, zones, notches)) {
      if (isComplete(reading)) complete.push(reading);
    }
  }

  if (complete.length === 1) return complete[0];
  if (complete.length > 1) return mergeReadings(complete, devices, zones);

  // Nothing completed anywhere — matchAtLength never sees a "+"/"!" token as
  // anything but a literal, unmatchable string, so fallbackResult below has
  // no idea a join/exclusion was even typed. A join/exclusion that already
  // resolved real zones and a word, just short a value, is still a far
  // better answer than fallbackResult's raw fallback would ever produce for
  // this input, so it's preferred directly — returned whole (not just its
  // .matches) so a pendingScope's scopeLabel/scopeWord/memberIds survive.
  if (joined && joined.progressed) return joined;
  if (excluded && excluded.progressed) return excluded;

  return fallbackResult(tokens, all, devices, zones, notches);
}

// prompt.run's implementation: re-resolves `line` and, if it names an
// action, performs it through the caller-supplied setCapabilityValue (the
// serialized write function core/index.mjs owns) rather than
// homey.mjs's thin wrapper directly. activateMood is the same shape for a
// resolved mood.
export async function run(line, { devices, zones, setCapabilityValue, activateMood, notches, moods }) {
  const result = resolve(line, { devices, zones, notches, moods });

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
    // already resolved to a value for. A partial failure still reports
    // `ok: true` (the devices that did apply really did change), but
    // carries `failed` so the caller can tell a clean success from a batch
    // where some devices were silently skipped, rather than losing the
    // rejected ones' errors entirely.
    const settled = await Promise.allSettled(
      result.actions.map((a) => setCapabilityValue(devices[a.deviceId], a.capabilityId, a.value))
    );
    const changes = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
    const failed = settled
      .filter((s) => s.status === "rejected")
      .map((s) => (s.reason && s.reason.message ? s.reason.message : String(s.reason)));
    if (changes.length === 0) {
      return { ok: false, error: failed[0] ?? "all writes failed" };
    }
    return failed.length > 0 ? { ok: true, changes, failed } : { ok: true, changes };
  }

  if (result.mood) {
    try {
      await activateMood(result.mood.id);
      return { ok: true, mood: result.mood };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  if (result.room) return { ok: false, room: result.room };
  return { ok: false, matches: result.matches };
}

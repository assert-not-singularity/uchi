import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "../grammar.mjs";
import { devices, zones } from "./fixture.mjs";

test('"desk 40" resolves to the Desk Lamp\'s dim capability, percent-converted', () => {
  const result = resolve("desk 40", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.4 },
  });
});

// Desk Lamp's fixture default is dim: 0.6 (60%).
test('"desk +10" steps up from the current level, not an absolute 10%', () => {
  const result = resolve("desk +10", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.7 },
  });
});

test('"desk -10" steps down from the current level', () => {
  const result = resolve("desk -10", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.5 },
  });
});

test('a step outside the capability\'s range is a dead end, not clamped', () => {
  const result = resolve("desk +50", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches[0].why, "needs 0–100");
});

test('"desk *2" doubles the current level and clamps at the capability\'s max', () => {
  // 60% * 2 = 120%, clamped to 100 — design.md: scale "clamps at 0/100".
  const result = resolve("desk *2", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 1 },
  });
});

test('"desk /2" halves the current level', () => {
  const result = resolve("desk /2", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.3 },
  });
});

test('"desk /0" is rejected, not a silent write to the capability\'s maximum', () => {
  // 60 / 0 = Infinity, which the clamp would otherwise silently turn into
  // a write at the capability's max — confirmed live before this fix.
  const result = resolve("desk /0", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches[0].why, "needs a number");
});

test("scale is levels-only — a thermostat has no reading to scale", () => {
  const result = resolve("bedroom thermostat *2", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches[0].why, "needs a word");
});

test('"desk ++" steps up by the configured light notch, clamping rather than dead-ending', () => {
  const result = resolve("desk ++", { devices, zones, notches: { light: 10, vol: 5, temp: 1 } });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.7 },
  });
});

test('"desk --" steps down by the configured light notch', () => {
  const result = resolve("desk --", { devices, zones, notches: { light: 10, vol: 5, temp: 1 } });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.5 },
  });
});

test('a notch with no configured step for its kind falls back to 1, still clamping', () => {
  const result = resolve("desk ++", { devices, zones, notches: {} });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.61 },
  });
});

test("a value outside a capability's min/max is a dead end, not a clamped write", () => {
  const result = resolve("bedroom thermostat 40", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].label, "Bedroom Thermostat");
  assert.equal(result.matches[0].why, "needs 4–35");
});

test("a multi-kind zone with a bare number needs a word, not a guess", () => {
  const result = resolve("living room 40", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.room, undefined);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].label, "Living Room");
  assert.equal(result.matches[0].why, "needs a word");
});

test('"front door unlock" resolves to the locked capability, value false', () => {
  const result = resolve("front door unlock", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "hallway-lock", capabilityId: "locked", value: false },
  });
});

test('a bare "front door" (no verb or number) needs a verb or number, not "front door 0"', () => {
  const result = resolve("front door", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].label, "Front Door");
  assert.equal(result.matches[0].why, "needs a verb or number");
});

test('a bare "office" resolves to a room query, not a device match', () => {
  const result = resolve("office", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    room: { id: "zone-office", name: "Office" },
  });
});

test("two devices sharing an exact name resolve as ambiguous, zone-qualified candidates", () => {
  const result = resolve("reading lamp", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.room, undefined);
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every((m) => m.label === "Reading Lamp"));
  const resultZones = result.matches.map((m) => m.zone).sort();
  assert.deepEqual(resultZones, ["Living Room", "Office"]);
});

test("a trailing value that doesn't narrow by zone is echoed back as rest, not dropped", () => {
  // "20" is neither zone nor consumed by either candidate — a client needs
  // it back to reconstruct "<label> <zone> <rest>" once a person picks one
  // of the ambiguous candidates, since neither this function nor the RPC
  // layer can guess which one was meant.
  const result = resolve("reading lamp 20", { devices, zones });
  assert.equal(result.matches.length, 2);
  assert.equal(result.rest, "20");
});

test("a leading verb word skips zone-narrowing even if it substring-matches an unrelated zone", () => {
  // "on" is a substring of "Salon" — confirmed live against a real house
  // that this exact kind of coincidence ("on" inside "Nutzerkonten")
  // hijacked an ambiguous list into a bogus "no match in <unrelated zone>"
  // dead end. A local zone, not a fixture.mjs change, since neither
  // Reading Lamp zone needs to be involved for this collision to matter.
  const zonesWithCollision = { ...zones, "zone-salon": { id: "zone-salon", name: "Salon", parent: null } };
  const result = resolve("reading lamp on", { devices, zones: zonesWithCollision });
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every((m) => m.label === "Reading Lamp"));
});

// A local copy, not a change to fixture.mjs's shared devices — a trailing
// space on just one of two otherwise identically named devices, confirmed
// live against a real house (two of three "Deckenleuchte"s had one, the
// third didn't), broke their exact-match tie: the space-free one would
// resolve alone instead of tying with its "identically" named sibling.
const paddedNameDevices = {
  ...devices,
  "office-reading-lamp": { ...devices["office-reading-lamp"], name: "Reading Lamp " },
};

test("a trailing space on only one of two identically named devices doesn't break their tie", () => {
  const result = resolve("reading lamp", { devices: paddedNameDevices, zones });
  assert.equal(result.matches.length, 2);
  const resultZones = result.matches.map((m) => m.zone).sort();
  assert.deepEqual(resultZones, ["Living Room", "Office"]);
});

test("zone-narrowing still resolves the padded-name candidate correctly", () => {
  const result = resolve("reading lamp office 40", { devices: paddedNameDevices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-reading-lamp", capabilityId: "dim", value: 0.4 },
  });
});

test("a trailing zone name narrows an ambiguous exact-name match to one device", () => {
  const result = resolve("reading lamp office 40", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-reading-lamp", capabilityId: "dim", value: 0.4 },
  });
});

test("the other zone narrows the same ambiguous name to the other device", () => {
  const result = resolve("reading lamp living 40", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "living-reading-lamp", capabilityId: "dim", value: 0.4 },
  });
});

test("a zone with no matching device among the ambiguous set is a dead end", () => {
  const result = resolve("reading lamp kitchen", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].label, "Kitchen");
  assert.equal(result.matches[0].why, "no match there");
});

test("a trailing word that isn't a zone leaves the ambiguous list untouched", () => {
  const result = resolve("reading lamp foo", { devices, zones });
  assert.equal(result.matches.length, 2);
});

test("zone-narrowing matches only the ambiguous candidates' own zones, not every zone in the house", () => {
  // "ic" is a substring of both "Office" (one of Reading Lamp's two zones)
  // and "Attic" (a real zone, but not one either Reading Lamp is in) — it
  // must narrow to Office without "Attic" diluting it into a tie, since
  // Attic was never a real candidate here.
  const result = resolve("reading lamp ic 40", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-reading-lamp", capabilityId: "dim", value: 0.4 },
  });
});

test("an exact match at a shorter length beats a same-length prefix match on a different, longer name", () => {
  // "Attic" (zone) and "Attic" (device) both match exactly at k=1;
  // "Attic Switch" only matches as a token-aligned *prefix* at that same
  // k=1 and must not dilute the exact tie into a 3-way ambiguity.
  const result = resolve("attic", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.room, undefined);
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every((m) => m.label === "Attic"));
  const withZone = result.matches.filter((m) => m.zone !== undefined);
  assert.equal(withZone.length, 1);
  assert.equal(withZone[0].zone, "Attic");
});

test("a single-token compound name resolves via substring fallback, not a required full-word type", () => {
  const result = resolve("backlight 40", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-deskbacklight", capabilityId: "dim", value: 0.4 },
  });
});

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

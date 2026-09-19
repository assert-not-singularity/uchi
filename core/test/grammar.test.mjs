import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, run, previewRowForAction, previewRowForBatch, previewRowForPendingMember } from "../grammar.mjs";
import { devices, zones, moods } from "./fixture.mjs";

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

test('"living room light off" merges the zone+word batch with the numbered-light name tie it also completes, instead of turning off only the tied devices\' own individual readings', () => {
  // Verb form of the same collision "living room light 30" covers for a
  // value — "off" goes through VERB_WORDS, a genuinely different code path
  // from parseValue, so this is real coverage, not a duplicate.
  const result = resolve("living room light off", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions, undefined);
  assert.equal(result.matches.length, 4);
  const byLabel = [...result.matches].sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual(
    byLabel.map((m) => ({ label: m.label, why: m.why })),
    [
      { label: "Living Room", why: "off" },
      { label: "Living Room Light 2", why: "off" },
      { label: "Living Room Light 3", why: "off" },
      { label: "Living Room Light 4", why: "off" },
    ]
  );
});

test('"living room temp 21" reaches the zone\'s thermostat via the word, not a bare number', () => {
  const result = resolve("living room temp 21", { devices, zones });
  assert.deepEqual(result.actions, [{ deviceId: "living-thermostat", capabilityId: "target_temperature", value: 21 }]);
});

test('"living room vol 30" reaches the zone\'s speaker via the word', () => {
  const result = resolve("living room vol 30", { devices, zones });
  assert.deepEqual(result.actions, [{ deviceId: "living-speaker", capabilityId: "volume_set", value: 0.3 }]);
});

test("an unrecognized word after a zone is a dead end, not a guess", () => {
  const result = resolve("living room xyz 40", { devices, zones });
  assert.equal(result.actions, undefined);
  assert.equal(result.matches[0].why, "needs a word");
});

test("a zone + word with no trailing value needs a verb or number", () => {
  const result = resolve("living room light", { devices, zones });
  assert.equal(result.actions, undefined);
  assert.equal(result.matches[0].why, "needs a verb or number");
});

test("a word matching a capability the zone doesn't have is a dead end", () => {
  // The Bedroom has a thermostat but no speaker — "vol" shouldn't silently
  // fall back to some other capability.
  const result = resolve("bedroom vol 30", { devices, zones });
  assert.equal(result.actions, undefined);
  assert.equal(result.matches[0].why, "no vol here");
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

test("a device-specific dead end still carries deviceClass, for a client to pick an icon", () => {
  const result = resolve("desk", { devices, zones });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].why, "needs a verb or number");
  assert.equal(result.matches[0].deviceClass, "light");
});

test('"living room temp 21" carries scopeLabel "Living Room" and scopeWord "temp" — index.mjs prepends previewRowForBatch\'s summary row ahead of the per-device breakdown from this', () => {
  const result = resolve("living room temp 21", { devices, zones });
  assert.equal(result.scopeLabel, "Living Room");
  assert.equal(result.scopeWord, "temp");
});

test('previewRowForBatch builds the obvious, topmost summary row for a completed batch, labeled with the capability word ("Living Room temp") so it reads as the zone\'s thermostat, not the zone itself', () => {
  const result = resolve("living room temp 21", { devices, zones });
  const row = previewRowForBatch(result.scopeLabel, result.scopeWord, result.actions, devices, zones, "living room temp 21");
  assert.deepEqual(row, { label: "Living Room temp", why: "21°", kind: "zone", deviceClass: "thermostat", line: "living room temp 21" });
});

test('previewRowForBatch skips the word suffix for a bare kind, where the word already IS the label ("light," not "light light")', () => {
  const result = resolve("light off", { devices, zones });
  const row = previewRowForBatch(result.scopeLabel, result.scopeWord, result.actions, devices, zones, "light off");
  assert.equal(row.label, "light");
});

test("previewRowForAction builds the same candidate-row shape as an ambiguous/dead-end match", () => {
  const { action } = resolve("desk 40", { devices, zones });
  const row = previewRowForAction(action, devices, zones, "desk 40");
  assert.deepEqual(row, { label: "Desk Lamp", why: "40%", zone: "Office", deviceClass: "light", line: "desk 40" });
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

test("a trailing value that isn't a zone name still resolves — each tied device takes it independently", () => {
  // "20" doesn't narrow by zone, but it's a perfectly valid dim value for
  // both Reading Lamps on their own — each becomes its own complete
  // reading, merged into a list rather than staying a bare, unresolved tie.
  const result = resolve("reading lamp 20", { devices, zones });
  assert.equal(result.matches.length, 2);
  const byZone = [...result.matches].sort((a, b) => a.zone.localeCompare(b.zone));
  assert.deepEqual(
    byZone.map((m) => ({ label: m.label, why: m.why, zone: m.zone })),
    [
      { label: "Reading Lamp", why: "20%", zone: "Living Room" },
      { label: "Reading Lamp", why: "20%", zone: "Office" },
    ]
  );
  // Each candidate's line must disambiguate itself — both resolved to the
  // same "Reading Lamp", so picking one and running its own line has to
  // land back on that specific device, not the tie again.
  assert.equal(resolve(byZone[0].line, { devices, zones }).action.deviceId, "living-reading-lamp");
  assert.equal(resolve(byZone[1].line, { devices, zones }).action.deviceId, "office-reading-lamp");
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

test('"attic vol" — a zone/device name tie where only the zone reading recognizes "vol" — surfaces that pending scope instead of the raw 2-way name tie', () => {
  // "Attic" the zone and "Attic" the device (a speaker) tie exactly at
  // k=1, same as the other "attic" tests above. Every tied reading is
  // incomplete here (no value follows "vol"), but they aren't equally
  // useless: the zone's own reading already resolved "vol" to volume_set
  // and found the Attic speaker as its one member — genuinely pending, just
  // short a value — while the device's own reading never gets that far
  // ("vol" isn't a number, full stop, a real dead end). Confirmed live:
  // before this fix, this fell all the way back to the crude "Attic (zone)
  // / Attic (device) — ambiguous, pick one" tie, silently discarding that
  // "vol" was ever recognized at all.
  const result = resolve("attic vol", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions, undefined);
  assert.deepEqual(result.matches, [{ label: "Attic vol", why: "needs a verb or number", kind: "zone", deviceClass: "speaker" }]);
  assert.deepEqual(result.memberIds, ["attic-speaker"]);
});

test('"kitchen+office light" (join, no trailing value) surfaces a pending scope for the joined zones instead of an empty result', () => {
  // matchAtLength never recognizes "kitchen+office" as any kind of thing at
  // all (it's a literal, unmatched string) — before this fix, tryJoinedZones
  // computing this real, valid pending reading (the word "light" resolved
  // fine, only the value is missing) was still discarded because
  // isComplete() said no, and there was no fallback path that knew
  // "+"-joined syntax even existed. Confirmed live against a real house as
  // `{"matches": []}`.
  const result = resolve("kitchen+office light", { devices, zones });
  assert.deepEqual(result.matches, [{ label: "Kitchen+Office light", why: "needs a verb or number", kind: "zone", deviceClass: "light" }]);
  assert.equal(result.memberIds.length, 8);
});

test('"!bedroom light" (bare exclusion, no trailing value) surfaces a pending scope for the excluded zone instead of an empty result', () => {
  const result = resolve("!bedroom light", { devices, zones });
  assert.deepEqual(result.matches, [{ label: "everything except Bedroom light", why: "needs a verb or number", kind: "zone", deviceClass: "light" }]);
  assert.equal(result.memberIds.length, 13);
});

test("previewRowForPendingMember previews one device from a pending scope, the same per-device visibility a completed batch already gets, one step earlier", () => {
  const result = resolve("living room light", { devices, zones });
  assert.equal(result.memberIds.length, 5);
  const row = previewRowForPendingMember(result.memberIds[0], devices, zones);
  assert.equal(row.label, devices[result.memberIds[0]].name);
  assert.equal(row.why, "needs a verb or number");
  assert.equal(row.zone, "Living Room");
  assert.equal("line" in row, false);
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

test("an ambiguous match carries kind/deviceClass, for a client to tell a device candidate from a zone candidate", () => {
  // Same device/zone tie as above — one candidate is the "Attic" zone
  // itself, the other the "Attic" speaker device, both named identically.
  const result = resolve("attic", { devices, zones });
  const zoneMatch = result.matches.find((m) => m.kind === "zone");
  const deviceMatch = result.matches.find((m) => m.kind === "device");
  assert.ok(zoneMatch);
  assert.ok(deviceMatch);
  assert.equal(zoneMatch.zone, undefined);
  assert.equal(deviceMatch.deviceClass, "speaker");
});

test("a single-token compound name resolves via substring fallback, not a required full-word type", () => {
  const result = resolve("backlight 40", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "office-deskbacklight", capabilityId: "dim", value: 0.4 },
  });
});

// ---------------------------------------------------------------------------
// The rest of this file drives docs/design.md's full target grammar tree —
// chain segments, thing-list join/exclusion, bare kinds, moods, zone-level
// verbs/values with no word, and `?` — most of it not implemented at all yet.
// Every test below is expected to fail (RED) against the current grammar.mjs
// unless its own comment says otherwise.
// ---------------------------------------------------------------------------

// --- chain: `,`/`;` splits the input into independent segments -------------

test('"desk 40, front door lock" resolves each comma-separated segment independently, both writes combined', () => {
  const result = resolve("desk 40, front door lock", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions.length, 2);
  const deskAction = result.actions.find((a) => a.deviceId === "office-desk-lamp");
  const lockAction = result.actions.find((a) => a.deviceId === "hallway-lock");
  assert.deepEqual(deskAction, { deviceId: "office-desk-lamp", capabilityId: "dim", value: 0.4 });
  assert.deepEqual(lockAction, { deviceId: "hallway-lock", capabilityId: "locked", value: true });
});

test("a later chain segment that starts with a word, no thing of its own, inherits the previous segment's subject", () => {
  // Segment 1 ("living temp++") resolves the Living Room as its subject and
  // notches the thermostat up by one degree; segment 2 ("light -10") names
  // no thing at all and must inherit that same Living Room subject, stepping
  // every one of its lights down by 10%.
  const result = resolve("living temp++, light -10", { devices, zones, notches: { light: 10, temp: 1 } });
  assert.equal(result.action, undefined);
  assert.equal(result.actions.length, 6);
  const thermostatAction = result.actions.find((a) => a.deviceId === "living-thermostat");
  assert.deepEqual(thermostatAction, { deviceId: "living-thermostat", capabilityId: "target_temperature", value: 21 });
  const lightActions = result.actions.filter((a) => a.capabilityId === "dim");
  assert.equal(lightActions.length, 5);
  assert.ok(lightActions.every((a) => a.value === 0.5));
  const lightIds = lightActions.map((a) => a.deviceId).sort();
  assert.deepEqual(lightIds, [
    "living-floor-lamp",
    "living-light-2",
    "living-light-3",
    "living-light-4",
    "living-reading-lamp",
  ]);
});

// --- thing-list: mood as a thing --------------------------------------------

test('"movie night" as a bare thing activates the mood, not a capability write', () => {
  const result = resolve("movie night", { devices, zones, moods });
  assert.equal(result.action, undefined);
  assert.equal(result.actions, undefined);
  assert.deepEqual(result.mood, { id: "mood-movie-night", name: "Movie Night" });
});

test('run("movie night") activates the mood through the injected activateMood, not setCapabilityValue', async () => {
  const activated = [];
  const result = await run("movie night", {
    devices,
    zones,
    moods,
    setCapabilityValue: () => {
      throw new Error("should not write a capability for a mood");
    },
    activateMood: async (id) => activated.push(id),
  });
  assert.deepEqual(result, { ok: true, mood: { id: "mood-movie-night", name: "Movie Night" } });
  assert.deepEqual(activated, ["mood-movie-night"]);
});

test('run("movie night") reports failure when activateMood rejects, without throwing', async () => {
  const result = await run("movie night", {
    devices,
    zones,
    moods,
    setCapabilityValue: () => {},
    activateMood: async () => {
      throw new Error("Homey unreachable");
    },
  });
  assert.deepEqual(result, { ok: false, error: "Homey unreachable" });
});

// flow as a thing is not covered here: fixture.mjs declares zones/devices/
// moods/notifications/users but no flows at all (docs/design.md names one,
// "Bedtime Routine", but it was never added to the fixture) — there's no
// fixture data this test could resolve against without inventing it, so per
// this task's brief it's a noted blocker rather than a fabricated fixture.

// --- thing-list: kind as a bare thing, whole house, no zone at all ---------

test('"light off" with no zone at all turns off every light in the house', () => {
  const result = resolve("light off", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions.length, 14);
  assert.ok(result.actions.every((a) => a.capabilityId === "onoff" && a.value === false));
  const ids = result.actions.map((a) => a.deviceId).sort();
  assert.deepEqual(ids, [
    "bedroom-lamp",
    "kitchen-light-1",
    "kitchen-light-2",
    "kitchen-light-3",
    "kitchen-light-4",
    "kitchen-light-5",
    "living-floor-lamp",
    "living-light-2",
    "living-light-3",
    "living-light-4",
    "living-reading-lamp",
    "office-desk-lamp",
    "office-deskbacklight",
    "office-reading-lamp",
  ]);
});

test('"temp 20" with no zone at all sets every thermostat in the house', () => {
  const result = resolve("temp 20", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.every((a) => a.capabilityId === "target_temperature" && a.value === 20));
  const ids = result.actions.map((a) => a.deviceId).sort();
  assert.deepEqual(ids, ["bedroom-thermostat", "living-thermostat"]);
});

// "son" is meant to match every Sonos-branded speaker, but fixture.mjs's
// speakers are all plain class:"speaker" with no driverId/brand marking to
// tell a Sonos apart from any other speaker — there's no fixture data this
// grammar could correctly resolve "son" against without this task inventing
// a driverId convention of its own. This pins today's actual (dead-end)
// behavior only, pending that fixture prerequisite — it is expected to PASS
// right now, unlike the rest of this file.
test('"son off" has no Sonos-branded fixture data to resolve against yet', () => {
  const result = resolve("son off", { devices, zones });
  assert.deepEqual(result, { matches: [] });
});

// --- thing-list: joined (`+`) and excluded (`!`) ----------------------------

test('"kitchen+office light 20" batches Kitchen\'s and Office\'s lights together — word is required since Office also has a speaker', () => {
  const result = resolve("kitchen+office light 20", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions.length, 8);
  assert.ok(result.actions.every((a) => a.capabilityId === "dim" && a.value === 0.2));
  const ids = result.actions.map((a) => a.deviceId).sort();
  assert.deepEqual(ids, [
    "kitchen-light-1",
    "kitchen-light-2",
    "kitchen-light-3",
    "kitchen-light-4",
    "kitchen-light-5",
    "office-desk-lamp",
    "office-deskbacklight",
    "office-reading-lamp",
  ]);
});

test('"kit+off light 20" fuzzy-matches each joined part as its own zone, the same prefix matching a lone zone name already gets — not just a full "kitchen+office"', () => {
  const result = resolve("kit+off light 20", { devices, zones });
  assert.equal(result.actions.length, 8);
  const ids = result.actions.map((a) => a.deviceId).sort();
  assert.deepEqual(ids, [
    "kitchen-light-1",
    "kitchen-light-2",
    "kitchen-light-3",
    "kitchen-light-4",
    "kitchen-light-5",
    "office-desk-lamp",
    "office-deskbacklight",
    "office-reading-lamp",
  ]);
});

test('"temp !bed 20" fuzzy-matches the excluded zone by prefix too, not just a full "!bedroom"', () => {
  const result = resolve("temp !bed 20", { devices, zones });
  assert.deepEqual(result.actions, [{ deviceId: "living-thermostat", capabilityId: "target_temperature", value: 20 }]);
});

test('"temp !bedroom 20" reaches every thermostat except the Bedroom\'s', () => {
  const result = resolve("temp !bedroom 20", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    actions: [{ deviceId: "living-thermostat", capabilityId: "target_temperature", value: 20 }],
    scopeLabel: "temp",
    scopeWord: "temp",
  });
});

test('"!bedroom light off" excludes the Bedroom with no leading kind/thing at all — an implicit whole-house kind', () => {
  const result = resolve("!bedroom light off", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions.length, 13);
  assert.ok(result.actions.every((a) => a.capabilityId === "onoff" && a.value === false));
  const ids = result.actions.map((a) => a.deviceId).sort();
  assert.ok(!ids.includes("bedroom-lamp"));
  assert.deepEqual(ids, [
    "kitchen-light-1",
    "kitchen-light-2",
    "kitchen-light-3",
    "kitchen-light-4",
    "kitchen-light-5",
    "living-floor-lamp",
    "living-light-2",
    "living-light-3",
    "living-light-4",
    "living-reading-lamp",
    "office-desk-lamp",
    "office-deskbacklight",
    "office-reading-lamp",
  ]);
});

// --- word: capability word against a naming collision -----------------------

// A local "Pantry" zone: two class:"light" devices only (onoff+dim, the same
// shape fixture.mjs's own light() factory produces) — "Pantry Light" (whose
// full name is itself a zone+word reading: "pantry" + "light") and "Shelf
// Light" (a second light, so the zone+word batch reaches more than the
// exact-name device alone). A local override, not a fixture.mjs change, same
// pattern as paddedNameDevices above — also reused below for the "value
// omitted, zone's one obvious capability" case, since Pantry's two devices
// are both class:"light" and nothing else.
function pantryLight(id, name) {
  return {
    id,
    name,
    zone: "zone-pantry",
    class: "light",
    capabilities: ["onoff", "dim"],
    capabilitiesObj: {
      onoff: { value: true, type: "boolean", getable: true, setable: true },
      dim: { value: 0.6, type: "number", getable: true, setable: true, units: "%", min: 0, max: 1 },
    },
  };
}

const pantryZones = { ...zones, "zone-pantry": { id: "zone-pantry", name: "Pantry", parent: null } };
const pantryDevices = {
  ...devices,
  "pantry-light": pantryLight("pantry-light", "Pantry Light"),
  "pantry-shelf-light": pantryLight("pantry-shelf-light", "Shelf Light"),
};

test('"pantry light 40" — a device whose own exact name IS a zone+word reading — merges both complete readings into a list of 2, not just the device alone', () => {
  const result = resolve("pantry light 40", { devices: pantryDevices, zones: pantryZones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions, undefined);
  assert.equal(result.matches.length, 2);
  const byLabel = [...result.matches].sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual(
    byLabel.map((m) => ({ label: m.label, why: m.why })),
    [
      { label: "Pantry", why: "40%" },
      { label: "Pantry Light", why: "40%" },
    ]
  );
});

test('"living room light 30" — Living Room\'s own numbered-light name tie — merges with the zone+word batch it also completes, instead of staying a bare ambiguous tie', () => {
  // Deliberately a different value than the pre-existing (known-failing)
  // "living room light off"/"living room light 40" tests above, so this
  // doesn't assert a second, incompatible outcome for byte-identical input
  // those already claim — same underlying tie ("Living Room Light 2/3/4"
  // token-aligned prefix-match "living room light" before the zone ever
  // gets a turn), just a value neither of those tests uses.
  const result = resolve("living room light 30", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions, undefined);
  assert.equal(result.matches.length, 4);
  const byLabel = [...result.matches].sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual(
    byLabel.map((m) => ({ label: m.label, why: m.why })),
    [
      { label: "Living Room", why: "30%" },
      { label: "Living Room Light 2", why: "30%" },
      { label: "Living Room Light 3", why: "30%" },
      { label: "Living Room Light 4", why: "30%" },
    ]
  );
});

// --- word: a zone-level verb, no capability word at all ---------------------

test('"hallway unlock" resolves via a zone-level verb alone — no capability word needed since the Hallway\'s only controllable device is the Front Door lock', () => {
  const result = resolve("hallway unlock", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    actions: [{ deviceId: "hallway-lock", capabilityId: "locked", value: false }],
    scopeLabel: "Hallway",
  });
});

// --- word: play/pause/next, no `word` needed for speaker_playing -----------

test('"living room speaker play" controls the speaker\'s speaker_playing capability directly — no capability word exists for it, "play" is the verb', () => {
  const result = resolve("living room speaker play", { devices, zones });
  assert.deepEqual(result, {
    matches: [],
    action: { deviceId: "living-speaker", capabilityId: "speaker_playing", value: true },
  });
});

// --- word: grp/ungrp -----------------------------------------------------
//
// Not written: design.md says grp/ungrp "run through Homey's flow-action-
// card mechanism, not a capability write," but resolve()'s return shape has
// no field for that outcome at all — only `action`/`actions` (a capability
// write) and `room`/`mood` (an activation), both established by an existing
// return field this task can extend by direct analogy. There's no such
// precedent for "trigger this flow action card," so asserting one here would
// mean inventing a field name (`result.flowAction`?) with no grounding in
// either the code or docs/design.md — noted as a blocker instead of forced.

// --- value: omitted → a ZONE's own single obvious capability ---------------

test('"pantry 40" resolves a bare value directly against a zone with exactly one controllable capability type, no word needed', () => {
  const result = resolve("pantry 40", { devices: pantryDevices, zones: pantryZones });
  assert.equal(result.action, undefined);
  assert.equal(result.matches.length, 0);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.every((a) => a.capabilityId === "dim" && a.value === 0.4));
  const ids = result.actions.map((a) => a.deviceId).sort();
  assert.deepEqual(ids, ["pantry-light", "pantry-shelf-light"]);
});

// --- outside the tree: `?` lists the words that apply to the current match -

// `result.words` below is this task's own proposal, not an established
// return-shape convention — design.md specifies `?`'s user-facing behavior
// ("lists the words that apply to the current match") but resolve() has no
// existing field for it to extend by analogy, unlike `room`/`mood` above.
test('"desk?" lists the words that apply to the Desk Lamp match', () => {
  const result = resolve("desk?", { devices, zones });
  assert.equal(result.action, undefined);
  assert.equal(result.actions, undefined);
  assert.deepEqual(result.words, { label: "Desk Lamp", list: ["light", "off", "on"] });
});

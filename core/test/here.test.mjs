import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "../here.mjs";
import { devices, zones, moods } from "./fixture.mjs";

test("compute(null, ...) returns null", () => {
  assert.equal(compute(null, { devices, zones, moods }), null);
});

test("compute(<unknown zone id>, ...) returns null — a stale context.machineRoom degrades gracefully", () => {
  assert.equal(compute("zone-does-not-exist", { devices, zones, moods }), null);
});

test("compute(Kitchen, ...) returns its 5 lights, excludes the remote, and has no moods", () => {
  const result = compute("zone-kitchen", { devices, zones, moods });
  assert.equal(result.id, "zone-kitchen");
  assert.equal(result.name, "Kitchen");
  assert.equal(result.moods.length, 0);
  assert.equal(result.devices.length, 5);
  assert.ok(result.devices.every((d) => d.label.startsWith("Kitchen Light")));
});

test("a device with both onoff (on) and dim renders why/line from dim, not onoff", () => {
  const result = compute("zone-living", { devices, zones, moods });
  const floorLamp = result.devices.find((d) => d.label === "Floor Lamp");
  assert.ok(floorLamp);
  assert.equal(floorLamp.why, "60%");
  assert.equal(floorLamp.line, "Floor Lamp 60");
});

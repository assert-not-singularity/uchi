import { test } from "node:test";
import assert from "node:assert/strict";
import * as log from "../log.mjs";
import { list } from "../recent.mjs";

test("a capability row renders why/line with dim percent-conversion, not raw 0-1", () => {
  const entries = [
    {
      id: 1,
      ts: 1000,
      kind: "capability",
      deviceId: "d1",
      deviceName: "Desk Lamp",
      capabilityId: "dim",
      from: 0.2,
      to: 0.4,
      cause: null,
    },
  ];

  const rows = list(entries, 20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Desk Lamp");
  assert.equal(rows[0].why, "→ dimmed to 40%");
  assert.equal(rows[0].line, "Desk Lamp 20");
  assert.equal(rows[0].in, false);
});

test('a cause: "prompt" row marks why with "(you)" and renders in: true', () => {
  const entries = [
    {
      id: 2,
      ts: 1000,
      kind: "capability",
      deviceId: "d1",
      deviceName: "Desk Lamp",
      capabilityId: "onoff",
      from: false,
      to: true,
      cause: "prompt",
    },
  ];

  const rows = list(entries, 20);
  assert.equal(rows[0].why, "→ on (you)");
  assert.equal(rows[0].in, true);
  assert.equal(rows[0].line, "Desk Lamp off");
});

test("a cause: null row has no (you) marker and renders in: false", () => {
  const entries = [
    {
      id: 3,
      ts: 1000,
      kind: "capability",
      deviceId: "d1",
      deviceName: "Desk Lamp",
      capabilityId: "onoff",
      from: true,
      to: false,
      cause: null,
    },
  ];

  const rows = list(entries, 20);
  assert.equal(rows[0].why, "→ off");
  assert.equal(rows[0].in, false);
});

test('a mood entry renders "mood" as why, no line, cause "prompt" marks in: true and "(you)"', () => {
  const entries = [{ id: 4, ts: 1000, kind: "mood", moodId: "mood-movie-night", moodName: "Movie Night", cause: "prompt" }];

  const rows = list(entries, 20);
  assert.equal(rows[0].label, "Movie Night");
  assert.equal(rows[0].why, "mood (you)");
  assert.equal(rows[0].in, true);
  assert.equal("line" in rows[0], false);
});

test("a mood entry with cause: null has no (you) marker and renders in: false", () => {
  const entries = [{ id: 5, ts: 1000, kind: "mood", moodId: "mood-morning", moodName: "Morning", cause: null }];

  const rows = list(entries, 20);
  assert.equal(rows[0].why, "mood");
  assert.equal(rows[0].in, false);
});

test("appendMood inserts a row log.append would reject (no from/to to compare)", () => {
  const inserted = log.appendMood({ moodId: "mood-bedtime", moodName: "Bedtime", cause: "prompt" });
  assert.equal(inserted, true);

  const matching = log.tail(500).filter((e) => e.moodId === "mood-bedtime");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].kind, "mood");
});

test("a notification entry renders label/why verbatim, no line, in: false", () => {
  const entries = [{ id: "notif-1", ts: 500, kind: "notification", ownerName: "Anwesenheit", excerpt: "Alex is home" }];

  const rows = list(entries, 20);
  assert.equal(rows[0].label, "Anwesenheit");
  assert.equal(rows[0].why, "Alex is home");
  assert.equal(rows[0].in, false);
  assert.equal("line" in rows[0], false);
});

test("appending the same notification id twice does not duplicate the row", () => {
  const entry = { id: "dedupe-1", ownerName: "Flow", excerpt: "ran", dateCreated: "2026-09-01T10:00:00.000Z" };
  log.appendNotification(entry);
  log.appendNotification(entry);

  const matching = log.tail(500).filter((e) => e.id === "dedupe-1");
  assert.equal(matching.length, 1);
});

test("seedNotificationIds marks an id seen without appending a row for it", () => {
  log.seedNotificationIds(["seeded-1"]);
  log.appendNotification({
    id: "seeded-1",
    ownerName: "Flow",
    excerpt: "pre-existing",
    dateCreated: "2026-09-01T09:00:00.000Z",
  });

  const matching = log.tail(500).filter((e) => e.id === "seeded-1");
  assert.equal(matching.length, 0);
});

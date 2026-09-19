import { HomeyAPI } from "homey-api";

export async function connect({ address, token }) {
  return HomeyAPI.createLocalAPI({ address, token, debug: false });
}

export async function getDevices(api) {
  return api.devices.getDevices();
}

export async function getUsers(api) {
  return api.users.getUsers();
}

export async function getZones(api) {
  return api.zones.getZones();
}

export async function getMoods(api) {
  return api.moods.getMoods();
}

export async function getNotifications(api) {
  return api.notifications.getNotifications();
}

// A Homey Group (created via Homey's own "Groups" app) shows up as an
// ordinary device with this driverId and its member device ids in
// settings.deviceIds — confirmed live, not documented anywhere in
// homey-api's own types.
export const GROUP_DRIVER_ID = "homey:virtualdrivergroup:driver";

// A more precise version of docs/design.md's "What counts as Recent" list.
export const DISCRETE_CAPABILITIES = new Set([
  "onoff",
  "dim",
  "locked",
  "target_temperature",
  "speaker_playing",
  "alarm_contact",
  "alarm_motion",
  "volume_set",
  "windowcoverings_state",
]);

// homey.mjs stays a thin, policy-free wrapper: onChange fires for every raw
// value, including an alarm_contact/alarm_motion transition to false —
// deciding which events become Recent rows is core/index.mjs's job, the one
// place that already needs to see every event to keep its own cache correct.
export function subscribeToDiscreteChanges(devices, onChange) {
  for (const device of Object.values(devices)) {
    for (const capabilityId of device.capabilities ?? []) {
      if (!DISCRETE_CAPABILITIES.has(capabilityId)) continue;
      device.makeCapabilityInstance(capabilityId, (value) => {
        onChange({ deviceId: device.id, capabilityId, value });
      });
    }
  }
}

// Thin pass-through over the legacy 2-arg write path — the percent↔normalized
// conversion happens in the caller (see toHomeyValue below), never here.
export async function setCapabilityValue(device, capabilityId, value) {
  return device.setCapabilityValue(capabilityId, value);
}

// The three capabilities grammar.mjs's bare-number step and here.mjs's
// device-row picker both treat as a device's "obvious" numeric target — the
// single source both modules import from, so adding a new numeric target
// here doesn't require also remembering to update a second, hand-synced
// copy.
export const NUMERIC_TARGETS = ["dim", "target_temperature", "volume_set"];

// units: "%" is a display hint, not the actual value range — verified live:
// every real dim/volume_set capability has min: 0, max: 1.
export const PERCENT_CAPABILITIES = new Set(["dim", "volume_set"]);

export function toHomeyValue(capabilityId, percent) {
  return PERCENT_CAPABILITIES.has(capabilityId) ? percent / 100 : percent;
}

// For why text a human reads ("dimmed to 40%") — whole percent is the right
// precision there.
export function toDisplayPercent(capabilityId, homeyValue) {
  if (!PERCENT_CAPABILITIES.has(capabilityId)) return homeyValue;
  return Math.round(homeyValue * 100);
}

// For a line meant to be re-executed as an undo — one decimal place, since
// rounding to a whole percent would make the undo land on a different value
// than the one it's supposed to restore.
export function toLinePercent(capabilityId, homeyValue) {
  if (!PERCENT_CAPABILITIES.has(capabilityId)) return homeyValue;
  return Math.round(homeyValue * 1000) / 10;
}

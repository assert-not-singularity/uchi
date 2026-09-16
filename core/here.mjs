import { formatCapabilityWhy, lineFor } from "./grammar.mjs";
import { NUMERIC_TARGETS } from "./homey.mjs";

const CONTROLLABLE = new Set(["onoff", "dim", "locked", "target_temperature", "volume_set", "speaker_playing"]);

function isSetable(device, capabilityId) {
  return Boolean(device.capabilitiesObj?.[capabilityId]?.setable);
}

// A device can have more than one of the six controllable capabilities at
// once (an ordinary light has both onoff and dim), so picking one needs
// several passes, not one flat priority order — see
// docs/phase-2-plan.md's here.mjs section for why each pass exists.
function pickCapability(device) {
  const caps = device.capabilitiesObj ?? {};

  // A light switched off but still holding a nonzero remembered dim level
  // is off, full stop — not "dimmed to 40%", and its line must turn it off,
  // not on.
  if (isSetable(device, "onoff") && caps.onoff.value === false) {
    return { capabilityId: "onoff", value: false };
  }

  const numericTargets = NUMERIC_TARGETS.filter((id) => isSetable(device, id));
  if (numericTargets.length === 1) {
    const capabilityId = numericTargets[0];
    return { capabilityId, value: caps[capabilityId].value };
  }

  if (isSetable(device, "onoff")) return { capabilityId: "onoff", value: caps.onoff.value };
  if (isSetable(device, "locked")) return { capabilityId: "locked", value: caps.locked.value };
  if (isSetable(device, "speaker_playing")) {
    return { capabilityId: "speaker_playing", value: caps.speaker_playing.value, noLine: true };
  }

  // The one remaining case the zone-level filter can still produce: two or
  // more ambiguous numeric targets, and nothing else controllable.
  const capabilityId = numericTargets[0];
  return { capabilityId, value: caps[capabilityId].value, noLine: true };
}

function renderDevice(device) {
  const pick = pickCapability(device);
  const why = pick.capabilityId === "speaker_playing"
    ? (pick.value ? "playing" : "stopped")
    : formatCapabilityWhy(pick.capabilityId, pick.value);
  const line = pick.noLine ? undefined : lineFor(device.name, pick.capabilityId, pick.value);

  return line
    ? { id: device.id, label: device.name, why, line }
    : { id: device.id, label: device.name, why };
}

// Here is flat — zones[zoneId].parent (the zone tree) is unused this phase.
export function compute(zoneId, { devices, zones, moods }) {
  if (zoneId === null || !zones[zoneId]) return null;

  const zone = zones[zoneId];

  const zoneMoods = Object.values(moods).filter((m) => m.zone === zoneId);

  const zoneDevices = Object.values(devices).filter((d) => {
    if (d.zone !== zoneId) return false;
    return [...CONTROLLABLE].some((id) => isSetable(d, id));
  });

  return {
    id: zone.id,
    name: zone.name,
    moods: zoneMoods.map((m) => ({ id: m.id, name: m.name })),
    devices: zoneDevices.map(renderDevice),
  };
}

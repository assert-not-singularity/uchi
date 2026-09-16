// The exact fictional house from docs/design.md's "Example prompts" section
// — every device named anywhere in that document is declared here, plus one
// deliberate duplicate-name pair ("Reading Lamp", in Living Room and Office)
// so grammar.mjs's ambiguous-exact-match path is exercised too, distinct
// from testing that an ordinary name actually resolves.

function cap(value, { type = "boolean", getable = true, setable = false, units, min, max, title = "" } = {}) {
  return {
    value,
    type,
    getable,
    setable,
    title,
    titleShort: title,
    lastUpdated: "2026-09-01T12:00:00.000Z",
    units,
    min,
    max,
  };
}

function onoffCap(value, setable = true) {
  return cap(value, { type: "boolean", getable: true, setable });
}

function dimCap(value) {
  return cap(value, { type: "number", getable: true, setable: true, units: "%", min: 0, max: 1 });
}

function light(id, name, zone, { onoff = true, dim = 0.6 } = {}) {
  return {
    id,
    name,
    zone,
    class: "light",
    capabilities: ["onoff", "dim"],
    capabilitiesObj: { onoff: onoffCap(onoff), dim: dimCap(dim) },
  };
}

function remote(id, name, zone) {
  return {
    id,
    name,
    zone,
    class: "button",
    capabilities: ["button.gpio0"],
    capabilitiesObj: {
      "button.gpio0": cap(null, { type: "boolean", getable: true, setable: false }),
    },
  };
}

export const zones = {
  "zone-kitchen": {
    id: "zone-kitchen",
    name: "Kitchen",
    parent: null,
    icon: "kitchen",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 0,
    uri: "homey:manager:zones",
  },
  "zone-living": {
    id: "zone-living",
    name: "Living Room",
    parent: null,
    icon: "living-room",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 1,
    uri: "homey:manager:zones",
  },
  "zone-office": {
    id: "zone-office",
    name: "Office",
    parent: null,
    icon: "office",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 2,
    uri: "homey:manager:zones",
  },
  "zone-bedroom": {
    id: "zone-bedroom",
    name: "Bedroom",
    parent: null,
    icon: "bedroom",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 3,
    uri: "homey:manager:zones",
  },
  "zone-hallway": {
    id: "zone-hallway",
    name: "Hallway",
    parent: null,
    icon: "hallway",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 4,
    uri: "homey:manager:zones",
  },
  "zone-bathroom": {
    id: "zone-bathroom",
    name: "Bathroom",
    parent: null,
    icon: "bathroom",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 5,
    uri: "homey:manager:zones",
  },
  // A zone/device/device name collision, for grammar.mjs's exact-over-
  // partial-prefix tie-breaking test: a zone and a device both named
  // exactly "Attic", plus a differently-named device ("Attic Switch")
  // whose leading token also happens to be "Attic".
  "zone-attic": {
    id: "zone-attic",
    name: "Attic",
    parent: null,
    icon: "attic",
    active: false,
    activeLastUpdated: null,
    activeOrigins: [],
    sortIndex: 6,
    uri: "homey:manager:zones",
  },
};

export const devices = {
  "kitchen-light-1": light("kitchen-light-1", "Kitchen Light 1", "zone-kitchen"),
  "kitchen-light-2": light("kitchen-light-2", "Kitchen Light 2", "zone-kitchen"),
  "kitchen-light-3": light("kitchen-light-3", "Kitchen Light 3", "zone-kitchen"),
  "kitchen-light-4": light("kitchen-light-4", "Kitchen Light 4", "zone-kitchen"),
  "kitchen-light-5": light("kitchen-light-5", "Kitchen Light 5", "zone-kitchen"),
  "kitchen-switch": remote("kitchen-switch", "Kitchen Switch", "zone-kitchen"),

  "living-floor-lamp": light("living-floor-lamp", "Floor Lamp", "zone-living"),
  "living-light-2": light("living-light-2", "Living Room Light 2", "zone-living"),
  "living-light-3": light("living-light-3", "Living Room Light 3", "zone-living"),
  "living-light-4": light("living-light-4", "Living Room Light 4", "zone-living"),
  "living-tv": {
    id: "living-tv",
    name: "Living Room TV",
    zone: "zone-living",
    class: "tv",
    capabilities: ["onoff"],
    capabilitiesObj: { onoff: onoffCap(false) },
  },
  "living-speaker": {
    id: "living-speaker",
    name: "Living Room Speaker",
    zone: "zone-living",
    class: "speaker",
    capabilities: ["speaker_playing", "volume_set", "volume_mute"],
    capabilitiesObj: {
      speaker_playing: cap(false, { type: "boolean", getable: true, setable: true }),
      volume_set: dimCap(0.3),
      volume_mute: cap(false, { type: "boolean", getable: true, setable: true }),
    },
  },
  "living-thermostat": {
    id: "living-thermostat",
    name: "Living Room Thermostat",
    zone: "zone-living",
    class: "thermostat",
    capabilities: ["target_temperature", "measure_temperature"],
    capabilitiesObj: {
      target_temperature: cap(20, { type: "number", getable: true, setable: true, units: "°C", min: 4, max: 35 }),
      measure_temperature: cap(19.5, { type: "number", getable: true, setable: false, units: "°C" }),
    },
  },
  "living-switch": remote("living-switch", "Sofa Switch", "zone-living"),
  "living-reading-lamp": light("living-reading-lamp", "Reading Lamp", "zone-living"),

  "office-desk-lamp": light("office-desk-lamp", "Desk Lamp", "zone-office"),
  "office-speaker": {
    id: "office-speaker",
    name: "Office Speaker",
    zone: "zone-office",
    class: "speaker",
    capabilities: ["speaker_playing", "volume_set"],
    capabilitiesObj: {
      speaker_playing: cap(false, { type: "boolean", getable: true, setable: true }),
      volume_set: dimCap(0.5),
    },
  },
  "office-desktop": {
    id: "office-desktop",
    name: "Desktop Machine",
    zone: "zone-office",
    class: "socket",
    capabilities: ["onoff", "measure_power"],
    capabilitiesObj: {
      onoff: onoffCap(true),
      measure_power: cap(110, { type: "number", getable: true, setable: false, units: "W" }),
    },
  },
  "office-heater": {
    id: "office-heater",
    name: "Space Heater",
    zone: "zone-office",
    class: "socket",
    capabilities: ["onoff", "measure_power"],
    capabilitiesObj: {
      onoff: onoffCap(false),
      measure_power: cap(0, { type: "number", getable: true, setable: false, units: "W" }),
    },
  },
  "office-dnd": {
    id: "office-dnd",
    name: "Do Not Disturb Switch",
    zone: "zone-office",
    class: "other",
    capabilities: ["onoff"],
    capabilitiesObj: { onoff: onoffCap(false) },
  },
  "office-reading-lamp": light("office-reading-lamp", "Reading Lamp", "zone-office"),

  "bedroom-lamp": light("bedroom-lamp", "Bedside Lamp", "zone-bedroom"),
  "bedroom-window": {
    id: "bedroom-window",
    name: "Bedroom Window",
    zone: "zone-bedroom",
    class: "sensor",
    capabilities: ["alarm_contact"],
    capabilitiesObj: { alarm_contact: cap(false, { type: "boolean", getable: true, setable: false }) },
  },
  "bedroom-thermostat": {
    id: "bedroom-thermostat",
    name: "Bedroom Thermostat",
    zone: "zone-bedroom",
    class: "thermostat",
    capabilities: ["target_temperature", "measure_temperature"],
    capabilitiesObj: {
      target_temperature: cap(19, { type: "number", getable: true, setable: true, units: "°C", min: 4, max: 35 }),
      measure_temperature: cap(18.7, { type: "number", getable: true, setable: false, units: "°C" }),
    },
  },

  "hallway-motion": {
    id: "hallway-motion",
    name: "Hallway Motion Sensor",
    zone: "zone-hallway",
    class: "sensor",
    capabilities: ["alarm_motion"],
    capabilitiesObj: { alarm_motion: cap(false, { type: "boolean", getable: true, setable: false }) },
  },
  "hallway-lock": {
    id: "hallway-lock",
    name: "Front Door",
    zone: "zone-hallway",
    class: "lock",
    capabilities: ["locked"],
    capabilitiesObj: { locked: cap(true, { type: "boolean", getable: true, setable: true }) },
  },

  "attic-speaker": {
    id: "attic-speaker",
    name: "Attic",
    zone: "zone-attic",
    class: "speaker",
    capabilities: ["speaker_playing", "volume_set"],
    capabilitiesObj: {
      speaker_playing: cap(false, { type: "boolean", getable: true, setable: true }),
      volume_set: dimCap(0.2),
    },
  },
  "attic-switch": remote("attic-switch", "Attic Switch", "zone-attic"),

  // A single-token (compound) name with no word boundary for token-aligned
  // fuzzy matching to align against — grammar.mjs's substring-fallback
  // test.
  "office-deskbacklight": light("office-deskbacklight", "Deskbacklight", "zone-office"),
};

export const moods = {
  "mood-movie-night": {
    id: "mood-movie-night",
    name: "Movie Night",
    preset: null,
    devices: ["living-tv", "living-floor-lamp", "living-light-2", "living-speaker"],
    zone: "zone-living",
    uri: "homey:manager:moods",
  },
  "mood-morning": {
    id: "mood-morning",
    name: "Morning",
    preset: null,
    devices: ["bedroom-lamp"],
    zone: "zone-bedroom",
    uri: "homey:manager:moods",
  },
  "mood-bedtime": {
    id: "mood-bedtime",
    name: "Bedtime",
    preset: null,
    devices: ["living-tv", "living-speaker", "bedroom-lamp"],
    zone: "zone-bedroom",
    uri: "homey:manager:moods",
  },
};

export const notifications = [
  {
    id: "notif-1",
    ownerUri: "homey:manager:presence",
    ownerName: "Anwesenheit",
    excerpt: "Alex is home",
    dateCreated: "2026-09-01T18:00:00.000Z",
    meta: {},
  },
  {
    id: "notif-2",
    ownerUri: "homey:manager:flow",
    ownerName: "Flow",
    excerpt: "Bedtime Routine ran",
    dateCreated: "2026-09-01T22:30:00.000Z",
    meta: {},
  },
];

export const users = {
  "user-alex": { id: "user-alex", name: "Alex", present: true, asleep: false },
  "user-sam": { id: "user-sam", name: "Sam", present: false, asleep: false },
};

import path from "node:path";
import { readSettings, ConfigError, readCoreConfig } from "./config.mjs";
import {
  connect,
  getDevices,
  getZones,
  getMoods,
  getUsers,
  getNotifications,
  subscribeToDiscreteChanges,
  setCapabilityValue,
  DISCRETE_CAPABILITIES,
  GROUP_DRIVER_ID,
  NUMERIC_TARGETS,
} from "./homey.mjs";
import { createRpcServer } from "./rpc.mjs";
import * as log from "./log.mjs";
import * as recent from "./recent.mjs";
import * as here from "./here.mjs";
import { resolve, run, previewRowForAction } from "./grammar.mjs";

const IDLE_EXIT_MS = 60_000;
const NOTIFICATION_POLL_MS = 30_000;
const NOTIFICATION_RETRY_MS = 5_000;
const SELF_WRITE_ECHO_TIMEOUT_MS = 5_000;
// A flow/mood setting both onoff and a numeric target (dim, say) on one
// device issues them as two separate capability writes — neither is our own
// write, so pendingSelfWrites never sees either. This window is how close
// together they have to arrive to fold into the numeric-target row alone;
// not independently confirmed against a live flow's actual timing, just
// wide enough to cover the two-events-in-quick-succession pattern observed.
const ONOFF_FOLD_WINDOW_MS = 500;
// A smooth-transition ramp (a scene fading a light over a few seconds, say)
// sends several intermediate numeric-target values, each its own external
// change — reset on every new value, so only the level it settles on after
// this long a quiet gap becomes a Recent row. Matches
// SELF_WRITE_ECHO_TIMEOUT_MS's existing 5s; Recent isn't the primary
// feedback loop (the device itself changes in real time), so the row
// appearing a few seconds late costs nothing real.
const DIM_TRANSITION_DEBOUNCE_MS = 5_000;

function socketPathFromEnv() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) {
    console.error("uchi core: XDG_RUNTIME_DIR is not set");
    process.exit(1);
  }
  return path.join(runtimeDir, "uchi.sock");
}

function keyFor(deviceId, capabilityId) {
  return `${deviceId}:${capabilityId}`;
}

async function main() {
  // Notification polling (below) needs this value once it starts — captured
  // as the literal first statement, not just before the polling loop, so
  // "before core initialization" means the actual process start.
  const startupCutoff = Date.now();

  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exit(78); // sysexits.h EX_CONFIG — Service.qml retries slowly, forever
  }

  const coreConfig = readCoreConfig();

  let api;
  let devices;
  let zones = {};
  let moods = {};
  let users = {};

  try {
    api = await connect(settings);
    devices = await getDevices(api);
  } catch (err) {
    console.error(`could not connect to Homey at ${settings.address}: ${err && err.message ? err.message : err}`);
    process.exit(69); // sysexits.h EX_UNAVAILABLE — Service.qml retries slowly, forever
  }

  // None of these three is needed for `uchi desk 40` itself — a transient
  // failure fetching moods, say, has no business taking down device writes.
  // A {} default degrades gracefully; the very next state.get re-fetches all
  // three fresh anyway. Independent calls, fetched concurrently — same
  // pattern state.get's own refresh already uses below.
  [zones, moods, users] = await Promise.all([
    getZones(api).catch((err) => {
      console.error(`could not fetch zones: ${err && err.message ? err.message : err}`);
      return {};
    }),
    getMoods(api).catch((err) => {
      console.error(`could not fetch moods: ${err && err.message ? err.message : err}`);
      return {};
    }),
    getUsers(api).catch((err) => {
      console.error(`could not fetch users: ${err && err.message ? err.message : err}`);
      return {};
    }),
  ]);

  console.log(`Connected to Homey — ${Object.keys(devices).length} devices`);

  // Seeded from the startup devices fetch; resynced only by state.get (see
  // below) — the only path that ever refetches real capability values.
  const currentValue = new Map();
  // A small, purpose-built map for onChange's own callback, which is only
  // ever given {deviceId, capabilityId, value} — never a device object of
  // its own — to recover a name for a device the live, state.get-refreshed
  // devices map no longer has.
  const startupDeviceNames = new Map();

  function seedCurrentValues(deviceMap) {
    for (const device of Object.values(deviceMap)) {
      for (const capabilityId of device.capabilities ?? []) {
        if (!DISCRETE_CAPABILITIES.has(capabilityId)) continue;
        const capObj = device.capabilitiesObj?.[capabilityId];
        if (capObj) currentValue.set(keyFor(device.id, capabilityId), capObj.value);
      }
    }
  }

  seedCurrentValues(devices);
  for (const device of Object.values(devices)) startupDeviceNames.set(device.id, device.name);

  // One queue (array) per key, not a single overwritable entry — write()
  // (below) can start a second write to the same capability before the
  // first's two realtime echoes have both arrived.
  const pendingSelfWrites = new Map();

  // The one place that removes a record from pendingSelfWrites: finds it by
  // object reference (never by value — a second same-key write can push a
  // record with an identical value), splices it out, and drops the key
  // entirely once its queue is empty. Every caller below reaches for this
  // instead of repeating the same find/splice/cleanup by hand.
  function evictRecord(key, record) {
    const queue = pendingSelfWrites.get(key);
    if (!queue) return;
    const index = queue.indexOf(record);
    if (index === -1) return;
    queue.splice(index, 1);
    if (queue.length === 0) pendingSelfWrites.delete(key);
  }

  function consumeSelfWriteEcho(key, value) {
    const queue = pendingSelfWrites.get(key);
    if (!queue) return false;

    const record = queue.find((r) => r.value === value);
    if (!record) return false;

    record.remaining -= 1;
    if (record.remaining <= 0) {
      clearTimeout(record.timer);
      evictRecord(key, record);
    }
    return true;
  }

  // A device that's a member of a Homey group has its own capability
  // changes suppressed from Recent below — the group's own change already
  // represents the action a person took; a separate row per member is
  // noise. Scans `devices` fresh each call rather than caching a
  // member→group map: group membership changes rarely and onChange doesn't
  // fire often enough for an O(devices) scan to matter.
  function groupIdForMember(deviceId) {
    for (const candidate of Object.values(devices)) {
      if (candidate.driverId === GROUP_DRIVER_ID && candidate.settings?.deviceIds?.includes(deviceId)) {
        return candidate.id;
      }
    }
    return null;
  }

  function deviceHasNumericTarget(deviceId) {
    const capsObj = devices[deviceId]?.capabilitiesObj ?? {};
    return NUMERIC_TARGETS.some((id) => capsObj[id] !== undefined);
  }

  // deviceId -> { onoffChange, numericChange, timer }, for any device with
  // a numeric target capability at all — a plain onoff-only device (a
  // socket, a lock) can never produce either pattern this folds and logs
  // immediately instead. Two things settle here before becoming a Recent
  // row: onoff and a numeric target (dim, say) arriving as two separate
  // external changes for one action (resolved within the short
  // ONOFF_FOLD_WINDOW_MS — the light turning on/off is what happened; the
  // specific level it landed on is incidental, so onoff always wins over a
  // coincident numeric change), and a smooth-transition ramp sending many
  // intermediate numeric-target values in quick succession, which debounces
  // over the longer DIM_TRANSITION_DEBOUNCE_MS instead — reset on every new
  // value — so only the final settled level logs, not each step.
  const pendingDeviceChange = new Map();

  function logCapabilityChange({ deviceId, capabilityId, from, to }) {
    const deviceName = devices[deviceId]?.name ?? startupDeviceNames.get(deviceId);
    const zoneName = zones[devices[deviceId]?.zone]?.name;
    const deviceClass = devices[deviceId]?.class;
    if (log.append({ deviceId, deviceName, zoneName, deviceClass, capabilityId, from, to, cause: null })) notifyChanged();
  }

  function scheduleDeviceChangeDecision(deviceId, delayMs) {
    const pending = pendingDeviceChange.get(deviceId);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pendingDeviceChange.delete(deviceId);
      const change = pending.onoffChange ?? pending.numericChange;
      logCapabilityChange({ deviceId, capabilityId: change.capabilityId, from: change.from, to: change.to });
    }, delayMs);
  }

  function onChange({ deviceId, capabilityId, value }) {
    const key = keyFor(deviceId, capabilityId);
    const from = currentValue.get(key);

    // An echo of our own write: write() already set the cache synchronously
    // the moment its own setCapabilityValue call succeeded — nothing left
    // for the echo to update.
    if (consumeSelfWriteEcho(key, value)) return;

    // Externally caused: update the cache before the logging filter, not
    // after, so a later alarm_contact/alarm_motion "going true" comparison
    // stays correct even though the going-false case never becomes its own
    // Recent row.
    currentValue.set(key, value);

    if ((capabilityId === "alarm_contact" || capabilityId === "alarm_motion") && value !== true) return;

    if (groupIdForMember(deviceId)) return;

    const isFoldable = capabilityId === "onoff" || NUMERIC_TARGETS.includes(capabilityId);
    if (isFoldable && deviceHasNumericTarget(deviceId)) {
      const pending = pendingDeviceChange.get(deviceId) ?? { onoffChange: null, numericChange: null, timer: null };
      pendingDeviceChange.set(deviceId, pending);
      if (capabilityId === "onoff") {
        // A second onoff transition arriving before the first was decided
        // is an independent toggle, not a pair to fold with a numeric
        // change — flush the first now rather than losing it to this
        // overwrite (this device could otherwise be flipped on/off/on in
        // quick succession and only the last transition would ever log).
        if (pending.onoffChange) logCapabilityChange({ deviceId, ...pending.onoffChange });
        pending.onoffChange = { capabilityId, from, to: value };
      } else {
        // Preserves the ramp's true starting value, not just its
        // second-to-last step — a Recent row's undo `line` targets `from`,
        // and only the debounce's final event ever becomes a row.
        const startFrom = pending.numericChange && pending.numericChange.capabilityId === capabilityId
          ? pending.numericChange.from
          : from;
        pending.numericChange = { capabilityId, from: startFrom, to: value };
      }
      scheduleDeviceChangeDecision(deviceId, pending.onoffChange ? ONOFF_FOLD_WINDOW_MS : DIM_TRANSITION_DEBOUNCE_MS);
      return;
    }

    logCapabilityChange({ deviceId, capabilityId, from, to: value });
  }

  subscribeToDiscreteChanges(devices, onChange);

  // One promise chain per key so two quick writes to the same capability
  // can't interleave or both capture the same stale `from`.
  const writeTails = new Map();

  async function performWrite(device, capabilityId, homeyValue, key) {
    if (!currentValue.has(key)) {
      currentValue.set(key, device.capabilitiesObj?.[capabilityId]?.value);
    }
    const from = currentValue.get(key);

    const record = { value: homeyValue, remaining: 2, timer: null };
    record.timer = setTimeout(() => evictRecord(key, record), SELF_WRITE_ECHO_TIMEOUT_MS);

    if (!pendingSelfWrites.has(key)) pendingSelfWrites.set(key, []);
    pendingSelfWrites.get(key).push(record);

    // A numeric-target write above 0 can cascade an implicit onoff: true on
    // the same device — pre-register that expected echo too, or it reads as
    // an externally caused "on" and logs its own Recent row alongside the
    // dim/volume/temperature row that already covers the same user action.
    // Only when the device is actually off first: an already-on device's
    // dim write triggers no cascade, and registering an echo nobody sends
    // would sit in pendingSelfWrites for the full timeout, ready to
    // misattribute an unrelated later onoff:true as this write's echo.
    let onoffKey = null;
    let onoffRecord = null;
    if (NUMERIC_TARGETS.includes(capabilityId) && homeyValue > 0 && device.capabilitiesObj?.onoff?.setable) {
      const onoffCacheKey = keyFor(device.id, "onoff");
      const onoffCurrentValue = currentValue.has(onoffCacheKey)
        ? currentValue.get(onoffCacheKey)
        : device.capabilitiesObj?.onoff?.value;
      if (onoffCurrentValue !== true) {
        onoffKey = onoffCacheKey;
        onoffRecord = { value: true, remaining: 2, timer: null };
        onoffRecord.timer = setTimeout(() => evictRecord(onoffKey, onoffRecord), SELF_WRITE_ECHO_TIMEOUT_MS);
        if (!pendingSelfWrites.has(onoffKey)) pendingSelfWrites.set(onoffKey, []);
        pendingSelfWrites.get(onoffKey).push(onoffRecord);
      }
    }

    try {
      await setCapabilityValue(device, capabilityId, homeyValue);
    } catch (err) {
      clearTimeout(record.timer);
      evictRecord(key, record);
      if (onoffRecord) {
        clearTimeout(onoffRecord.timer);
        evictRecord(onoffKey, onoffRecord);
      }
      throw err;
    }

    currentValue.set(key, homeyValue);
    return {
      deviceId: device.id,
      deviceName: device.name,
      zoneName: zones[device.zone]?.name,
      deviceClass: device.class,
      capabilityId,
      from,
      to: homeyValue,
    };
  }

  async function write(device, capabilityId, homeyValue) {
    const key = keyFor(device.id, capabilityId);
    const previousTail = writeTails.get(key) ?? Promise.resolve();
    const chained = previousTail.catch(() => {}).then(() => performWrite(device, capabilityId, homeyValue, key));
    writeTails.set(key, chained);
    return chained;
  }

  const context = { machineRoom: null, idle: null, mic: null, media: null };

  // Separate from context.machineRoom: an explicit room.pin overrides it until
  // room.unpin or the next room.pin, per design.md's Here section. Set only
  // through room.pin below, never inferred.
  let pinnedRoom = null;

  // Set once rpc.listen() is reached (below); a capability change observed
  // in the brief window before that can't have a client connected yet to
  // push to anyway, so the `rpc` check here is just a null guard, not a
  // real race condition.
  let rpc = null;
  function notifyChanged() {
    if (rpc) rpc.broadcast({ sections: ["recent", "hero", "here"] });
  }

  // Two counters, not one: startedGeneration marks every call that begins;
  // publishedGeneration tracks the highest generation that actually
  // published, so a failed newer call can never permanently block an older
  // one's good data.
  let startedGeneration = 0;
  let publishedGeneration = 0;

  function heroSummary(devicesArg, usersArg) {
    const present = Object.values(usersArg).filter((u) => u.present).map((u) => u.name);

    let activeCount = 0;
    let totalDraw = 0;
    for (const device of Object.values(devicesArg)) {
      const caps = device.capabilitiesObj ?? {};
      if (caps.onoff) {
        if (caps.onoff.value === true) activeCount += 1;
      } else if (caps.dim && caps.dim.value > 0) {
        activeCount += 1;
      }
      if (caps.measure_power) totalDraw += caps.measure_power.value ?? 0;
    }

    const presenceText = present.length > 0 ? `${present.join(", ")} home` : "nobody home";
    return `${presenceText} · ${activeCount} devices on · ${Math.round(totalDraw)}W`;
  }

  const methods = {
    hello: async () => ({
      protocol: 1,
      homey: { address: settings.address },
      connected: true,
    }),

    "state.get": async () => {
      const generation = ++startedGeneration;
      const [freshDevices, freshZones, freshMoods, freshUsers] = await Promise.all([
        getDevices(api),
        getZones(api).catch(() => zones),
        getMoods(api).catch(() => moods),
        getUsers(api).catch(() => users),
      ]);

      if (generation > publishedGeneration) {
        devices = freshDevices;
        zones = freshZones;
        moods = freshMoods;
        users = freshUsers;
        publishedGeneration = generation;
        seedCurrentValues(freshDevices);
      }

      // Built from this call's own fetch, not the shared devices/zones/moods
      // variables — a superseded (losing) call still owes its own caller its
      // own fresh snapshot; only the shared state other handlers read from
      // is what a losing call must not overwrite.
      //
      // Hero's room is always machineRoom — never the pin. Here follows the
      // pin when one is active, falling back to the same computation as
      // Hero's room otherwise (the two coincide exactly when nothing is
      // pinned, per design.md's Here section — but pinning a different room
      // must split them, which computing both from one shared call can't do).
      const heroRoomValue = here.compute(context.machineRoom, {
        devices: freshDevices,
        zones: freshZones,
        moods: freshMoods,
      });
      const hereValue = pinnedRoom
        ? here.compute(pinnedRoom, { devices: freshDevices, zones: freshZones, moods: freshMoods })
        : heroRoomValue;

      return {
        hero: { room: heroRoomValue, summary: heroSummary(freshDevices, freshUsers) },
        recent: recent.list(log.tail(500), coreConfig.recentRows),
        attention: [],
        here: hereValue,
        habits: [],
      };
    },

    "context.set": async (params) => {
      Object.assign(context, params);
      return {};
    },

    "room.pin": async (params) => {
      const zone = params.zone;
      if (typeof zone !== "string" || !zones[zone]) {
        throw new Error(`room.pin: unknown zone "${zone}"`);
      }
      if (pinnedRoom !== zone) {
        pinnedRoom = zone;
        notifyChanged();
      }
      return {};
    },

    "room.unpin": async () => {
      if (pinnedRoom !== null) {
        pinnedRoom = null;
        notifyChanged();
      }
      return {};
    },

    "prompt.resolve": async (params) => {
      const result = resolve(params.text ?? "", { devices, zones, notches: coreConfig.notches });

      if (result.room) return { matches: [], room: result.room };

      if (result.action) {
        return { matches: [previewRowForAction(result.action, devices, zones, params.text)] };
      }

      if (result.actions) {
        return { matches: result.actions.map((a) => previewRowForAction(a, devices, zones, params.text)) };
      }

      return result.rest ? { matches: result.matches, rest: result.rest } : { matches: result.matches };
    },

    "prompt.run": async (params) => {
      const result = await run(params.line ?? "", { devices, zones, setCapabilityValue: write, notches: coreConfig.notches });
      if (result.ok) {
        const changes = result.changes ?? [result.change];
        let changed = false;
        for (const change of changes) {
          if (log.append({ ...change, cause: "prompt" })) changed = true;
        }
        if (changed) notifyChanged();
        return result.failed ? { ok: true, failed: result.failed } : { ok: true };
      }
      return result;
    },
  };

  rpc = createRpcServer({ methods });

  // Stopped entirely while any client is connected, not merely reset per
  // connect — a fresh 60s countdown starts only at a genuine transition to
  // zero clients (including the very first instant, with none yet).
  let clientCount = 0;
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function startIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  }

  rpc.on("connect", () => {
    clientCount += 1;
    clearIdleTimer();
  });

  rpc.on("disconnect", () => {
    clientCount = Math.max(0, clientCount - 1);
    if (clientCount === 0) startIdleTimer();
  });

  // Notifications are optional, best-effort Recent content — this must not
  // delay rpc.listen()/state.get/prompt.run becoming available.
  let notificationsSeeded = false;

  function pollNotifications() {
    getNotifications(api)
      .then((entries) => {
        let anyNew = false;
        if (!notificationsSeeded) {
          const seedIds = [];
          for (const entry of entries) {
            const entryTime = Date.parse(entry.dateCreated);
            if (entryTime <= startupCutoff) {
              seedIds.push(entry.id);
            } else {
              if (log.appendNotification(entry)) anyNew = true;
            }
          }
          log.seedNotificationIds(seedIds);
          notificationsSeeded = true;
        } else {
          for (const entry of entries) {
            if (log.appendNotification(entry)) anyNew = true;
          }
        }
        if (anyNew) notifyChanged();
        setTimeout(pollNotifications, NOTIFICATION_POLL_MS);
      })
      .catch((err) => {
        console.error(`notification poll failed: ${err && err.message ? err.message : err}`);
        setTimeout(pollNotifications, notificationsSeeded ? NOTIFICATION_POLL_MS : NOTIFICATION_RETRY_MS);
      });
  }

  pollNotifications();

  await rpc.listen(socketPathFromEnv());
  startIdleTimer();
}

main();

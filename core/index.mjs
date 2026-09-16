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
} from "./homey.mjs";
import { createRpcServer } from "./rpc.mjs";
import * as log from "./log.mjs";
import * as recent from "./recent.mjs";
import * as here from "./here.mjs";
import { resolve, run, formatCapabilityWhy } from "./grammar.mjs";

const IDLE_EXIT_MS = 60_000;
const NOTIFICATION_POLL_MS = 30_000;
const NOTIFICATION_RETRY_MS = 5_000;
const SELF_WRITE_ECHO_TIMEOUT_MS = 5_000;

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

    const deviceName = devices[deviceId]?.name ?? startupDeviceNames.get(deviceId);
    log.append({ deviceId, deviceName, capabilityId, from, to: value, cause: null });
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

    try {
      await setCapabilityValue(device, capabilityId, homeyValue);
    } catch (err) {
      clearTimeout(record.timer);
      evictRecord(key, record);
      throw err;
    }

    currentValue.set(key, homeyValue);
    return { deviceId: device.id, deviceName: device.name, capabilityId, from, to: homeyValue };
  }

  async function write(device, capabilityId, homeyValue) {
    const key = keyFor(device.id, capabilityId);
    const previousTail = writeTails.get(key) ?? Promise.resolve();
    const chained = previousTail.catch(() => {}).then(() => performWrite(device, capabilityId, homeyValue, key));
    writeTails.set(key, chained);
    return chained;
  }

  const context = { machineRoom: null, idle: null, mic: null, media: null };

  // Two counters, not one: startedGeneration marks every call that begins;
  // publishedGeneration tracks the highest generation that actually
  // published, so a failed newer call can never permanently block an older
  // one's good data — see docs/phase-2-plan.md's rpc.mjs section.
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
      const hereValue = here.compute(context.machineRoom, {
        devices: freshDevices,
        zones: freshZones,
        moods: freshMoods,
      });

      return {
        hero: { room: hereValue, summary: heroSummary(freshDevices, freshUsers) },
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

    "prompt.resolve": async (params) => {
      const result = resolve(params.text ?? "", { devices, zones });

      if (result.room) return { matches: [], room: result.room };

      if (result.action) {
        const label = devices[result.action.deviceId]?.name;
        const why = formatCapabilityWhy(result.action.capabilityId, result.action.value);
        return { matches: [{ label, line: params.text, why }] };
      }

      return { matches: result.matches };
    },

    "prompt.run": async (params) => {
      const result = await run(params.line ?? "", { devices, zones, setCapabilityValue: write });
      if (result.ok) {
        log.append({ ...result.change, cause: "prompt" });
        return { ok: true };
      }
      return result;
    },
  };

  const rpc = createRpcServer({ methods });

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
        if (!notificationsSeeded) {
          const seedIds = [];
          for (const entry of entries) {
            const entryTime = Date.parse(entry.dateCreated);
            if (entryTime <= startupCutoff) {
              seedIds.push(entry.id);
            } else {
              log.appendNotification(entry);
            }
          }
          log.seedNotificationIds(seedIds);
          notificationsSeeded = true;
        } else {
          for (const entry of entries) log.appendNotification(entry);
        }
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

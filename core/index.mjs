import path from "node:path";
import { readSettings, ConfigError } from "./config.mjs";
import { connect, getDeviceCount } from "./homey.mjs";
import { createRpcServer } from "./rpc.mjs";

const IDLE_EXIT_MS = 60_000;

function socketPathFromEnv() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) {
    console.error("uchi core: XDG_RUNTIME_DIR is not set");
    process.exit(1);
  }
  return path.join(runtimeDir, "uchi.sock");
}

async function main() {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exit(78); // sysexits.h EX_CONFIG — Service.qml retries slowly, forever
  }

  let deviceCount;
  try {
    const api = await connect(settings);
    deviceCount = await getDeviceCount(api);
  } catch (err) {
    console.error(`could not connect to Homey at ${settings.address}: ${err && err.message ? err.message : err}`);
    process.exit(69); // sysexits.h EX_UNAVAILABLE — Service.qml retries slowly, forever
  }

  console.log(`Connected to Homey — ${deviceCount} devices`);

  const methods = {
    hello: async () => ({
      protocol: 1,
      homey: { address: settings.address },
      connected: true,
    }),
    "state.get": async () => ({
      hero: null,
      recent: [],
      attention: [],
      here: null,
      habits: [],
    }),
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

  await rpc.listen(socketPathFromEnv());
  startIdleTimer();
}

main();

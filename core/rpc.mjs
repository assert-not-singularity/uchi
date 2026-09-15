import net from "node:net";
import readline from "node:readline";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// The socket server + JSON-RPC dispatch/framing, factored out of index.mjs so
// it's unit-testable with a plain {method: handler} dispatch table and no real
// Homey connection. No single-instance logic lives here: `flock(1)` (see
// Service.qml) already guarantees exactly one core process is ever running
// before this code executes, so listen() unconditionally unlinks any
// pre-existing socket file and binds — see docs/phase-1-plan.md for why a
// PID-file-based guard was rejected instead.
export function createRpcServer({ methods }) {
  const emitter = new EventEmitter();

  const server = net.createServer((socket) => {
    emitter.emit("connect");

    const rl = readline.createInterface({ input: socket });

    rl.on("line", async (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }

      const { id, method, params } = request ?? {};
      const handler = typeof method === "string" && Object.hasOwn(methods, method)
        ? methods[method]
        : undefined;

      if (typeof handler !== "function") {
        if (id !== undefined) writeLine(socket, { id, error: { message: `unknown method: ${method}` } });
        return;
      }

      try {
        const result = await handler(params ?? {});
        if (id !== undefined) writeLine(socket, { id, result });
      } catch (err) {
        if (id !== undefined) {
          writeLine(socket, { id, error: { message: err && err.message ? err.message : String(err) } });
        }
      }
    });

    rl.on("close", () => emitter.emit("disconnect"));
    socket.on("error", () => {});
  });

  function writeLine(socket, obj) {
    socket.write(JSON.stringify(obj) + "\n");
  }

  function listen(socketPath) {
    fs.rmSync(socketPath, { force: true });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  }

  function close() {
    server.close();
  }

  return { listen, close, on: emitter.on.bind(emitter) };
}

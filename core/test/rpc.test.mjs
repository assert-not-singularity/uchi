import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRpcServer } from "../rpc.mjs";

test("hello request/response round-trips over the socket, matching the request id", async () => {
  const socketPath = path.join(os.tmpdir(), `uchi-test-${process.pid}-${Date.now()}.sock`);
  const rpc = createRpcServer({
    methods: {
      hello: async () => ({ protocol: 1, homey: { address: "10.0.0.1" }, connected: true }),
    },
  });

  await rpc.listen(socketPath);
  try {
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const rl = readline.createInterface({ input: socket });
    const response = await new Promise((resolve) => {
      rl.once("line", (line) => resolve(JSON.parse(line)));
      socket.write(JSON.stringify({ id: 1, method: "hello", params: { client: "test", protocol: 1 } }) + "\n");
    });

    assert.equal(response.id, 1);
    assert.deepEqual(response.result, { protocol: 1, homey: { address: "10.0.0.1" }, connected: true });
    socket.end();
  } finally {
    rpc.close();
    fs.rmSync(socketPath, { force: true });
  }
});

test("broadcast() reaches every connected socket and not a disconnected one", async () => {
  const socketPath = path.join(os.tmpdir(), `uchi-test-${process.pid}-${Date.now()}.sock`);
  const rpc = createRpcServer({ methods: {} });

  await rpc.listen(socketPath);
  try {
    async function connectClient() {
      const socket = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return { socket, rl: readline.createInterface({ input: socket }) };
    }

    const staying = await connectClient();
    const leaving = await connectClient();

    const nextPush = new Promise((resolve) => {
      staying.rl.once("line", (line) => resolve(JSON.parse(line)));
    });
    leaving.rl.once("line", () => assert.fail("a disconnected socket must not receive a broadcast"));

    leaving.socket.end();
    await new Promise((resolve) => leaving.socket.once("close", resolve));

    rpc.broadcast({ sections: ["recent"] });

    const push = await nextPush;
    assert.deepEqual(push, { event: "state.changed", sections: ["recent"] });

    staying.socket.end();
  } finally {
    rpc.close();
    fs.rmSync(socketPath, { force: true });
  }
});

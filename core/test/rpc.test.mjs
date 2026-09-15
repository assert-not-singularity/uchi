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

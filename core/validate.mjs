import { connect, getDeviceCount } from "./homey.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (err) {
    console.error(`invalid JSON on stdin: ${err.message}`);
    process.exit(1);
  }

  const { address, token } = input ?? {};
  if (typeof address !== "string" || !address || typeof token !== "string" || !token) {
    console.error('stdin must be {"address": "...", "token": "..."}');
    process.exit(1);
  }

  try {
    const api = await connect({ address, token });
    const count = await getDeviceCount(api);
    console.log(String(count));
    process.exit(0);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

main();

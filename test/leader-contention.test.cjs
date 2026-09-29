const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const brokerServerPath = path.resolve(__dirname, "../src/broker/server.cjs");
const settingsPath = path.resolve(__dirname, "../src/shared/settings.cjs");

test("a standby broker never writes state before acquiring the port", () => {
  const script = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-contention-"));
// The directory holds fake secrets; remove it however the script exits.
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const statePath = path.join(dir, "pi-telegram-operator.state.json");
const sentinel = JSON.stringify({ offset: 777, mappings: [{ messageId: 1, threadId: 2, sessionId: "live", marker: "do-not-overwrite" }], pendingReplies: [], topics: [] }, null, 2) + "\n";
fs.writeFileSync(statePath, sentinel);
process.env.PI_CODING_AGENT_DIR = dir;
const server = net.createServer();
server.listen(43992, "127.0.0.1", async () => {
  try {
    const { startLocalLeader } = require(${JSON.stringify(brokerServerPath)});
    const { validateSettings } = require(${JSON.stringify(settingsPath)});
    const secret = validateSettings("123456:${"a".repeat(32)}", {
      chatId: 42,
      bridgeSecret: "${"b".repeat(64)}",
      port: 43992,
    });
    for (let index = 0; index < 3; index += 1) {
      const leader = await startLocalLeader(secret);
      if (leader !== undefined) throw new Error("standby unexpectedly acquired the port");
    }
    console.log(JSON.stringify({ unchanged: fs.readFileSync(statePath, "utf8") === sentinel }));
    server.close();
  } catch (error) {
    console.error(error);
    server.close(() => process.exit(1));
  }
});
`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { unchanged: true });
});

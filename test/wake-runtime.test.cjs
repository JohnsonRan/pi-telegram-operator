const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const brokerServerPath = path.resolve(__dirname, "../src/broker/server.cjs");
const settingsPath = path.resolve(__dirname, "../src/shared/settings.cjs");
const { WAKE_SENTINEL } = require("../src/wake/payload.cjs");

test("creates a session from All Topics and wakes the same topic again", () => {
  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-operator-wake-runtime-"));
// The directory holds fake secrets; remove it however the script exits.
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const launchLog = path.join(dir, "launches.jsonl");
const fakePi = path.join(dir, "fake-pi.cjs");
fs.writeFileSync(fakePi, "const fs=require('node:fs'); const payload=JSON.parse(Buffer.from(process.env.PI_TELEGRAM_WAKE_PAYLOAD,'base64url').toString('utf8')); fs.appendFileSync(" + JSON.stringify(launchLog) + ", JSON.stringify({args:process.argv.slice(2),payload}) + '\\n');\n");
fs.writeFileSync(path.join(dir, "pi-telegram-operator.state.json"), JSON.stringify({ offset: 0, mappings: [], pendingReplies: [], topics: [] }));
process.env.PI_CODING_AGENT_DIR = dir;

let poll = 0;
let threadId = 0;
let messageId = 100;
const sent = [];
global.fetch = async (url, options) => {
  const method = url.split("/").pop();
  const body = JSON.parse(options.body);
  if (method === "setMyCommands") return response(true);
  if (method === "createForumTopic") {
    threadId = 801;
    return response({ message_thread_id: threadId, name: body.name });
  }
  if (method === "sendMessage") {
    sent.push(body);
    return response({ message_id: ++messageId, message_thread_id: body.message_thread_id, chat: { id: 42 } });
  }
  if (method === "getUpdates") {
    poll += 1;
    if (poll === 1) return response([{
      update_id: 1,
      message: { message_id: 1, text: "/new | first prompt", chat: { id: 42 }, from: { id: 42, is_bot: false } },
    }]);
    if (poll === 2) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return response([{
        update_id: 2,
        message: { message_id: 2, message_thread_id: 801, text: "second prompt", chat: { id: 42 }, from: { id: 42, is_bot: false } },
      }]);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response([]);
  }
  throw new Error("Unexpected method " + method);
};
function response(result) { return { ok: true, status: 200, json: async () => ({ ok: true, result }) }; }

(async () => {
  const { closeLeader, startLocalLeader } = require(${JSON.stringify(brokerServerPath)});
  const { validateSettings } = require(${JSON.stringify(settingsPath)});
  const secret = validateSettings("123456:${"a".repeat(32)}", {
    chatId: 42,
    allowedUserId: 42,
    bridgeSecret: "${"b".repeat(64)}",
    port: 43991,
    wakeMode: true,
    wakeDefaultCwd: dir,
    wakeAllowedRoots: [dir],
    wakePiCommand: process.execPath,
    wakePiCommandArgs: [fakePi],
    wakeOpenTerminal: false,
  });
  const state = await startLocalLeader(secret);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const lines = fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean) : [];
    if (lines.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await closeLeader(state);
  const launches = fs.readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "pi-telegram-operator.state.json"), "utf8"));
  console.log(JSON.stringify({ launches, topics: stored.topics, sent }));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.topics.length, 1);
  assert.equal(result.launches.length, 2);
  const firstSessionId = result.launches[0].args[1];
  assert.deepEqual(result.launches[0].args.slice(-3), ["--print", "--approve", WAKE_SENTINEL]);
  assert.deepEqual(result.launches[0].payload, { text: "first prompt", expandPromptTemplates: true });
  assert.equal(result.launches[1].args[1], firstSessionId);
  assert.deepEqual(result.launches[1].args.slice(-3), ["--print", "--approve", WAKE_SENTINEL]);
  assert.deepEqual(result.launches[1].payload, { text: "second prompt", expandPromptTemplates: true });
  assert.ok(result.sent.some((message) => message.message_thread_id === 801 && /New Pi session/.test(message.text)));
  assert.ok(result.sent.filter((message) => /Waking Pi session/.test(message.text)).length >= 2);
});

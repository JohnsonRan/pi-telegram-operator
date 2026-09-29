const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const brokerServerPath = path.resolve(__dirname, "../src/broker/server.cjs");
const settingsPath = path.resolve(__dirname, "../src/shared/settings.cjs");

// This subprocess exercises Telegram routing, the real git exec path, topic creation, and wake launch together.
test("clones a Telegram repository command and starts Pi in the clone", () => {
  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-operator-clone-runtime-"));
// The directory holds fake secrets; remove it however the script exits.
process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const launchLog = path.join(dir, "launches.jsonl");
const fakePi = path.join(dir, "fake-pi.cjs");
const source = path.join(dir, "source", "demo.git");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
fs.mkdirSync(path.dirname(source), { recursive: true });
execFileSync("git", ["init", "--bare", source], { stdio: "ignore" });
fs.writeFileSync(fakePi, "const fs=require('node:fs'); const payload=JSON.parse(Buffer.from(process.env.PI_TELEGRAM_WAKE_PAYLOAD,'base64url').toString('utf8')); fs.appendFileSync(" + JSON.stringify(launchLog) + ", JSON.stringify({args:process.argv.slice(2),payload,cwd:process.cwd()}) + '\\n');\n");
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "url." + pathToFileURL(source).href + ".insteadOf";
process.env.GIT_CONFIG_VALUE_0 = "https://example.test/org/demo.git";
process.env.PI_CODING_AGENT_DIR = dir;
fs.writeFileSync(path.join(dir, "pi-telegram-operator.state.json"), JSON.stringify({ offset: 0, mappings: [], pendingReplies: [], topics: [] }));

let poll = 0;
let messageId = 100;
const sent = [];
global.fetch = async (url, options) => {
  const method = url.split("/").pop();
  const body = JSON.parse(options.body);
  if (method === "setMyCommands") return response(true);
  if (method === "createForumTopic") return response({ message_thread_id: 901, name: body.name });
  if (method === "sendMessage") {
    sent.push(body);
    return response({ message_id: ++messageId, message_thread_id: body.message_thread_id, chat: { id: 42 } });
  }
  if (method === "getUpdates") {
    poll += 1;
    if (poll === 1) return response([{
      update_id: 1,
      message: { message_id: 1, text: "git clone https://example.test/org/demo.git", chat: { id: 42 }, from: { id: 42, is_bot: false } },
    }]);
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
    port: 43993,
    wakeMode: true,
    wakeDefaultCwd: dir,
    wakeAllowedRoots: [dir],
    wakePiCommand: process.execPath,
    wakePiCommandArgs: [fakePi],
    wakeOpenTerminal: false,
  });
  const state = await startLocalLeader(secret);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !fs.existsSync(launchLog)) await new Promise((resolve) => setTimeout(resolve, 25));
  await closeLeader(state);
  console.log(JSON.stringify({
    launch: JSON.parse(fs.readFileSync(launchLog, "utf8").trim()),
    clonedGitDir: fs.existsSync(path.join(dir, "demo", ".git")),
    sent,
  }));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(path.basename(result.launch.cwd), "demo");
  assert.equal(result.clonedGitDir, true);
  assert.equal(result.launch.payload.text, "");
  assert.ok(result.sent.some((message) => /Cloning repository/.test(message.text)));
  assert.ok(result.sent.some((message) => message.message_thread_id === 901 && /Repository cloned: demo/.test(message.text)));
  assert.ok(result.sent.some((message) => message.message_thread_id === 901 && /Waking Pi session/.test(message.text)));
});

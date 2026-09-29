const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Broker helpers persist state under the agent directory; keep it out of $HOME.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-retry-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { __test: broker } = require("../src/broker/server.cjs");

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

test("retries a rejected reply delivery to the reconnected session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const written = [];
  const pending = { deliveryId: "delivery", sessionId: "session", text: "hello", createdAt: Date.now() };
  const state = {
    pendingReplies: new Map([[pending.deliveryId, pending]]),
    clientsBySession: new Map([["session", {
      registered: true,
      socket: { destroyed: false, write: (line) => written.push(JSON.parse(line)) },
    }]]),
    mappings: new Map(),
    pendingQuestions: new Map(),
    topics: new Map(),
    persistQueue: Promise.resolve(),
  };
  broker.schedulePendingRetry(state, pending);
  t.mock.timers.tick(500);
  assert.deepEqual(written.map((item) => [item.type, item.deliveryId]), [["reply", "delivery"]]);
  await state.persistQueue;
});

function registerState(pendingReplies) {
  return {
    secret: { bridgeSecret: "secret" },
    sessionCommands: new Map(),
    topics: new Map(),
    wakeReservations: new Set(),
    clients: new Map(),
    clientsBySession: new Map(),
    pendingQuestions: new Map(),
    mappings: new Map(),
    pendingReplies: new Map(pendingReplies.map((item) => [item.deliveryId, item])),
    persistQueue: Promise.resolve(),
  };
}

function registerClient(state, wakeChild) {
  const written = [];
  const client = { registered: false, socket: { destroyed: false, write: (line) => written.push(JSON.parse(line)), destroy() {} } };
  broker.handleBrokerRequest(state, client, {
    auth: "secret", type: "register", version: 2, clientId: "client", sessionId: "session", cwd: "", wakeChild,
  });
  return written.filter((item) => item.type === "reply").map((item) => item.deliveryId);
}

test("delivers queued and held replies once when a regular session reconnects", async () => {
  const state = registerState([
    { deliveryId: "queued", sessionId: "session", text: "a", createdAt: 1 },
    { deliveryId: "held", sessionId: "session", text: "b", createdAt: 2, holdForWake: true },
    { deliveryId: "other", sessionId: "other", text: "c", createdAt: 3 },
  ]);
  assert.deepEqual(registerClient(state, false), ["queued", "held"]);
  await state.persistQueue;
});

test("keeps held follow-ups back from a wake child until its first turn", async () => {
  const state = registerState([
    { deliveryId: "queued", sessionId: "session", text: "a", createdAt: 1 },
    { deliveryId: "held", sessionId: "session", text: "b", createdAt: 2, holdForWake: true },
  ]);
  assert.deepEqual(registerClient(state, true), ["queued"]);
  await state.persistQueue;
});

test("tells the replaced client it was superseded instead of dropping it", () => {
  const state = registerState([]);
  const events = [];
  const socket = (name) => ({
    destroyed: false,
    write: (line) => events.push([name, JSON.parse(line).type]),
    end: () => events.push([name, "end"]),
    destroy: () => events.push([name, "destroy"]),
  });
  for (const [clientId, name] of [["old", "old"], ["new", "new"]]) {
    broker.handleBrokerRequest(state, { registered: false, socket: socket(name) }, {
      auth: "secret", type: "register", version: 2, clientId, sessionId: "session", cwd: "",
    });
  }
  assert.deepEqual(events.filter(([name]) => name === "old"), [["old", "registered"], ["old", "superseded"], ["old", "end"]]);
  assert.equal(state.clientsBySession.get("session").clientId, "new");
});

test("reports an abnormal wake exit in the session topic", async (t) => {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  const state = {
    secret: { botToken: "token", chatId: 42 },
    foregroundStartups: new Set(),
    wakeReservations: new Set(["session"]),
    topics: new Map([["session", { sessionId: "session", threadId: 7 }]]),
  };
  await broker.reportWakeExit(state, { sessionId: "session", code: 2, stderr: "boom" });
  assert.equal(state.wakeReservations.has("session"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].body.message_thread_id, 7);
  assert.match(calls[0].body.text, /code 2[\s\S]*boom/);
});

test("redacts the bot token from Telegram network errors", async (t) => {
  const { telegramCall } = require("../src/telegram/api.cjs");
  const botToken = `123456:${"s".repeat(32)}`;
  t.mock.method(global, "fetch", async (url) => {
    throw new TypeError(`Request cannot be constructed from ${url}`);
  });
  await assert.rejects(telegramCall({ botToken }, "getMe", {}), (error) => {
    assert.doesNotMatch(error.message, new RegExp("s{32}"));
    assert.match(error.message, /<bot-token>/);
    return true;
  });
});

test("rejects unauthenticated frames and ignores unknown message types", () => {
  const destroyed = [];
  const client = { registered: true, socket: { destroyed: false, destroy: (error) => destroyed.push(error.message), write() {} } };
  const state = { secret: { bridgeSecret: "secret" } };
  for (const type of ["unknown", "constructor", "__proto__", "toString"]) {
    broker.handleBrokerRequest(state, client, { auth: "secret", type });
  }
  assert.deepEqual(destroyed, []);
  broker.handleBrokerRequest(state, client, { auth: "wrong", type: "notify" });
  assert.deepEqual(destroyed, ["Telegram bridge authentication failed"]);
});

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

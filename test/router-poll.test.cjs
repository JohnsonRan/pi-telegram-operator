const assert = require("node:assert/strict");
const test = require("node:test");
const { __test: router } = require("../src/telegram/router.cjs");

test("skips an update that keeps failing instead of blocking polling", async (t) => {
  t.mock.method(console, "warn", () => {});
  const state = { offset: 10 };
  const options = {
    handleTelegramMessage: async () => { throw new Error("poison"); },
    queuePersist: async () => {},
  };
  const update = { update_id: 10, message: { text: "x" } };
  await assert.rejects(router.processTelegramUpdate(state, update, options), /poison/);
  await assert.rejects(router.processTelegramUpdate(state, update, options), /poison/);
  assert.equal(state.offset, 10);
  await router.processTelegramUpdate(state, update, options);
  assert.equal(state.offset, 11);
  assert.equal(state.failedUpdate, undefined);
});

test("long All Topics commands run without blocking the poll loop", async (t) => {
  const sent = [];
  t.mock.method(global, "fetch", async (url, init) => {
    sent.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
  let finishUpdate;
  const state = {
    offset: 1,
    activeTasks: new Set(),
    topics: new Map(),
    secret: { botToken: "token", chatId: 42, allowedUserId: 42, wakeMode: true },
    runPiUpdate: () => new Promise((resolve) => { finishUpdate = resolve; }),
  };
  await router.processTelegramUpdate(state, {
    update_id: 1,
    message: { message_id: 5, text: "/update", chat: { id: 42 }, from: { id: 42 } },
  }, { queuePersist: async () => {} });
  assert.equal(state.offset, 2);
  assert.equal(state.activeTasks.size, 1);

  await new Promise((resolve) => setImmediate(resolve));
  finishUpdate("done");
  await Promise.all(state.activeTasks);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.activeTasks.size, 0);
  assert.ok(sent.some((call) => call.method === "sendMessage" && /Pi update completed/.test(call.body.text)));
});

test("Telegram's native stop button stops only the draft streaming in that topic", async (t) => {
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify({ ok: true, result: true })));
  const lines = [];
  const socket = { destroyed: false, writable: true, write: (line) => { lines.push(JSON.parse(line)); return true; } };
  const topic = { sessionId: "s1", threadId: 7, cwd: "." };
  const state = {
    secret: { botToken: "token", chatId: 42, allowedUserId: 42 },
    topics: new Map([["s1", topic]]),
    activeDrafts: new Map([["s1", 99]]),
    clientsBySession: new Map([["s1", { registered: true, sessionId: "s1", socket }]]),
  };
  await router.handleGenerationStopped(state, { chat: { id: 42 }, message_thread_id: 7, draft_id: 98 });
  await router.handleGenerationStopped(state, { chat: { id: 1 }, message_thread_id: 7, draft_id: 99 });
  assert.equal(lines.length, 0);
  await router.handleGenerationStopped(state, { chat: { id: 42 }, message_thread_id: 7, draft_id: 99 });
  assert.deepEqual(lines.map((line) => [line.type, line.action]), [["control", "stop"]]);
  assert.equal(state.activeDrafts.has("s1"), false);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-topic-retry-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { withTopicRetry } = require("../src/telegram/router.cjs");
const { __test: broker } = require("../src/broker/server.cjs");
const { readBrokerState } = require("../src/broker/state.cjs");

const COOLDOWN_MS = 5 * 60 * 1000;
const wrongHome = "Bad Request: BOT_TOPIC_WRONG_HOME";
const threadMissing = () => new Error("Telegram sendMessage failed: Bad Request: message thread not found");

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

function stateWith(topic) {
  return {
    secret: { botToken: "token", chatId: 42, bridgeSecret: "secret" },
    topics: new Map(topic ? [[topic.sessionId, topic]] : []),
    topicPromises: new Map(),
    sessionCommands: new Map(),
    dashboardQueues: new Map(),
    streamQueues: new Map(),
    chatActionSentAt: new Map(),
    activeDrafts: new Map(),
    activeTasks: new Set(),
    mappings: new Map(),
    pendingReplies: new Map(),
    pendingQuestions: new Map(),
    persistQueue: Promise.resolve(),
  };
}

function mockTelegram(t, create) {
  const creations = [];
  t.mock.method(global, "fetch", async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "createForumTopic") {
      creations.push(body);
      const description = await create(creations.length);
      if (description) return new Response(JSON.stringify({ ok: false, description }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 700 + creations.length, name: body.name } }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900 } }));
  });
  return creations;
}

async function settle(state) {
  await Promise.allSettled([...state.activeTasks, ...state.dashboardQueues.values()]);
  await state.persistQueue;
}

test("a failed creation pauses all sessions, then one probe can recover", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const state = stateWith();
  const creations = mockTelegram(t, (attempt) => attempt === 1 ? wrongHome : undefined);
  const send = (sessionId) => withTopicRetry(state, sessionId, "/work", "", (topic) => topic.threadId);

  await assert.rejects(send("first"), /BOT_TOPIC_WRONG_HOME/);
  for (const sessionId of ["first", "second", "third"]) {
    await assert.rejects(send(sessionId), /BOT_TOPIC_WRONG_HOME/);
  }
  assert.equal(creations.length, 1, "stream updates must not keep creating topics");
  t.mock.timers.tick(COOLDOWN_MS - 1);
  await assert.rejects(send("first"), /BOT_TOPIC_WRONG_HOME/);
  assert.equal(creations.length, 1);
  t.mock.timers.tick(1);
  assert.equal(await send("first"), 702);
  assert.equal(creations.length, 2);
  await settle(state);
});

test("concurrent sessions share the creation failure cooldown", async (t) => {
  const state = stateWith();
  const creations = mockTelegram(t, () => wrongHome);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    withTopicRetry(state, `session-${index}`, "/work", "", () => assert.fail("creation failed"))));
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(creations.length, 1);
  assert.equal(state.topicPromises.size, 0);
});

test("a newly created but unwritable topic is not replaced on every stream update", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const state = stateWith();
  const creations = mockTelegram(t, () => undefined);
  const send = () => withTopicRetry(state, "session", "/work", "", () => { throw threadMissing(); });

  for (let index = 0; index < 10; index += 1) await assert.rejects(send(), /message thread not found/);
  assert.equal(creations.length, 1);
  assert.equal(state.topics.get("session").threadId, 701);
  t.mock.timers.tick(COOLDOWN_MS);
  await assert.rejects(send(), /message thread not found/);
  assert.equal(creations.length, 2, "at most one replacement per cooldown");
  await assert.rejects(send(), /message thread not found/);
  assert.equal(creations.length, 2);
  await settle(state);
});

test("a failed replacement preserves the old topic and reply routing", async (t) => {
  const original = { sessionId: "session", threadId: 77, createdAt: Date.now() - COOLDOWN_MS - 1 };
  const state = stateWith(original);
  const creations = mockTelegram(t, () => wrongHome);
  const send = () => withTopicRetry(state, "session", "/work", "", () => { throw threadMissing(); });

  await assert.rejects(send(), /BOT_TOPIC_WRONG_HOME/);
  assert.equal(state.topics.get("session"), original);
  await assert.rejects(send(), /BOT_TOPIC_WRONG_HOME/);
  assert.equal(creations.length, 1);
  await settle(state);
});

test("concurrent stale writes share one replacement without deleting it", async (t) => {
  const original = { sessionId: "session", threadId: 77, createdAt: Date.now() - COOLDOWN_MS - 1 };
  const state = stateWith(original);
  const creations = mockTelegram(t, () => undefined);
  const send = () => withTopicRetry(state, "session", "/work", "", (topic) => {
    if (topic.threadId === 77) throw threadMissing();
    return topic.threadId;
  });

  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, send)), Array(10).fill(701));
  assert.equal(creations.length, 1);
  assert.equal(state.topics.get("session").threadId, 701);
  await settle(state);
  const stored = await readBrokerState();
  assert.equal(stored.topics.find((topic) => topic.sessionId === "session").threadId, 701);
});

test("creation cooldown does not block healthy topics or retry unrelated write errors", async (t) => {
  const topic = { sessionId: "healthy", threadId: 77, createdAt: Date.now() - COOLDOWN_MS - 1 };
  const state = stateWith(topic);
  const creations = mockTelegram(t, () => wrongHome);
  await assert.rejects(withTopicRetry(state, "new", "/work", "", () => {}), /BOT_TOPIC_WRONG_HOME/);
  assert.equal(await withTopicRetry(state, "healthy", "/work", "", (item) => item.threadId), 77);
  await assert.rejects(withTopicRetry(state, "healthy", "/work", "", () => {
    throw new Error("Telegram sendMessage failed: Bad Request: text is too long");
  }), /text is too long/);
  assert.equal(creations.length, 1);
  assert.equal(state.topics.get("healthy"), topic);
});

test("drafts log the real creation failure once, while final replies report the cooldown", async (t) => {
  const state = stateWith();
  const creations = mockTelegram(t, () => wrongHome);
  const warnings = [];
  t.mock.method(console, "warn", (text) => warnings.push(text));
  const results = [];
  const client = {
    registered: true,
    sessionId: "session",
    cwd: "/work",
    socket: { destroyed: false, write: (line) => results.push(JSON.parse(line)) },
  };
  for (let index = 0; index < 10; index += 1) {
    broker.handleBrokerRequest(state, client, {
      auth: "secret", type: "streamDraft", sessionId: "session", draftId: 1, text: "Working",
    });
    await settle(state);
  }
  assert.equal(creations.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /BOT_TOPIC_WRONG_HOME/);

  broker.handleBrokerRequest(state, client, {
    auth: "secret", type: "streamFinal", requestId: "final", sessionId: "session", draftId: 1, text: "Done",
  });
  await settle(state);
  await new Promise((resolve) => setImmediate(resolve));
  const result = results.find((item) => item.requestId === "final");
  assert.equal(result.ok, false);
  assert.match(result.error, /paused.*BOT_TOPIC_WRONG_HOME/);
});

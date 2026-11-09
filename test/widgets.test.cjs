const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// queuePersist writes the broker state file; keep it out of the real agent dir.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-widgets-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { __test: broker } = require("../src/broker/server.cjs");
const { __test: router } = require("../src/telegram/router.cjs");

const token = `123456:${"a".repeat(32)}`;

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

function mockFetch(t, respond = () => ({ ok: true, result: true })) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const body = respond(calls.length, String(url));
    return new Response(JSON.stringify(body), { status: body.error_code || 200 });
  });
  return calls;
}

function widgetSession(apiBaseUrl) {
  const replies = [];
  const state = {
    secret: { botToken: token, bridgeSecret: "secret", chatId: 42, allowedUserId: 7, apiBaseUrl },
    topics: new Map([["s1", { sessionId: "s1", threadId: 9 }]]),
    mappings: new Map(),
    pendingReplies: new Map(),
    activeTasks: new Set(),
    persistQueue: Promise.resolve(),
  };
  const client = {
    registered: true,
    sessionId: "s1",
    socket: { destroyed: false, write: (line) => replies.push(JSON.parse(line)) },
  };
  return { state, client, replies };
}

async function widgetRequest(state, client, message) {
  broker.handleBrokerRequest(state, client, { auth: "secret", requestId: "req", ...message });
  await Promise.allSettled([...state.activeTasks]);
  await new Promise((resolve) => setImmediate(resolve));
}

test("the broker sends and updates widgets through the stable or configured API URL", async (t) => {
  for (const apiBaseUrl of [undefined, "https://api.telegram.org", "http://localhost:8081/custom"]) {
    await t.test(apiBaseUrl || "default URL", async (t) => {
      const calls = mockFetch(t, () => ({ ok: true, result: { message_id: 100 } }));
      const { state, client, replies } = widgetSession(apiBaseUrl);
      await widgetRequest(state, client, { type: "widget", html: "<p>Ready</p>", chatData: "initial" });
      await widgetRequest(state, client, { type: "widgetData", messageId: 100, chatData: "", publicData: "updated" });

      const base = apiBaseUrl || "https://api.telegram.org";
      assert.deepEqual(calls.map((call) => call.url), [
        `${base}/bot${token}/sendWidget`,
        `${base}/bot${token}/editMessageWidgetData`,
      ]);
      assert.equal(calls[0].body.message_thread_id, 9);
      assert.equal(calls[0].body.html, "<p>Ready</p>");
      assert.equal(calls[0].body.chat_data, "initial");
      assert.equal(calls[0].body.allow_queries, true);
      assert.deepEqual(calls[1].body, { chat_id: 42, message_id: 100, chat_data: "", public_data: "updated" });
      assert.deepEqual(state.topics.get("s1").widgetIds, [100]);
      assert.equal(replies.length, 2);
      assert.equal(replies[0].messageId, 100);
      assert.ok(replies.every((reply) => reply.ok));
    });
  }
});

test("a widget tap is answered at once on the stable API and delivered to its session", async (t) => {
  const calls = mockFetch(t);
  const lines = [];
  const socket = { destroyed: false, write: (line) => lines.push(JSON.parse(line)) };
  const state = {
    secret: { botToken: token, chatId: 42, allowedUserId: 7 },
    topics: new Map([["s1", { sessionId: "s1", threadId: 9, widgetIds: [100] }]]),
    mappings: new Map(),
    pendingReplies: new Map(),
    clientsBySession: new Map([["s1", { registered: true, socket }]]),
    persistQueue: Promise.resolve(),
  };
  const query = { id: "q1", from: { id: 7 }, chat: { id: 42 }, message_id: 100, type: { type: "data" }, data: "vote:2" };
  await router.handleWidgetQuery(state, query);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/answerWidgetQuery`);
  assert.deepEqual(calls[0].body, { widget_query_id: "q1" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sessionId, "s1");
  assert.equal(lines[0].text, "Telegram widget 100 request: vote:2");
  assert.equal(calls.some((call) => call.url.endsWith("/setMessageReaction")), false);

  // Unknown widgets, other users and other chats are answered but not delivered.
  await router.handleWidgetQuery(state, { ...query, id: "q2", message_id: 101 });
  await router.handleWidgetQuery(state, { ...query, id: "q3", from: { id: 8 } });
  await router.handleWidgetQuery(state, { ...query, id: "q4", chat: { id: 43 } });
  assert.equal(lines.length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/answerWidgetQuery")).length, 4);
});

test("widget errors reach the caller without retrying another endpoint", async (t) => {
  for (const status of [400, 404, 502]) {
    await t.test(String(status), async (t) => {
      const calls = mockFetch(t, () => ({ ok: false, error_code: status, description: "Widget unavailable" }));
      const { state, client, replies } = widgetSession();
      await widgetRequest(state, client, { type: "widget", html: "<p>Ready</p>" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendWidget`);
      assert.equal(replies[0].ok, false);
      assert.match(replies[0].error, /Widget unavailable/);
      assert.equal(state.topics.get("s1").widgetIds, undefined);
    });
  }
});

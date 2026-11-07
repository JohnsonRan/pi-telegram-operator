const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// queuePersist writes the broker state file; keep it out of the real agent dir.
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-widgets-"));

const { telegramBetaCall } = require("../src/telegram/api.cjs");
const { __test: router } = require("../src/telegram/router.cjs");

const token = `123456:${"a".repeat(32)}`;

function mockFetch(t, respond = () => ({ ok: true, result: true })) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const body = respond(calls.length, String(url));
    return new Response(JSON.stringify(body), { status: body.error_code || 200 });
  });
  return calls;
}

test("widget methods use the official /beta path but keep a self-hosted URL", async (t) => {
  const calls = mockFetch(t);
  await telegramBetaCall({ botToken: token, apiBaseUrl: "https://api.telegram.org" }, "sendWidget", {});
  await telegramBetaCall({ botToken: token, apiBaseUrl: "http://localhost:8081" }, "sendWidget", {});
  assert.equal(calls[0].url, `https://api.telegram.org/beta/bot${token}/sendWidget`);
  assert.equal(calls[1].url, `http://localhost:8081/bot${token}/sendWidget`);
});

test("a widget tap is answered at once and delivered to the topic's session", async (t) => {
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
  await router.handleWidgetQuery(state, { id: "q1", from: { id: 7 }, chat: { id: 42 }, message_id: 100, data: "vote:2" });
  assert.equal(calls[0].url.endsWith("/answerWidgetQuery"), true);
  assert.deepEqual(calls[0].body, { widget_query_id: "q1" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sessionId, "s1");
  assert.equal(lines[0].text, "Telegram widget 100 request: vote:2");
  assert.equal(calls.some((call) => call.url.endsWith("/setMessageReaction")), false);

  // Unknown widgets and other users are answered but not delivered.
  await router.handleWidgetQuery(state, { id: "q2", from: { id: 7 }, chat: { id: 42 }, message_id: 101, data: "x" });
  await router.handleWidgetQuery(state, { id: "q3", from: { id: 8 }, chat: { id: 42 }, message_id: 100, data: "x" });
  assert.equal(lines.length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/answerWidgetQuery")).length, 3);
});

// Last: the fallback flips a module-level flag for the rest of this process.
test("falls back to the plain URL when /beta is gone", async (t) => {
  const calls = mockFetch(t, (index) => (index === 1 ? { ok: false, error_code: 404, description: "Not Found" } : { ok: true, result: [] }));
  const secret = { botToken: token, apiBaseUrl: "https://api.telegram.org" };
  await telegramBetaCall(secret, "getUpdates", {});
  await telegramBetaCall(secret, "getUpdates", {});
  assert.deepEqual(calls.map((call) => call.url.includes("/beta/")), [true, false, false]);
});

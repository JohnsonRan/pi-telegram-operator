const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// queuePersist writes the broker state file; keep it out of the real agent dir.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-custom-answer-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { __test: broker } = require("../src/broker/server.cjs");
const { requestQuestion } = require("../src/bridge/client.cjs");
const { customCallbackData, parseQuestionCustomCallback, questionKeyboard } = require("../src/telegram/questions.cjs");

const questionId = "12345678-1234-1234-1234-123456789abc";
const token = `123456:${"a".repeat(32)}`;

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

function mockTelegram(t) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  return calls;
}

// One connected session with one question waiting in its topic.
function sessionState(question = {}) {
  const written = [];
  const client = {
    registered: true,
    clientId: "client",
    sessionId: "session",
    socket: { destroyed: false, write: (line) => written.push(JSON.parse(line)), destroy() {} },
  };
  const state = {
    secret: { bridgeSecret: "secret", botToken: token, chatId: 42, allowedUserId: 7 },
    topics: new Map([["session", { sessionId: "session", threadId: 9 }]]),
    mappings: new Map(),
    pendingReplies: new Map(),
    pendingQuestions: new Map([[questionId, {
      questionId,
      requestId: "req",
      clientId: "client",
      sessionId: "session",
      threadId: 9,
      messageId: 90,
      question: "Which checks?",
      options: ["lint", "test", "build"],
      ...question,
    }]]),
    clients: new Map([["client", client]]),
    clientsBySession: new Map([["session", client]]),
    dashboardQueues: new Map(),
    chatActionSentAt: new Map(),
    activeTasks: new Set(),
    persistQueue: Promise.resolve(),
  };
  return { state, client, written };
}

const tapCustom = (router, state) => router.handleCallbackQuery(state, {
  id: "cb", data: customCallbackData(questionId), from: { id: 7 }, message: { message_id: 90, chat: { id: 42 } },
});
const typeText = (router, state, text, updateId = 1) => router.processTelegramUpdate(state, {
  update_id: updateId,
  message: { message_id: 100 + updateId, message_thread_id: 9, chat: { id: 42 }, from: { id: 7 }, text },
});

test("every question keyboard ends with a typed-answer button", () => {
  const keyboard = questionKeyboard(questionId, ["Deploy", "Cancel"]);
  const custom = keyboard.inline_keyboard.at(-1)[0];
  assert.equal(custom.text, "✏️ Type my own answer");
  assert.deepEqual(parseQuestionCustomCallback(custom.callback_data), { questionId });
  assert.ok(Buffer.byteLength(custom.callback_data) <= 64);
  assert.equal(parseQuestionCustomCallback(`question:${questionId}:0`), undefined);
});

test("after the typed-answer tap, the next text in the topic answers the question", async (t) => {
  const calls = mockTelegram(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const { state, written } = sessionState();

  await tapCustom(router, state);
  assert.equal(state.pendingQuestions.get(questionId).awaitingText, true);
  const prompt = calls.find((call) => call.method === "answerCallbackQuery");
  assert.match(prompt.body.text, /Send your answer as a message in this topic/);

  await typeText(router, state, "  only the smoke tests  ");
  const result = written.find((line) => line.type === "result");
  assert.deepEqual({ requestId: result.requestId, answer: result.answer }, { requestId: "req", answer: "only the smoke tests" });
  // The text answered the question; it did not start a new Pi turn.
  assert.equal(written.some((line) => line.type === "reply"), false);
  assert.equal(state.pendingReplies.size, 0);
  assert.equal(state.pendingQuestions.get(questionId).awaitingText, undefined);
  assert.ok(calls.some((call) => call.method === "setMessageReaction" && call.body.message_id === 101));
  const settled = calls.find((call) => call.method === "editMessageText" && call.body.message_id === 90);
  assert.match(settled.body.rich_message.markdown, /only the smoke tests/);

  // Once answered, later text goes to Pi as usual.
  await typeText(router, state, "thanks", 2);
  assert.equal(written.filter((line) => line.type === "result").length, 1);
  assert.equal(written.filter((line) => line.type === "reply").at(-1).text, "thanks");
});

test("a typed answer joins the options already ticked on a multi-select question", async (t) => {
  mockTelegram(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const { state, written } = sessionState({ multiSelect: true, selected: [0, 2] });
  await tapCustom(router, state);
  await typeText(router, state, "docs");
  assert.equal(written.find((line) => line.type === "result").answer, "lint, build, docs");
});

test("text without the typed-answer tap still reaches Pi as a message", async (t) => {
  mockTelegram(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const { state, written } = sessionState();
  await typeText(router, state, "what does lint cover?");
  assert.equal(written.some((line) => line.type === "result"), false);
  assert.equal(written.find((line) => line.type === "reply").text, "what does lint cover?");
  assert.equal(state.pendingQuestions.get(questionId).answer, undefined);
});

test("a question Pi stopped waiting for is withdrawn, so typed text is not swallowed", async (t) => {
  const calls = mockTelegram(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const { state, client, written } = sessionState({ awaitingText: true });

  broker.handleBrokerRequest(state, client, { auth: "secret", type: "questionCancel", sessionId: "session", requestId: "req" });
  assert.equal(state.pendingQuestions.size, 0);
  const strip = calls.find((call) => call.method === "editMessageReplyMarkup");
  assert.deepEqual(strip.body, { chat_id: 42, message_id: 90, reply_markup: { inline_keyboard: [] } });

  await typeText(router, state, "never mind, run everything");
  assert.equal(written.find((line) => line.type === "reply").text, "never mind, run everything");
});

test("aborting a question tells the broker Pi has stopped waiting", async () => {
  const sent = [];
  const state = {
    closed: false,
    connected: true,
    sessionId: "session",
    secret: { bridgeSecret: "secret", botToken: token },
    pending: new Map(),
    socket: { destroyed: false, write: (line) => sent.push(JSON.parse(line)) },
  };
  const controller = new AbortController();
  const asking = requestQuestion(state, "Q?", ["Yes"], controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("turn aborted"));
  await assert.rejects(asking, /turn aborted/);
  assert.deepEqual(sent.at(-1), { type: "questionCancel", auth: "secret", sessionId: "session", requestId: sent[0].requestId });
});

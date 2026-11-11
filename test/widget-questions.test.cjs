const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// queuePersist writes the broker state file; keep it out of the real agent dir.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-widget-question-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { __test: broker } = require("../src/broker/server.cjs");
const { requestQuestion, requestWidgetQuestion, __test: client } = require("../src/bridge/client.cjs");
const { parseQuestionCallback, widgetQuestionCaption, widgetQuestionKeyboard } = require("../src/telegram/questions.cjs");

const questionId = "12345678-1234-1234-1234-123456789abc";
const token = `123456:${"a".repeat(32)}`;

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

// The broker sends the widget and then answers the client over its socket.
function brokerState(written) {
  return {
    secret: { bridgeSecret: "secret", botToken: token, chatId: 42, allowedUserId: 7 },
    topics: new Map([["session", { sessionId: "session", threadId: 9 }]]),
    topicPromises: new Map(),
    mappings: new Map(),
    pendingReplies: new Map(),
    pendingQuestions: new Map(),
    clients: new Map(),
    clientsBySession: new Map(),
    activeTasks: new Set(),
    persistQueue: Promise.resolve(),
  };
}

function registeredClient(written) {
  return {
    registered: true,
    clientId: "client",
    sessionId: "session",
    cwd: "C:\\Work",
    socket: { destroyed: false, write: (line) => written.push(JSON.parse(line)), destroy() {} },
  };
}

function mockWidget(t, respond = () => ({ ok: true, result: { message_id: 555 } })) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const body = respond(String(url));
    return new Response(JSON.stringify(body), { status: body.error_code || 200 });
  });
  return calls;
}

test("a widget question sends one widget message with the options as its keyboard", async (t) => {
  const calls = mockWidget(t);
  const written = [];
  const state = brokerState(written);
  const clientState = registeredClient(written);
  state.clients.set("client", clientState);
  state.clientsBySession.set("session", clientState);

  broker.handleBrokerRequest(state, clientState, {
    auth: "secret",
    type: "widgetQuestion",
    requestId: "req-1",
    question: "Which deploy?",
    options: ["Staging", "Production", "Cancel"],
    widget: "<html><body>pick</body></html>",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.allSettled([...state.activeTasks]);
  // sendSuccess runs one microtask after the tracked task settles.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendWidget`);
  assert.equal(calls[0].body.chat_id, 42);
  assert.equal(calls[0].body.message_thread_id, 9);
  assert.equal(calls[0].body.html, "<html><body>pick</body></html>");
  assert.equal(calls[0].body.allow_queries, true);
  assert.match(calls[0].body.caption, /Which deploy\?/);
  assert.match(calls[0].body.caption, /2\. Production/);
  assert.equal(calls[0].body.reply_markup.inline_keyboard.length, 2);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0].map((button) => button.text), ["Staging", "Production"]);

  // The options answer through the plain question path; the widget id is remembered for taps.
  const [pending] = state.pendingQuestions.values();
  assert.equal(pending.question, "Which deploy?");
  assert.deepEqual(pending.options, ["Staging", "Production", "Cancel"]);
  assert.equal(pending.messageId, 555);
  assert.equal(pending.widget, true);
  assert.deepEqual(state.topics.get("session").widgetIds, [555]);
  // Like a plain question, the request stays open until the user picks; no result is sent yet.
  assert.equal(written.filter((line) => line.type === "result").length, 0);
});

test("a widget question without a widget or options fails instead of sending half a question", async (t) => {
  const calls = mockWidget(t);
  const written = [];
  const state = brokerState(written);
  const clientState = registeredClient(written);

  for (const message of [
    { requestId: "no-widget", question: "Q?", options: ["Yes"], widget: "   " },
    { requestId: "no-options", question: "Q?", options: [], widget: "<html></html>" },
  ]) {
    broker.handleBrokerRequest(state, clientState, { auth: "secret", type: "widgetQuestion", ...message });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 0);
  const failures = written.filter((line) => line.type === "result" && line.ok === false);
  assert.equal(failures.length, 2);
  assert.match(failures[0].error, /widget and selectable options/);
});

test("a widget question keeps the caption readable and its keyboard within ten options", () => {
  const options = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const keyboard = widgetQuestionKeyboard(questionId, options);
  assert.deepEqual(keyboard.inline_keyboard.map((row) => row.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(parseQuestionCallback(keyboard.inline_keyboard[4][1].callback_data), { questionId, optionIndex: 9 });
  assert.match(widgetQuestionCaption("Pick one", options), /\n\n1\. a[\s\S]*\n10\. j$/);
  // sendWidget refuses captions over 1024 characters; the question gives way to the options.
  const long = widgetQuestionCaption("q".repeat(3000), options);
  assert.equal(long.length, 1024);
  assert.match(long, /q…\n\n1\. a[\s\S]*\n10\. j$/);
});

test("an answered widget question swaps its options for one inert answer button", async (t) => {
  const calls = mockWidget(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const state = toggleState({ widget: true, multiSelect: undefined, selected: undefined });
  const opts = { queuePersist: async () => {}, deliverQuestionAnswer: () => true, syncTopicDashboard: async () => {} };
  await router.handleCallbackQuery(state, {
    id: "cb", data: `question:${questionId}:1`, from: { id: 7 }, message: { message_id: 90, chat: { id: 42 } },
  }, opts);
  // A widget message has no text, so editMessageText would fail and leave the buttons tappable.
  assert.equal(calls.some((call) => call.url.endsWith("/editMessageText")), false);
  const edit = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup"));
  assert.equal(edit.body.message_id, 90);
  assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [[{ text: "✓ test", disabled: {} }]] });
});

test("the client asks the broker for a widget question with the widget attached", async () => {
  const sent = [];
  const state = {
    closed: false,
    connected: true,
    sessionId: "session",
    secret: { bridgeSecret: "secret", botToken: token },
    pending: new Map(),
    socket: { destroyed: false, write: (line) => sent.push(JSON.parse(line)) },
  };
  const plain = requestQuestion(state, "Q?", ["Yes", "No"]);
  const widget = requestWidgetQuestion(state, "Q?", ["Yes", "No"], "<html></html>");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].type, "question");
  assert.equal(sent[0].widget, undefined);
  assert.equal(sent[1].type, "widgetQuestion");
  assert.equal(sent[1].widget, "<html></html>");
  assert.deepEqual(sent[1].options, ["Yes", "No"]);
  for (const [index, request] of [[0, plain], [1, widget]]) {
    client.handleClientMessage(state, { type: "result", requestId: sent[index].requestId, ok: true, questionId: "q", answer: "Yes" });
    assert.equal((await request).answer, "Yes");
  }
  assert.equal(state.pending.size, 0);
});

function toggleState(overrides = {}) {
  return {
    secret: { botToken: token, chatId: 42, allowedUserId: 7 },
    topics: new Map([["session", { sessionId: "session", threadId: 9 }]]),
    pendingQuestions: new Map([["12345678-1234-1234-1234-123456789abc", {
      questionId,
      requestId: "req",
      clientId: "client",
      sessionId: "session",
      threadId: 9,
      messageId: 90,
      question: "Which checks?",
      options: ["lint", "test", "build"],
      multiSelect: true,
      selected: [],
      ...overrides,
    }]]),
    persistQueue: Promise.resolve(),
  };
}

test("a multi-select question toggles options without answering until Done", async (t) => {
  const calls = mockWidget(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const state = toggleState();
  const delivered = [];
  const opts = {
    queuePersist: async () => {},
    deliverQuestionAnswer: (_state, _question, answer) => { delivered.push(answer); return true; },
    syncTopicDashboard: async () => {},
  };
  const tap = (data) => ({ id: `cb-${data}`, data, from: { id: 7 }, message: { message_id: 90, chat: { id: 42 } } });

  // Two toggles, then untoggle the second: the keyboard is redrawn each time, nothing is answered.
  for (const data of [`toggle:${questionId}:1`, `toggle:${questionId}:2`, `toggle:${questionId}:2`]) {
    await router.handleCallbackQuery(state, tap(data), opts);
  }
  assert.deepEqual(state.pendingQuestions.get(questionId).selected, [1]);
  assert.deepEqual(delivered, []);
  assert.equal(calls.filter((call) => call.url.endsWith("/editMessageReplyMarkup")).length, 3);
  const redraw = calls.filter((call) => call.url.endsWith("/editMessageReplyMarkup")).at(-1).body.reply_markup.inline_keyboard;
  assert.equal(redraw[1][0].text, "✓ test");
  assert.equal(redraw[3][0].text, "Done (1)");

  // Done answers with the selected labels in option order.
  await router.handleCallbackQuery(state, tap(`toggle:${questionId}:2`), opts);
  await router.handleCallbackQuery(state, tap(`qdone:${questionId}`), opts);
  assert.deepEqual(delivered, ["test, build"]);
  assert.equal(state.pendingQuestions.get(questionId).answer, "test, build");
});

test("Done refuses an empty multi-select and points out a single-answer question", async (t) => {
  mockWidget(t);
  const { __test: router } = require("../src/telegram/router.cjs");
  const state = toggleState();
  const delivered = [];
  const alerts = [];
  const opts = {
    queuePersist: async () => {},
    deliverQuestionAnswer: (_state, _question, answer) => { delivered.push(answer); return true; },
    syncTopicDashboard: async () => {},
  };
  const tap = (data) => ({ id: data, data, from: { id: 7 }, message: { message_id: 90, chat: { id: 42 } } });
  await router.handleCallbackQuery(state, tap(`qdone:${questionId}`), opts);
  assert.deepEqual(delivered, []);
  assert.equal(state.pendingQuestions.get(questionId).answer, undefined);

  // A toggle on a single-answer question is rejected instead of silently answering it.
  delete state.pendingQuestions.get(questionId).multiSelect;
  await router.handleCallbackQuery(state, tap(`toggle:${questionId}:0`), opts);
  assert.deepEqual(delivered, []);
});

test("toggle and Done callbacks are distinct from a plain question answer", () => {
  const { parseToggleCallback, parseQuestionDoneCallback, toggleKeyboard, toggleCallbackData, questionDoneCallbackData } = require("../src/telegram/questions.cjs");
  assert.equal(parseQuestionCallback(toggleCallbackData(questionId, 1)), undefined);
  assert.deepEqual(parseToggleCallback(toggleCallbackData(questionId, 1)), { questionId, optionIndex: 1 });
  assert.deepEqual(parseQuestionDoneCallback(questionDoneCallbackData(questionId)), { questionId });
  assert.equal(parseToggleCallback("question:" + questionId + ":1"), undefined);
  const keyboard = toggleKeyboard(questionId, ["a", "b"], [1]);
  assert.deepEqual(keyboard.inline_keyboard.map((row) => row[0].text), ["a", "✓ b", "Done (1)"]);
  assert.equal(keyboard.inline_keyboard.at(-1)[0].callback_data, `qdone:${questionId}`);
});

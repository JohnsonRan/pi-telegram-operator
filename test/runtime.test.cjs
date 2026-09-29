const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.resolve(__dirname, "../src/runtime.cjs");
const runtime = require(runtimePath);
const control = require("../src/telegram/control.cjs");
const { closeLeader, startLocalLeader, __test: brokerServerTest } = require("../src/broker/server.cjs");
const { pruneExpiredBrokerState } = require("../src/broker/state.cjs");
const liveStatus = require("../src/session/live-status.cjs");
const { splitMarkdown } = require("../src/telegram/format.cjs");
const { validateSettings } = require("../src/shared/settings.cjs");
const telegramApi = require("../src/telegram/api.cjs");
const { formatLocalTimestamp } = require("../src/shared/time.cjs");
const helpers = {
  ...control,
  ...brokerServerTest,
  ...liveStatus,
  ...telegramApi,
  closeLeader,
  formatLocalTimestamp,
  pruneExpiredBrokerState,
  startLocalLeader,
  validateSettings,
};

test("validates split secret/config settings", () => {
  const settings = helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    allowedUserId: 42,
    bridgeSecret: "b".repeat(64),
    port: 43871,
  });
  assert.equal(settings.chatId, 42);
  assert.equal(settings.port, 43871);
  assert.equal(settings.linkPreview, false);
  assert.equal(settings.apiBaseUrl, "https://api.telegram.org");
  assert.equal(helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    apiBaseUrl: "http://127.0.0.1:8081/tg/ ",
  }).apiBaseUrl, "http://127.0.0.1:8081/tg");
  assert.throws(() => helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    apiBaseUrl: "ftp://example.com",
  }), /apiBaseUrl/);
  const enabled = helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    linkPreview: true,
  });
  assert.equal(enabled.linkPreview, true);
  assert.throws(() => helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
  }), /wakeAllowedRoots/);
  const wake = helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
  });
  assert.equal(wake.wakeMode, true);
  assert.equal(wake.wakeOpenTerminal, true);
  assert.deepEqual(wake.wakeAllowedRoots, ["F:\\"]);
  const background = helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakeOpenTerminal: false,
  });
  assert.equal(background.wakeOpenTerminal, false);
  assert.throws(() => helpers.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
    wakeAllowedRoots: ["F:\\"],
    wakeOpenTerminal: "false",
  }), /wakeOpenTerminal must be a boolean/);
});

test("waits for foreground wake registration, stability, and stop state", async () => {
  const client = { wakeChild: true, registered: true, socket: { destroyed: false } };
  let running = true;
  const state = {
    clientsBySession: new Map(),
    wakeLauncher: { isRunning: () => running },
  };
  setTimeout(() => state.clientsBySession.set("session", client), 10);
  assert.equal(await helpers.waitForWakeRegistration(state, "session", 200), client);
  assert.equal(await helpers.waitForWakeRegistration(state, "missing", 10), undefined);
  assert.equal(await helpers.waitForWakeStability(state, "session", 10), true);
  running = false;
  assert.equal(await helpers.waitForWakeStability(state, "session", 10), false);
  assert.equal(await helpers.waitForWakeStop(state, "session", 10), true);
});

test("formats broker diagnostics for Telegram status using host-local time", () => {
  const startedAt = Date.parse("2026-01-02T03:04:05.000Z");
  const text = helpers.formatBrokerStatus({
    pid: 4321,
    packageVersion: "1.2.3",
    startedAt,
    clientsBySession: new Map([["one", {}]]),
    secret: { wakeOpenTerminal: true },
    wakeLauncher: { runningSessionIds: () => ["one", "two"] },
    topics: new Map([["one", {}], ["two", {}], ["three", {}]]),
  }, Date.parse("2026-01-03T05:07:08.000Z"));
  assert.match(text, /Broker PID: 4321/);
  assert.match(text, /Version: 1\.2\.3/);
  assert.ok(text.includes(`Started: ${helpers.formatLocalTimestamp(startedAt)}`));
  assert.match(helpers.formatLocalTimestamp(new Date(2026, 0, 2, 3, 4, 5)), /^2026-01-02 03:04:05 [+-]\d{2}:\d{2}$/);
  assert.match(text, /Uptime: 1d 2h 3m 3s/);
  assert.match(text, /Connected Pi sessions: 1/);
  assert.match(text, /Wake Pi sessions: 2/);
  assert.match(text, /Known topics: 3/);
});

test("builds Telegram control panels with inline buttons", () => {
  const state = {
    pid: 123,
    packageVersion: "1.0.0",
    startedAt: 1_000,
    clientsBySession: new Map(),
    secret: { wakeOpenTerminal: false },
    wakeLauncher: { runningSessionIds: () => [] },
    topics: new Map([["session-id", { sessionId: "session-id", name: "Demo", cwd: "C:\\Demo", createdAt: 1 }]]),
  };
  const status = helpers.controlPanel(state, "status", 2_000);
  assert.match(status.text, /Broker PID: 123/);
  assert.deepEqual(status.replyMarkup.inline_keyboard[0].map((item) => item.callback_data), ["control:status", "control:sessions"]);
  const sessions = helpers.controlPanel(state, "sessions");
  assert.match(sessions.text, /Demo · session-/);
  assert.match(helpers.controlPanel(state, "help").text, /\/clone <repository-url>/);
  assert.equal(sessions.replyMarkup.inline_keyboard[0][0].callback_data, "restore:session-id");
  assert.equal(helpers.parseControlCallback("control:help"), "help");
  assert.equal(helpers.parseControlCallback("control:unknown"), undefined);
  assert.equal(helpers.parseRestoreCallback("restore:12345678-1234-1234-1234-123456789abc"), "12345678-1234-1234-1234-123456789abc");
  assert.equal(helpers.parseRestoreCallback("restore:session-id"), undefined);
});

test("runs the exact Pi update command from All Topics", async () => {
  const originalFetch = global.fetch;
  const sent = [];
  const updateCalls = [];
  global.fetch = async (url, options) => {
    const method = url.split("/").pop();
    const body = JSON.parse(options.body);
    assert.equal(method, "sendMessage");
    sent.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  try {
    await helpers.handleControlMessage({
      secret: {
        token: `123456:${"a".repeat(32)}`,
        chatId: 42,
        wakePiCommand: "custom-pi",
        wakeDefaultCwd: "C:\\Work",
        linkPreview: false,
      },
      runPiUpdate: async (options) => {
        updateCalls.push(options);
        return "Updated everything";
      },
    }, { message_id: 9, text: "pi update --all" });
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepEqual(updateCalls, [{ piCommand: "custom-pi", cwd: "C:\\Work" }]);
  assert.match(sent[0].text, /Running pi update --all/);
  assert.match(sent[1].text, /Pi update completed/);
  assert.match(sent[1].text, /Updated everything/);
});

test("answers and applies authorized Telegram control callbacks", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const restored = [];
  global.fetch = async (url, options) => {
    calls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  const state = {
    pid: 123,
    packageVersion: "1.0.0",
    startedAt: Date.now(),
    clientsBySession: new Map(),
    secret: { botToken: `123456:${"a".repeat(32)}`, chatId: 42, allowedUserId: 7, wakeOpenTerminal: false },
    wakeLauncher: { runningSessionIds: () => [] },
    topics: new Map([["12345678-1234-1234-1234-123456789abc", {
      sessionId: "12345678-1234-1234-1234-123456789abc",
      threadId: 77,
      name: "Demo · 12345678",
      cwd: "C:\\Demo",
      createdAt: 1,
    }]]),
  };
  try {
    await helpers.handleCallbackQuery(state, {
      id: "callback-1",
      data: "control:status",
      from: { id: 7 },
      message: { message_id: 99, chat: { id: 42 } },
    });
    await helpers.handleCallbackQuery(state, {
      id: "callback-2",
      data: "control:status",
      from: { id: 8 },
      message: { message_id: 99, chat: { id: 42 } },
    });
    await helpers.handleCallbackQuery(state, {
      id: "callback-3",
      data: "restore:12345678-1234-1234-1234-123456789abc",
      from: { id: 7 },
      message: { message_id: 99, chat: { id: 42 } },
    }, {
      restoreSessionTopic: async (_state, topic) => restored.push(topic.sessionId),
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepEqual(calls.map((call) => call.method), [
    "answerCallbackQuery",
    "editMessageText",
    "answerCallbackQuery",
    "answerCallbackQuery",
  ]);
  assert.equal(calls[1].body.message_id, 99);
  assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data, "control:status");
  assert.equal(calls[2].body.show_alert, true);
  assert.equal(calls[3].body.show_alert, true);
  assert.match(calls[3].body.text, /cannot open topics automatically/);
  assert.deepEqual(restored, ["12345678-1234-1234-1234-123456789abc"]);
  assert.match(helpers.RESTORE_CONTEXT_PROMPT, /key decisions/);
  assert.match(helpers.RESTORE_CONTEXT_PROMPT, /Do not modify files or run tools/);
});

test("acknowledges accepted Telegram messages with a non-blocking reaction", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  try {
    const acknowledged = await helpers.acknowledgeTelegramMessage({
      secret: { botToken: `123456:${"a".repeat(32)}`, chatId: 42 },
    }, { message_id: 91 });
    assert.equal(acknowledged, true);
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepEqual(calls, [{
    method: "setMessageReaction",
    body: {
      chat_id: 42,
      message_id: 91,
      reaction: [{ type: "emoji", emoji: "👀" }],
      is_big: false,
    },
  }]);
});

test("reaction failures do not reject accepted Telegram message handling", async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  global.fetch = async () => { throw new Error("offline"); };
  console.warn = () => {};
  try {
    assert.equal(await helpers.acknowledgeTelegramMessage({
      secret: { botToken: `123456:${"a".repeat(32)}`, chatId: 42 },
    }, { message_id: 92 }), false);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("delivers Telegram question button answers to the matching session", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  const questionId = "12345678-1234-1234-1234-123456789abc";
  const sessionId = "87654321-4321-4321-4321-cba987654321";
  const delivered = [];
  const state = {
    secret: { token: `123456:${"a".repeat(32)}`, botToken: `123456:${"a".repeat(32)}`, chatId: 42, allowedUserId: 42 },
    pendingQuestions: new Map([[questionId, {
      questionId,
      sessionId,
      threadId: 701,
      messageId: 90,
      question: "Deploy?",
      options: ["Deploy", "Cancel"],
    }]]),
    topics: new Map([[sessionId, { sessionId, threadId: 701, cwd: "C:\\Work" }]]),
  };
  try {
    await helpers.handleCallbackQuery(state, {
      id: "callback-question",
      data: `question:${questionId}:0`,
      from: { id: 42 },
      message: { message_id: 90, message_thread_id: 701, chat: { id: 42 } },
    }, {
      queuePersist: async () => {},
      deliverQuestionAnswer: (_state, question, answer) => {
        assert.equal(question.sessionId, sessionId);
        delivered.push(answer);
        return true;
      },
      syncTopicDashboard: async () => {},
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepEqual(delivered, ["Deploy"]);
  assert.equal(state.pendingQuestions.size, 1);
  assert.equal(state.pendingQuestions.get(questionId).answer, "Deploy");
  assert.deepEqual(calls.map((call) => call.method), ["answerCallbackQuery", "editMessageText"]);
});

test("restore wakes the exact session with a context recap", async () => {
  const calls = [];
  const topic = {
    sessionId: "12345678-1234-1234-1234-123456789abc",
    threadId: 77,
    name: "Demo",
    cwd: process.cwd(),
  };
  const state = {
    wakeLauncher: { isRunning: () => false },
    wakeReservations: new Set(),
  };
  const options = {
    withTopicRetry: async (_state, sessionId, cwd, name, operation) => {
      assert.equal(sessionId, topic.sessionId);
      assert.equal(cwd, topic.cwd);
      assert.equal(name, topic.name);
      return operation(topic);
    },
    sendBrokerText: async (_state, text, sendOptions) => {
      calls.push({ type: "notice", text, options: sendOptions });
      return { message_id: 88 };
    },
    connectedTarget: () => undefined,
    queueTelegramReply: async () => assert.fail("a newly launched session should receive the recap as its startup prompt"),
    launchWakeSession: async (_state, launchedTopic, prompt, replyTo) => {
      calls.push({ type: "launch", topic: launchedTopic, prompt, replyTo });
      return { started: true, foreground: false };
    },
  };

  await helpers.restoreSessionTopic(state, topic, options);
  assert.equal(calls[0].options.threadId, 77);
  assert.match(calls[0].text, /cannot switch topics automatically/);
  assert.equal(calls[1].topic, topic);
  assert.equal(calls[1].prompt, helpers.RESTORE_CONTEXT_PROMPT);
  assert.equal(calls[1].replyTo, 88);
});

test("restore injects the recap into an already connected session", async () => {
  const queued = [];
  const topic = {
    sessionId: "12345678-1234-1234-1234-123456789abc",
    threadId: 77,
    name: "Demo",
    cwd: process.cwd(),
  };
  const state = {
    wakeLauncher: { isRunning: () => false },
    wakeReservations: new Set(),
  };

  await helpers.restoreSessionTopic(state, topic, {
    withTopicRetry: async (_state, _sessionId, _cwd, _name, operation) => operation(topic),
    sendBrokerText: async () => ({ message_id: 88 }),
    connectedTarget: () => ({ registered: true }),
    queueTelegramReply: async (_state, target, message, holdForWake) => {
      queued.push({ target, message, holdForWake });
      return { delivered: true };
    },
    launchWakeSession: async () => assert.fail("an already connected session should not be launched again"),
  });

  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].target, { sessionId: topic.sessionId, threadId: 77 });
  assert.equal(queued[0].message.text, helpers.RESTORE_CONTEXT_PROMPT);
  assert.equal(queued[0].message.message_id, 88);
  assert.equal(queued[0].holdForWake, undefined);
});

test("formats bounded wake process diagnostics for Telegram", () => {
  assert.equal(helpers.formatWakeExitDetail("\u001b[31mconfig failed\u001b[0m\n"), "config failed");
  const detail = helpers.formatWakeExitDetail("x".repeat(2000));
  assert.equal(detail.length, 1600);
  assert.ok(detail.startsWith("…"));
});

test("formats live main-agent and subagent progress", () => {
  assert.equal(helpers.summarizeToolArgs("read", { path: "src/runtime.cjs" }), "src/runtime.cjs");
  const text = helpers.formatLiveStatus({
    startedAt: 1_000,
    turnIndex: 1,
    toolName: "subagent",
    toolArgs: { workflowScript: "return await runs.run(...)" },
    partialResult: {
      details: {
        progress: [
          { index: 0, agent: "scout", status: "completed" },
          { index: 1, agent: "reviewer", status: "running", currentTool: "bash", currentPath: "test" },
        ],
      },
    },
  }, 13_500);
  assert.match(text, /Main agent · Turn 2 · 12s/);
  assert.match(text, /Subagents · 1\/2 done · 1 running/);
  assert.match(text, /✓ scout · completed/);
  assert.match(text, /⏳ reviewer · bash · test/);
});

test("maps Pi command names to Telegram-safe aliases and restores them", () => {
  const commands = helpers.normalizePiCommands([
    { name: "review", description: "Review code", source: "extension" },
    { name: "reload-runtime", description: "Reload", source: "extension" },
    { name: "skill:frontend-design", description: "Design", source: "skill" },
    { name: "status", description: "Pi status", source: "extension" },
    { name: "telegram-wake", description: "internal", source: "extension" },
  ]);
  assert.equal(commands.length, 4);
  assert.equal(commands[0].telegramName, "review");
  assert.equal(commands[1].telegramName, "reload_runtime");
  assert.notEqual(commands[3].telegramName, "status");
  const skill = commands.find((command) => command.name === "skill:frontend-design");
  assert.equal(helpers.translateTelegramCommand({ commands }, `/${skill.telegramName} mobile`), "/skill:frontend-design mobile");
});

test("builds stable topic names, chunks text, and rejects unthreaded fallback routing", () => {
  assert.equal(helpers.topicName("1234567890", "C:/work/demo", ""), "demo · 12345678");
  assert.equal(helpers.topicName("1234567890", "C:/work/demo", "demo · 12345678"), "demo · 12345678");
  const chunks = splitMarkdown("x".repeat(9000));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  const state = {
    topics: new Map(),
    mappings: new Map([[10, { messageId: 10, sessionId: "latest" }]]),
  };
  assert.equal(helpers.findReplyTarget(state, { text: "unthreaded" }), undefined);
  assert.equal(helpers.findReplyTarget(state, { reply_to_message: { message_id: 10 } }).sessionId, "latest");
});

test("prunes stale mappings and undelivered replies but retains topics", () => {
  const now = Date.now();
  const old = now - 31 * 24 * 60 * 60 * 1000;
  const fresh = now - 29 * 24 * 60 * 60 * 1000;
  const state = {
    mappings: new Map([[1, { createdAt: old }], [2, { createdAt: fresh }]]),
    pendingReplies: new Map([["old", { createdAt: old }], ["fresh", { createdAt: fresh }]]),
    topics: new Map([["session", { createdAt: old }]]),
  };
  assert.equal(helpers.pruneExpiredBrokerState(state, now), true);
  assert.deepEqual([...state.mappings.keys()], [2]);
  assert.deepEqual([...state.pendingReplies.keys()], ["fresh"]);
  assert.deepEqual([...state.topics.keys()], ["session"]);
  assert.equal(helpers.pruneExpiredBrokerState(state, now), false);
});

test("commits a Telegram update offset only after successful handling", async () => {
  const state = { offset: 10 };
  let persists = 0;
  await assert.rejects(helpers.processTelegramUpdate(state, {
    update_id: 10,
    message: { text: "retry me" },
  }, {
    handleTelegramMessage: async () => { throw new Error("temporary failure"); },
    queuePersist: async () => { persists += 1; },
  }), /temporary failure/);
  assert.equal(state.offset, 10);
  assert.equal(persists, 0);

  await helpers.processTelegramUpdate(state, {
    update_id: 10,
    message: { text: "retry me" },
  }, {
    handleTelegramMessage: async () => {},
    queuePersist: async () => { persists += 1; },
  });
  assert.equal(state.offset, 11);
  assert.equal(persists, 1);
});

test("closes broker clients before stopping the leader", async () => {
  let serverClosed = false;
  let closeAllCalled = false;
  let socketDestroyed = false;
  const socket = { destroy() { socketDestroyed = true; } };
  const state = {
    closed: false,
    pollController: { abort() { state.pollAborted = true; } },
    cleanupTimer: setInterval(() => {}, 10_000),
    pendingReplies: new Map([["pending", { retryTimer: setTimeout(() => {}, 10_000) }]]),
    clients: new Map([["client", { socket }]]),
    clientsBySession: new Map([["session", { socket }]]),
    server: {
      listening: true,
      close(callback) { serverClosed = true; this.listening = false; callback(); },
      closeAllConnections() { closeAllCalled = true; },
    },
  };
  await helpers.closeLeader(state);
  assert.equal(state.closed, true);
  assert.equal(state.pollAborted, true);
  assert.equal(socketDestroyed, true);
  assert.equal(serverClosed, true);
  assert.equal(closeAllCalled, true);
  assert.equal(state.clients.size, 0);
  assert.equal(state.clientsBySession.size, 0);
});

test("keeps the broker port until rich interaction work and persistence drain", async () => {
  let releaseTask;
  let releasePersist;
  let serverClosed = false;
  const activeTasks = new Set();
  const task = new Promise((resolve) => { releaseTask = resolve; });
  activeTasks.add(task);
  task.then(() => activeTasks.delete(task));
  const persistQueue = new Promise((resolve) => { releasePersist = resolve; });
  const state = {
    closed: false,
    pendingReplies: new Map(),
    clients: new Map(),
    clientsBySession: new Map(),
    activeTasks,
    streamQueues: new Map(),
    dashboardQueues: new Map(),
    persistQueue,
    server: {
      listening: true,
      close(callback) { serverClosed = true; this.listening = false; callback(); },
      closeAllConnections() {},
    },
  };
  const closing = helpers.closeLeader(state);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverClosed, false);
  releaseTask();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverClosed, false);
  releasePersist();
  await closing;
  assert.equal(serverClosed, true);
});

test("stream queue cleanup does not create an unhandled rejection", async () => {
  const state = { streamQueues: new Map() };
  const failure = helpers.enqueueStream(state, "session", async () => {
    throw new Error("rate limited");
  });
  await assert.rejects(failure, /rate limited/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.streamQueues.size, 0);
});

test("retries a Telegram rate limit once using retry_after", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const urls = [];
  global.fetch = async (url) => {
    calls += 1;
    urls.push(url);
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0 } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    const result = await helpers.telegramCall(
      { botToken: `123456:${"a".repeat(32)}`, apiBaseUrl: "http://127.0.0.1:8081" },
      "sendMessageDraft",
      { text: "status" },
    );
    assert.equal(result.message_id, 1);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls, 2);
  assert.equal(urls[0], `http://127.0.0.1:8081/bot123456:${"a".repeat(32)}/sendMessageDraft`);
});

test("falls back to plain text only after a deterministic Telegram Bad Request", async () => {
  const originalFetch = global.fetch;
  const payloads = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    await helpers.telegramFormattedCall(
      { botToken: `123456:${"a".repeat(32)}` },
      "sendMessage",
      { text: "<b>broken", parse_mode: "HTML" },
      "plain fallback",
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].parse_mode, "HTML");
  assert.equal(payloads[1].parse_mode, undefined);
  assert.equal(payloads[1].text, "plain fallback");
});

test("routes two Pi sessions through separate private topics and streams output", () => {
  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-operator-test-"));
fs.writeFileSync(path.join(dir, "pi-telegram-operator.secret"), "123456:${"a".repeat(32)}\n");
fs.writeFileSync(path.join(dir, "pi-telegram-operator.json"), JSON.stringify({ chatId: 42, allowedUserId: 42, bridgeSecret: "${"b".repeat(64)}", port: 43989, wakeMode: true, wakeDefaultCwd: dir, wakeAllowedRoots: [dir], wakeOpenTerminal: false }));
fs.writeFileSync(path.join(dir, "pi-telegram-operator.state.json"), JSON.stringify({ offset: 0, mappings: [], pendingReplies: [], topics: [] }));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_TELEGRAM_DAEMON = "1";

let nextThread = 700;
let nextMessage = 100;
let updatesSent = false;
const notificationByThread = new Map();
const notificationMessages = [];
const drafts = [];
const finalMessages = [];
const botCommandMenus = [];
const reactions = [];

global.fetch = async (url, options) => {
  const method = url.split("/").pop();
  const body = JSON.parse(options.body);
  if (method === "setMyCommands") {
    botCommandMenus.push(body.commands);
    return response(true);
  }
  if (method === "createForumTopic") {
    const threadId = ++nextThread;
    return response({ message_thread_id: threadId, name: body.name });
  }
  if (method === "sendMessageDraft") {
    drafts.push(body);
    return response(true);
  }
  if (method === "sendMessage") {
    const sent = { message_id: ++nextMessage, chat: { id: 42 }, message_thread_id: body.message_thread_id };
    if (body.parse_mode === "HTML" && body.reply_markup) {
      notificationByThread.set(body.message_thread_id, sent.message_id);
      notificationMessages.push(body);
    } else finalMessages.push(body);
    return response(sent);
  }
  if (method === "setMessageReaction") {
    reactions.push(body);
    return response(true);
  }
  if (["pinChatMessage", "editMessageText", "sendChatAction"].includes(method)) return response(true);
  if (method === "getUpdates") {
    if (!updatesSent && notificationByThread.size === 2) {
      updatesSent = true;
      const threads = [...notificationByThread.keys()].sort((a, b) => a - b);
      return response(threads.map((threadId, index) => ({
        update_id: index + 1,
        message: {
          message_id: 200 + index,
          message_thread_id: threadId,
          text: index === 0 ? "/ctx_stats" : "/status",
          chat: { id: 42 },
          from: { id: 42, is_bot: false },
        },
      })));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    return response([]);
  }
  throw new Error("Unexpected Telegram method: " + method);
};

function response(result) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}

function fakePi(name) {
  const handlers = new Map();
  const injected = [];
  return {
    handlers,
    injected,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    getSessionName() { return name; },
    getCommands() {
      return [
        { name: "ctx-stats", description: "Show context stats", source: "extension" },
        { name: "skill:frontend-design", description: "Design a frontend", source: "skill" },
        { name: "telegram-wake", description: "internal", source: "extension" },
      ];
    },
    sendUserMessage(text, options) { injected.push({ text, options }); },
  };
}

async function emit(pi, event, payload, ctx) {
  for (const handler of pi.handlers.get(event) || []) await handler(payload, ctx);
}

(async () => {
  const runtime = require(${JSON.stringify(runtimePath)});
  const pi1 = fakePi("Agent One");
  const pi2 = fakePi("Agent Two");
  const ctx1 = { cwd: "C:/repo/one", isIdle: () => true, sessionManager: { getSessionId: () => "session-one" } };
  const ctx2 = { cwd: "C:/repo/two", isIdle: () => true, sessionManager: { getSessionId: () => "session-two" } };
  runtime.attach(pi1);
  runtime.attach(pi2);
  await emit(pi1, "session_start", {}, ctx1);
  await emit(pi2, "session_start", {}, ctx2);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const start = { role: "assistant", content: [] };
  const partial = { role: "assistant", content: [{ type: "text", text: "Streaming hello" }] };
  await emit(pi1, "agent_start", {}, ctx1);
  await emit(pi1, "turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await emit(pi1, "tool_execution_start", { toolCallId: "sub-1", toolName: "subagent", args: { agent: "reviewer", task: "review it" } }, ctx1);
  await emit(pi1, "tool_execution_update", {
    toolCallId: "sub-1",
    toolName: "subagent",
    args: { agent: "reviewer", task: "review it" },
    partialResult: { details: { progress: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read", currentPath: "src/runtime.cjs" }] } },
  }, ctx1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await emit(pi1, "tool_execution_end", { toolCallId: "sub-1", toolName: "subagent", result: {}, isError: false }, ctx1);
  await emit(pi1, "message_start", { message: start }, ctx1);
  await emit(pi1, "message_update", { message: partial }, ctx1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await emit(pi1, "message_end", { message: partial }, ctx1);
  await emit(pi1, "agent_settled", {}, ctx1);

  await Promise.all([
    runtime.notify(pi1, ctx1, "Question <one>", "Reply **one**"),
    runtime.notify(pi2, ctx2, "Question two", "Reply two"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const state = JSON.parse(fs.readFileSync(path.join(dir, "pi-telegram-operator.state.json"), "utf8"));
  const result = {
    pi1: pi1.injected,
    pi2: pi2.injected,
    topicCount: state.topics.length,
    topicThreads: state.topics.map((topic) => topic.threadId).sort((a, b) => a - b),
    mappings: state.mappings.length,
    pendingReplies: state.pendingReplies.length,
    notificationMessages,
    drafts,
    finalMessages,
    botCommandMenus,
    reactions,
  };
  console.log(JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  assert.deepEqual(result.pi1.map((item) => item.text), ["/ctx-stats"]);
  assert.deepEqual(result.pi2.map((item) => item.text), ["/status"]);
  assert.equal(result.topicCount, 2);
  assert.deepEqual(result.topicThreads, [701, 702]);
  assert.equal(result.mappings, 0);
  assert.equal(result.pendingReplies, 0);
  assert.ok(result.notificationMessages.some((message) => message.parse_mode === "HTML" && message.link_preview_options?.is_disabled === true && message.text.includes("<b>Question &lt;one&gt;</b>") && message.text.includes("Reply <b>one</b>") && message.reply_markup.inline_keyboard[0][0].text === "Continue"));
  assert.ok(result.drafts.some((draft) => draft.text.includes("Main agent · Turn 1")));
  assert.ok(result.drafts.some((draft) => draft.text.includes("Subagents · 0/1 done · 1 running") && draft.text.includes("reviewer · read · src/runtime.cjs")));
  assert.ok(result.finalMessages.some((message) => message.parse_mode === "HTML" && message.link_preview_options?.is_disabled === true && message.text === "Streaming hello"));
  assert.ok(result.botCommandMenus.some((commands) => commands.some((command) => command.command === "new")));
  assert.ok(result.botCommandMenus.some((commands) => commands.some((command) => command.command === "ctx_stats")));
  assert.ok(result.botCommandMenus.every((commands) => commands.every((command) => command.command !== "telegram_wake")));
  assert.deepEqual(result.reactions.map((reaction) => reaction.message_id).sort((a, b) => a - b), [200, 201]);
  assert.ok(result.reactions.every((reaction) => reaction.reaction[0].emoji === "👀"));
  assert.equal(result.pi1[0].options.expandPromptTemplates, true);
});

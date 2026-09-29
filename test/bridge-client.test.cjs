const assert = require("node:assert/strict");
const test = require("node:test");
const { requestBroker, requestQuestion, __test: client } = require("../src/bridge/client.cjs");

function connectedState() {
  const written = [];
  return {
    written,
    closed: false,
    connected: true,
    sessionId: "session",
    secret: { bridgeSecret: "secret" },
    pending: new Map(),
    socket: { destroyed: false, write: (line) => written.push(JSON.parse(line)) },
  };
}

test("Stop control aborts the active turn through the extension context", () => {
  let aborted = 0;
  const state = { sessionId: "session", pi: {}, ctx: { abort: () => { aborted += 1; } } };
  client.handleClientMessage(state, { type: "control", sessionId: "session", action: "stop" });
  client.handleClientMessage(state, { type: "control", sessionId: "other", action: "stop" });
  assert.equal(aborted, 1);
});

test("a disconnect keeps questions waiting for the replayed answer", async () => {
  const state = connectedState();
  const question = requestQuestion(state, "Deploy?", ["Yes", "No"]);
  const notify = requestBroker(state, { type: "notify" }, "notify");
  await new Promise((resolve) => setImmediate(resolve));
  client.rejectPending(state, new Error("Telegram bridge disconnected"), false);
  await assert.rejects(notify, /disconnected/);
  assert.equal(state.pending.size, 1);

  const [sent] = state.written;
  client.handleClientMessage(state, { type: "result", requestId: sent.requestId, ok: true, questionId: "q", answer: "Yes" });
  assert.equal((await question).answer, "Yes");
  assert.equal(state.pending.size, 0);
  assert.equal(state.written.at(-1).type, "questionAck");
});

test("a superseded client does not reconnect on its own", () => {
  const state = { closed: false, superseded: false, reconnectTimer: undefined };
  client.handleClientMessage(state, { type: "superseded", sessionId: "session" });
  client.scheduleReconnect(state);
  assert.equal(state.superseded, true);
  assert.equal(state.reconnectTimer, undefined);
});

test("aborting the tool cancels a waiting question", async () => {
  const state = connectedState();
  const controller = new AbortController();
  const question = requestQuestion(state, "Deploy?", ["Yes"], controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(question, /cancelled by user/);
  assert.equal(state.pending.size, 0);
});

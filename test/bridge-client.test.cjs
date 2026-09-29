const assert = require("node:assert/strict");
const test = require("node:test");
const { __test: client } = require("../src/bridge/client.cjs");

test("Stop control aborts the active turn through the extension context", () => {
  let aborted = 0;
  const state = { sessionId: "session", pi: {}, ctx: { abort: () => { aborted += 1; } } };
  client.handleClientMessage(state, { type: "control", sessionId: "session", action: "stop" });
  client.handleClientMessage(state, { type: "control", sessionId: "other", action: "stop" });
  assert.equal(aborted, 1);
});

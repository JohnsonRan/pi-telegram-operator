const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

test("does not stream when Telegram settings cannot be loaded", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-unconfigured-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const connect = t.mock.method(net, "createConnection", () => assert.fail("must not connect without settings"));
  const { attach } = require("../src/runtime.cjs");
  const { getClientState } = require("../src/bridge/client.cjs");
  const token = `123456:${"a".repeat(32)}`;
  const config = JSON.stringify({ chatId: 42, bridgeSecret: "b".repeat(64) });

  for (const [name, secret, settings] of [
    ["missing settings"],
    ["missing config", token],
    ["missing secret", undefined, config],
    ["invalid JSON", token, "{"],
    ["invalid token", "invalid", config],
  ]) {
    await t.test(name, async (t) => {
      for (const [file, content] of [["secret", secret], ["json", settings]]) {
        const filePath = path.join(dir, `pi-telegram-operator.${file}`);
        if (content === undefined) fs.rmSync(filePath, { force: true });
        else fs.writeFileSync(filePath, content);
      }
      const warnings = t.mock.method(console, "warn", () => {});
      const handlers = new Map();
      const pi = {
        on(event, handler) {
          const list = handlers.get(event) || [];
          list.push(handler);
          handlers.set(event, list);
        },
      };
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => "unconfigured-session" } };
      const emit = async (event, payload = {}) => {
        for (const handler of handlers.get(event) || []) await handler(payload, ctx);
      };
      attach(pi);
      t.after(() => emit("session_shutdown"));
      await emit("session_start");
      assert.equal(warnings.mock.callCount(), 1);
      assert.match(warnings.mock.calls[0].arguments[0], /Cannot initialize:/);
      const state = getClientState(pi);
      assert.equal(state.secret, undefined);

      await emit("agent_start");
      const activity = state.agentActivity;
      const heartbeat = state.statusHeartbeat;
      await emit("turn_start", { turnIndex: 0 });
      const tool = { toolName: "read", args: { path: "README.md" } };
      for (const event of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) await emit(event, tool);
      const message = { role: "assistant", content: [{ type: "text", text: "Local reply" }] };
      await emit("message_start", { message });
      await emit("message_update", { message });
      const stream = state.currentStream;
      await emit("message_end", { message });
      await emit("agent_settled");
      // Let fire-and-forget stream sends and the finalization retry finish.
      await delay(600);

      assert.deepEqual(warnings.mock.calls.slice(1).map((call) => call.arguments[0]), []);
      assert.equal(activity, undefined);
      assert.equal(heartbeat, undefined);
      assert.equal(stream, undefined);
      assert.equal(connect.mock.callCount(), 0);
    });
  }
});

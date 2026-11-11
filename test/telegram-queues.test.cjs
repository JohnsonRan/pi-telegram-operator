const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-queues-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { readBrokerState } = require("../src/broker/state.cjs");
const { pollTelegram, __test: router } = require("../src/telegram/router.cjs");

const token = `123456:${"a".repeat(32)}`;
const secret = { botToken: token, chatId: 42, allowedUserId: 7 };

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

test("polling resumes the persisted offset, never a /beta one", async (t) => {
  for (const [name, stored, expected] of [
    ["both queues", { offset: 12, offsets: { plain: 12, beta: 9002 } }, 12],
    ["only beta", { offset: 9002, offsets: { beta: 9002 } }, 0],
    ["first run", {}, 0],
    ["plain offset zero", { offsets: { plain: 0, beta: 9002 } }, 0],
    ["legacy plain offset", { offset: 42 }, 42],
  ]) {
    await t.test(name, async (t) => {
      const statePath = path.join(agentDir, "state.json");
      fs.writeFileSync(statePath, JSON.stringify(stored));
      const state = { ...await readBrokerState(statePath), secret };
      const calls = [];
      t.mock.method(global, "fetch", async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        state.closed = true;
        return new Response(JSON.stringify({ ok: true, result: [] }));
      });

      await pollTelegram(state);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/getUpdates`);
      assert.equal(calls[0].body.offset, expected);
      assert.ok(calls[0].body.allowed_updates.includes("widget_query"));
      assert.equal(state.pollController, undefined);
    });
  }
});

test("stable polling keeps a custom API base URL unchanged", async (t) => {
  const state = { secret: { ...secret, apiBaseUrl: "http://localhost:8081/custom" }, offset: 5 };
  let called;
  t.mock.method(global, "fetch", async (url, init) => {
    called = { url: String(url), body: JSON.parse(init.body) };
    state.closed = true;
    return new Response(JSON.stringify({ ok: true, result: [] }));
  });
  await pollTelegram(state);
  assert.equal(called.url, `http://localhost:8081/custom/bot${token}/getUpdates`);
  assert.equal(called.body.offset, 5);
});

test("updates advance the offset and never move it backwards", async () => {
  const state = { offset: 500 };
  const handled = [];
  const options = {
    handleTelegramMessage: async (_state, message) => handled.push(message.text),
    queuePersist: async () => {},
  };

  await router.processTelegramUpdate(state, { update_id: 501, message: { text: "pending on stable" } }, options);
  await router.processTelegramUpdate(state, { update_id: 500, message: { text: "older update" } }, options);

  assert.deepEqual(handled, ["pending on stable", "older update"]);
  assert.equal(state.offset, 502);
});

test("widget_query updates are dispatched before the offset is persisted", async () => {
  const state = {};
  const query = { id: "q", type: { type: "data" }, data: "refresh" };
  const handled = [];
  await router.processTelegramUpdate(state, { update_id: 7, widget_query: query }, {
    handleWidgetQuery: async (_state, received) => {
      assert.equal(state.offset, undefined);
      handled.push(received);
    },
    queuePersist: async () => { assert.equal(state.offset, 8); },
  });
  assert.deepEqual(handled, [query]);
});

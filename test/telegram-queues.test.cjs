const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// queuePersist writes the broker state file; keep it out of the real agent dir.
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-queues-"));

const { telegramBetaCallRouted } = require("../src/telegram/api.cjs");
const { __test: router } = require("../src/telegram/router.cjs");

const token = `123456:${"a".repeat(32)}`;
const secret = { botToken: token, chatId: 42, allowedUserId: 7 };

function mockFetch(t, respond) {
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    const call = { url: String(url), body: JSON.parse(init.body) };
    calls.push(call);
    const body = respond(call);
    return new Response(JSON.stringify(body), { status: body.error_code || 200 });
  });
  return calls;
}

// /beta and the plain API keep separate getUpdates queues with unrelated update_id ranges.
// One shared offset made pollers skip a queue entirely or replay dead backlog.
test("each Telegram queue keeps its own offset", async (t) => {
  const state = { offsets: { plain: 500 }, persistQueue: Promise.resolve() };
  const handled = [];
  const options = {
    handleTelegramMessage: async (_state, message) => handled.push(message.text),
    queuePersist: async () => {},
  };

  await router.processTelegramUpdate(state, { update_id: 9001, message: { text: "from beta" } }, { ...options, queue: "beta" });
  await router.processTelegramUpdate(state, { update_id: 501, message: { text: "from plain" } }, { ...options, queue: "plain" });

  assert.deepEqual(handled, ["from beta", "from plain"]);
  assert.deepEqual(state.offsets, { plain: 502, beta: 9002 });
});

test("an unknown queue is primed with -1 instead of replaying its backlog", async (t) => {
  const calls = mockFetch(t, () => ({ ok: true, result: [] }));
  const state = { offsets: {}, persistQueue: Promise.resolve() };

  await telegramBetaCallRouted(secret, "getUpdates", (beta) => router.pollPayload(state, beta), 1_000);

  // /beta answers first, so the priming request goes there.
  assert.equal(calls[0].url, `https://api.telegram.org/beta/bot${token}/getUpdates`);
  assert.equal(calls[0].body.offset, -1);
  assert.equal(calls[0].body.limit, 1);

  // Once a queue has an offset, polling uses it normally.
  state.offsets.beta = 700;
  await telegramBetaCallRouted(secret, "getUpdates", (beta) => router.pollPayload(state, beta), 1_000);
  assert.equal(calls[1].body.offset, 700);
  assert.equal(calls[1].body.limit, 100);
});

test("a queue cannot borrow the other queue's offset", async (t) => {
  const calls = mockFetch(t, () => ({ ok: true, result: [] }));
  const state = { offsets: { beta: 700 }, persistQueue: Promise.resolve() };

  await telegramBetaCallRouted(secret, "getUpdates", (beta) => router.pollPayload(state, beta), 1_000);

  assert.equal(calls[0].body.offset, 700);
  // The plain payload for the same poll must not see beta's 700.
  assert.equal(router.pollPayload(state, false).offset, -1);
  assert.equal(router.pollPayload(state, true).offset, 700);
});

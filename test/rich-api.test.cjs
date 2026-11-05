const assert = require("node:assert/strict");
const test = require("node:test");

const { telegramRichCall } = require("../src/telegram/api.cjs");

const secret = { botToken: `123456:${"a".repeat(32)}` };
const ok = { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
const rich = { rich_message: { markdown: "**hi**" }, chat_id: 1 };

async function withFetch(stub, run) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return stub(calls.length, url, options);
  };
  try {
    return { calls, value: await run() };
  } finally {
    global.fetch = original;
  }
}

test("a 400 falls back to legacy and keeps rich messages enabled", async () => {
  let legacy = 0;
  const { calls, value } = await withFetch(
    (index) => (index === 1
      ? { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: RICH_MESSAGE_MARKDOWN_INVALID" }) }
      : ok),
    () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => { legacy += 1; return "legacy1"; }),
  );
  assert.equal(value, "legacy1");
  assert.equal(legacy, 1);
  // Rich stays enabled: the next call tries sendRichMessage first again.
  const again = await withFetch(() => ok, () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => "legacy2"));
  assert.equal(again.value.message_id, 1);
  assert.equal(again.calls.length, 1);
  void calls;
});

test("a server error is rethrown and legacy is not attempted", async () => {
  let legacy = 0;
  await assert.rejects(
    withFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, description: "Internal Server Error" }) }),
      () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => { legacy += 1; })),
    /Internal Server Error/,
  );
  assert.equal(legacy, 0);
});

test("empty markdown goes straight to legacy without any fetch", async () => {
  let legacy = 0;
  const { calls, value } = await withFetch(() => ok, () => telegramRichCall(
    secret, "sendRichMessage", { rich_message: { markdown: "  " }, chat_id: 1 }, () => { legacy += 1; return "legacy"; },
  ));
  assert.equal(value, "legacy");
  assert.equal(legacy, 1);
  assert.equal(calls.length, 0);
});

test("files send as multipart with a JSON rich_message and named attachments", async () => {
  const { calls, value } = await withFetch((_index, _url, options) => {
    assert.ok(options.body instanceof FormData);
    return ok;
  }, () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => "legacy", [
    { field: "m0", data: Buffer.from("png"), name: "chart.png" },
  ]));
  assert.equal(value.message_id, 1);
  assert.equal(calls.length, 1);
  const body = calls[0].options.body;
  assert.equal(body.get("rich_message"), JSON.stringify({ markdown: "**hi**" }));
  assert.equal(body.get("chat_id"), "1");
  assert.equal(await new Response(body.get("m0")).text(), "png");
});

test("multipart 429 waits once and retries the same form", async () => {
  const { calls, value } = await withFetch(
    (index) => (index === 1
      ? { ok: false, status: 429, json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0 } }) }
      : ok),
    () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => "legacy", [
      { field: "m0", data: Buffer.from("png"), name: "chart.png" },
    ]),
  );
  assert.equal(value.message_id, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.body === calls[1].options.body, "the FormData body is reused");
});

// Runs last on purpose: a 404 latches richUnsupported for the whole process.
test("a 404 falls back to legacy and disables rich messages process-wide", async () => {
  const first = await withFetch(
    () => ({ ok: false, status: 404, json: async () => ({ ok: false, description: "Not Found" }) }),
    () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => "legacy1"),
  );
  assert.equal(first.value, "legacy1");
  assert.equal(first.calls.length, 1);
  const second = await withFetch(() => ok, () => telegramRichCall(secret, "sendRichMessage", { ...rich }, () => "legacy2"));
  assert.equal(second.value, "legacy2");
  assert.equal(second.calls.length, 0, "rich path skipped entirely after the 404");
});

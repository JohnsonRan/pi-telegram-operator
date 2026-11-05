const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { prepareRichDraft, prepareRichMarkdown, richThinking } = require("../src/telegram/format.cjs");
const { richLocalMedia } = require("../src/telegram/files.cjs");

test("keeps balanced inline formatting tags and escapes unbalanced or unsupported ones", () => {
  assert.equal(
    prepareRichMarkdown("<details><summary>S</summary>x</details> a<br>b <u>u</u> <sup>2</sup>"),
    "<details><summary>S</summary>x</details> a<br>b <u>u</u> <sup>2</sup>",
  );
  assert.equal(prepareRichMarkdown("Wrap it in a <b> tag"), "Wrap it in a &lt;b> tag");
  assert.equal(prepareRichMarkdown("<blink>x</blink> <!-- c -->"), "&lt;blink>x&lt;/blink> &lt;!-- c -->");
  assert.equal(prepareRichMarkdown("<https://t.me> and `<p>`"), "<https://t.me> and `<p>`");
});

test("prose that discusses HTML comes through as text", () => {
  const prose = [
    "Wrap it in <p>...</p> and use <pre><code>.",
    "The <img src=x> tag needs alt; put <input> inside <table>.",
    "Use <a href=\"/x\">link</a>, <ul><li>item</li></ul> or <h1>Title</h1>, then <hr>.",
  ].join("\n");
  const prepared = prepareRichMarkdown(prose);
  assert.doesNotMatch(prepared, /<(?!\/?(?:b|i|u|s|br|details|summary)\b)[A-Za-z/]/);
  assert.equal(prepared.replace(/&lt;/g, "<"), prose);
});

test("rebuilds safe buttons canonically and disables the rest", () => {
  assert.equal(
    prepareRichMarkdown('<tg-button-row><tg-button type="url" url="https://t.me">a</tg-button><tg-button type="callback_data" data="ctl:stop">b</tg-button></tg-button-row>'),
    '<tg-button-row><tg-button type="url" url="https://t.me">a</tg-button><tg-button type="disabled">b</tg-button></tg-button-row>',
  );
  // A second safe-looking type must not smuggle callback data through.
  assert.equal(
    prepareRichMarkdown('<tg-button type="callback_data" data="ctl:stop" type="url">Stop</tg-button>'),
    '<tg-button type="disabled">Stop</tg-button>',
  );
  assert.equal(
    prepareRichMarkdown('<tg-button type="url" url="https://t.me" data="session:x:stop">x</tg-button>'),
    '<tg-button type="url" url="https://t.me">x</tg-button>',
  );
  // Valid buttons are rebuilt with only their own attributes.
  assert.equal(
    prepareRichMarkdown('<tg-button type="copy_text" style="success" text="copy me">Copy</tg-button>'),
    '<tg-button type="copy_text" style="success" text="copy me">Copy</tg-button>',
  );
  assert.equal(
    prepareRichMarkdown('<tg-button type="url" style="danger" url="https://a.io/?x=1&y=2" bogus="1">Go</tg-button>'),
    '<tg-button type="url" style="danger" url="https://a.io/?x=1&amp;y=2">Go</tg-button>',
  );
  // An unknown or missing style is dropped, not passed through.
  assert.equal(
    prepareRichMarkdown('<tg-button type="url" style="evil" url="https://t.me">x</tg-button>'),
    '<tg-button type="url" url="https://t.me">x</tg-button>',
  );
  // A url button without a usable url cannot render; disable it instead of failing the message.
  assert.equal(
    prepareRichMarkdown('<tg-button type="url" url="javascript:alert(1)">x</tg-button>'),
    '<tg-button type="disabled">x</tg-button>',
  );
});

test("drafts replace local images and status becomes a thinking block", () => {
  assert.equal(prepareRichDraft("![chart](./out/chart.png) ![](https://x.dev/a.png)"), "*chart* ![](https://x.dev/a.png)");
  assert.equal(richThinking("Turn 1\nTool · bash <x>"), "<tg-thinking>Turn 1<br>Tool · bash &lt;x&gt;</tg-thinking>");
});

test("uploads local images inside the session cwd and leaves other paths alone", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rich-media-"));
  try {
    fs.writeFileSync(path.join(cwd, "chart.png"), "png");
    fs.writeFileSync(path.join(cwd, "clip.mp4"), "mp4");
    fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    const result = await richLocalMedia(
      { cwd },
      '![a](chart.png "Cap") ![b](./clip.mp4) ![c](../secret.png) ![](.env) ![d](https://x.dev/a.png)\n`![e](chart.png)`',
    );
    assert.equal(result.markdown, '![a](tg://photo?id=m0 "Cap") ![b](tg://video?id=m1) *c* *\\.env* ![d](https://x.dev/a.png)\n`![e](chart.png)`');
    assert.deepEqual(result.media, [
      { id: "m0", media: { type: "photo", media: "attach://m0" } },
      { id: "m1", media: { type: "video", media: "attach://m1" } },
    ]);
    assert.deepEqual(result.files.map((file) => [file.field, file.name, String(file.data)]), [["m0", "chart.png", "png"], ["m1", "clip.mp4", "mp4"]]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

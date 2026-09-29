const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  attachmentFromMessage,
  downloadTelegramAttachment,
  safeFileName,
  sendSessionArtifact,
} = require("../src/telegram/files.cjs");

const secret = { botToken: `123456:${"a".repeat(32)}`, chatId: 42 };

test("selects Telegram documents and highest-resolution photos safely", () => {
  assert.equal(safeFileName("../bad:name?.log"), "bad_name_.log");
  assert.deepEqual(attachmentFromMessage({ document: {
    file_id: "doc-1", file_name: "build.log", file_size: 10, mime_type: "text/plain",
  } }), {
    fileId: "doc-1", fileName: "build.log", fileSize: 10, mimeType: "text/plain",
  });
  assert.equal(attachmentFromMessage({ message_id: 9, photo: [{ file_id: "small" }, { file_id: "large" }] }).fileId, "large");
});

test("downloads an authorized Telegram attachment into the session inbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-file-"));
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/build.log" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("build failed\n", { status: 200 });
  };
  try {
    const result = await downloadTelegramAttachment(secret, {
      message_id: 7,
      document: { file_id: "doc-1", file_name: "build.log", file_size: 13, mime_type: "text/plain" },
    }, { cwd: root });
    assert.equal(calls, 2);
    assert.match(result.relativePath, /^\.pi-telegram[\\/]inbox[\\/].*-build\.log$/);
    assert.equal(await readFile(result.path, "utf8"), "build failed\n");
    assert.equal(await readFile(path.join(root, ".pi-telegram", ".gitignore"), "utf8"), "*\n");
  } finally {
    global.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a session inbox symlink or Windows junction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-link-outside-"));
  try {
    await mkdir(path.join(root, ".pi-telegram"));
    await symlink(outside, path.join(root, ".pi-telegram", "inbox"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => downloadTelegramAttachment(secret, {
      document: { file_id: "doc-1", file_name: "escape.txt", file_size: 4 },
    }, { cwd: root }), /symbolic link|junction|outside/);
    await assert.rejects(() => readFile(path.join(outside, "escape.txt")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("uploads session artifacts as documents or photos and rejects outside paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-artifact-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-outside-"));
  const originalFetch = global.fetch;
  const methods = [];
  global.fetch = async (url, options) => {
    methods.push({ method: String(url).split("/").pop(), form: options.body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: methods.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await writeFile(path.join(root, "report.txt"), "report");
    await mkdir(path.join(root, "images"));
    await writeFile(path.join(root, "images", "screen.png"), "png");
    await writeFile(path.join(root, "images", "large.png"), "png");
    await truncate(path.join(root, "images", "large.png"), 10 * 1024 * 1024 + 1);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const topic = { cwd: root, threadId: 700 };
    await sendSessionArtifact(secret, topic, "report.txt", "Report");
    await sendSessionArtifact(secret, topic, "images/screen.png", "Screenshot");
    await sendSessionArtifact(secret, topic, "images/large.png", "Large screenshot");
    assert.deepEqual(methods.map((item) => item.method), ["sendDocument", "sendPhoto", "sendDocument"]);
    assert.equal(methods[0].form.get("message_thread_id"), "700");
    assert.equal(methods[0].form.get("caption"), "Report");
    await assert.rejects(() => sendSessionArtifact(secret, topic, path.join(outside, "secret.txt")), /inside the session/);
  } finally {
    global.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

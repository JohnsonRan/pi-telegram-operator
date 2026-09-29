const { randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { lstat, mkdir, open, realpath, rename, unlink } = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { isPathInside } = require("../shared/paths.cjs");
const { telegramCall, telegramMultipartCall } = require("./api.cjs");

const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function safeFileName(value, fallback = "attachment") {
  const base = path.basename(String(value || fallback))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return base && base !== "." && base !== ".." ? base : fallback;
}

function attachmentFromMessage(message) {
  if (message?.document?.file_id) {
    return {
      fileId: message.document.file_id,
      fileName: safeFileName(message.document.file_name, "document"),
      fileSize: Number(message.document.file_size),
      mimeType: String(message.document.mime_type || "application/octet-stream"),
    };
  }
  const photos = Array.isArray(message?.photo) ? message.photo.filter((item) => item?.file_id) : [];
  const photo = photos[photos.length - 1];
  if (!photo) return undefined;
  return {
    fileId: photo.file_id,
    fileName: `photo-${message.message_id || Date.now()}.jpg`,
    fileSize: Number(photo.file_size),
    mimeType: "image/jpeg",
  };
}

async function downloadTelegramAttachment(secret, message, topic) {
  const attachment = attachmentFromMessage(message);
  if (!attachment) return undefined;
  if (Number.isFinite(attachment.fileSize) && attachment.fileSize > MAX_INBOUND_FILE_BYTES) {
    throw new Error("Telegram attachment exceeds the 20 MiB download limit");
  }
  const cwd = await realpath(topic.cwd);
  const storage = path.join(cwd, ".pi-telegram");
  const inbox = path.join(storage, "inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  for (const directory of [storage, inbox]) {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error("Telegram attachment inbox cannot be a symbolic link or junction");
  }
  const canonicalInbox = await realpath(inbox);
  if (!isPathInside(cwd, canonicalInbox)) throw new Error("Telegram attachment inbox resolves outside the session working directory");
  const fileInfo = await telegramCall(secret, "getFile", { file_id: attachment.fileId });
  if (!fileInfo?.file_path) throw new Error("Telegram did not return an attachment file path");
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFileName(attachment.fileName)}`;
  const destination = path.join(canonicalInbox, fileName);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${secret.botToken}/${fileInfo.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_INBOUND_FILE_BYTES ? new Error("Telegram attachment exceeds the 20 MiB download limit") : undefined, chunk);
      },
    });
    if (await realpath(inbox) !== canonicalInbox) throw new Error("Telegram attachment inbox changed during download");
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if (await realpath(inbox) !== canonicalInbox) throw new Error("Telegram attachment inbox changed during download");
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new Error(`Cannot download Telegram attachment: ${error.message}`);
  }
  return {
    path: destination,
    relativePath: path.relative(cwd, destination),
    mimeType: attachment.mimeType,
    fileName,
  };
}

async function sendSessionArtifact(secret, topic, requestedPath, caption = "") {
  const cwd = await realpath(topic.cwd);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(cwd, requestedPath);
  const file = await realpath(candidate).catch(() => undefined);
  if (!file || !isPathInside(cwd, file)) throw new Error("Artifact path must be an existing file inside the session working directory");
  const handle = await open(candidate, "r").catch(() => undefined);
  if (!handle) throw new Error("Artifact path cannot be opened");
  let info;
  let data;
  try {
    const reopened = await realpath(candidate).catch(() => undefined);
    if (reopened !== file) throw new Error("Artifact path changed during validation");
    info = await handle.stat();
    if (!info.isFile()) throw new Error("Artifact path is not a regular file");
    if (info.size > MAX_OUTBOUND_FILE_BYTES) throw new Error("Artifact exceeds the 50 MiB upload limit");
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  const extension = path.extname(file).toLowerCase();
  const makeForm = (field) => {
    const form = new FormData();
    form.set("chat_id", String(secret.chatId));
    form.set("message_thread_id", String(topic.threadId));
    form.set(field, new Blob([data]), path.basename(file));
    if (String(caption).trim()) form.set("caption", String(caption).slice(0, 1024));
    return form;
  };
  if (IMAGE_EXTENSIONS.has(extension) && info.size <= MAX_PHOTO_BYTES) {
    try {
      return await telegramMultipartCall(secret, "sendPhoto", makeForm("photo"));
    } catch (error) {
      if (!/Bad Request|PHOTO_|image|dimension|aspect ratio/i.test(error.message)) throw error;
    }
  }
  return telegramMultipartCall(secret, "sendDocument", makeForm("document"));
}

module.exports = Object.freeze({
  MAX_INBOUND_FILE_BYTES,
  MAX_OUTBOUND_FILE_BYTES,
  attachmentFromMessage,
  downloadTelegramAttachment,
  safeFileName,
  sendSessionArtifact,
});

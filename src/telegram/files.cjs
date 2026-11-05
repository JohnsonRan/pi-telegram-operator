const { randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { lstat, mkdir, open, realpath, rename, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { isPathInside } = require("../shared/paths.cjs");
const { fileURLToPath } = require("node:url");
const { telegramCall, telegramMultipartCall, telegramUrl } = require("./api.cjs");
const { isRemoteUrl, localImageText, mapImages } = require("./format.cjs");

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
  // Keep received files out of the user's commits.
  await writeFile(path.join(storage, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const fileInfo = await telegramCall(secret, "getFile", { file_id: attachment.fileId });
  if (!fileInfo?.file_path) throw new Error("Telegram did not return an attachment file path");
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFileName(attachment.fileName)}`;
  const destination = path.join(canonicalInbox, fileName);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let response;
  try {
    response = await fetch(telegramUrl(secret, `file/bot${secret.botToken}/${fileInfo.file_path}`), {
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
    throw new Error(`Cannot download Telegram attachment: ${String(error.message).split(secret.botToken).join("<bot-token>")}`);
  }
  return {
    path: destination,
    relativePath: path.relative(cwd, destination),
    mimeType: attachment.mimeType,
    fileName,
  };
}

// Reads a regular file inside the session cwd, guarding against symlink and swap tricks.
async function readSessionFile(topic, requestedPath, maxBytes = MAX_OUTBOUND_FILE_BYTES) {
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
    if (info.size > maxBytes) throw new Error(`Artifact exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB upload limit`);
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  return { file, data, size: info.size };
}

// Only real media: a Markdown image pointing at .env, a log or an archive is never uploaded.
const MAX_RICH_MEDIA_BYTES = 20 * 1024 * 1024;
const RICH_MEDIA_TYPES = [
  { pattern: /\.(?:jpe?g|png|webp)$/i, type: "photo", link: "photo", maxBytes: MAX_PHOTO_BYTES },
  { pattern: /\.gif$/i, type: "animation", link: "video", maxBytes: MAX_RICH_MEDIA_BYTES },
  { pattern: /\.(?:mp4|mov|webm)$/i, type: "video", link: "video", maxBytes: MAX_RICH_MEDIA_BYTES },
  { pattern: /\.(?:ogg|oga|opus)$/i, type: "voice_note", link: "audio", maxBytes: MAX_RICH_MEDIA_BYTES },
  { pattern: /\.(?:mp3|m4a|flac|wav|aac)$/i, type: "audio", link: "audio", maxBytes: MAX_RICH_MEDIA_BYTES },
];
const MAX_RICH_MEDIA_FILES = 10;

// Uploads local Markdown images (`![alt](./chart.png)`) inside the session cwd with a rich
// message. Returns the rewritten Markdown, its media list and the files to attach. Other
// local images become their caption, since Telegram would reject the whole message.
// `uploaded` maps a url to the file_id Telegram returned for it in an earlier piece of the
// same reply, so a long reply that shows one chart twice uploads it once.
async function richLocalMedia(topic, markdown, uploaded = new Map()) {
  const urls = new Set();
  mapImages(markdown, (_alt, url) => { if (!isRemoteUrl(url)) urls.add(url); });
  const found = new Map();
  for (const url of urls) {
    if (found.size >= MAX_RICH_MEDIA_FILES) break;
    const known = uploaded.get(url);
    if (known) {
      found.set(url, { ...known, id: `m${found.size}` });
      continue;
    }
    let requested = url;
    try {
      requested = /^file:/i.test(url) ? fileURLToPath(url) : decodeURI(url);
    } catch {}
    const kind = RICH_MEDIA_TYPES.find((candidate) => candidate.pattern.test(requested));
    if (!kind) continue;
    const read = await readSessionFile(topic, requested, kind.maxBytes).catch(() => undefined);
    // Check the resolved name as well, so a chart.png symlink cannot upload .env.
    if (read && kind.pattern.test(read.file)) found.set(url, { ...read, id: `m${found.size}`, type: kind.type, link: kind.link });
  }
  const media = [...found.values()];
  const order = [];
  return {
    markdown: mapImages(markdown, (alt, url, title) => {
      if (isRemoteUrl(url)) return undefined;
      const item = found.get(url);
      if (!item) return localImageText(alt, url);
      order.push(url);
      return `![${alt}](tg://${item.link}?id=${item.id}${title})`;
    }),
    media: media.map((item) => ({ id: item.id, media: { type: item.type, media: item.fileId || `attach://${item.id}` } })),
    files: media.filter((item) => !item.fileId).map((item) => ({ field: item.id, data: item.data, name: path.basename(item.file) })),
    // Records the file_ids of a sent piece. Media blocks come back in document order; when
    // their count differs from our references (a nested or dropped block) nothing is cached.
    remember(sent) {
      const fileIds = [];
      const walk = (value) => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (!value || typeof value !== "object") return;
        const file = Array.isArray(value.photo) ? value.photo[value.photo.length - 1] : value[value.type];
        if (["photo", "animation", "video", "audio", "voice_note"].includes(value.type) && file?.file_id) fileIds.push(file.file_id);
        for (const key of ["blocks", "items", "cells"]) if (value[key]) walk(value[key]);
      };
      walk(sent?.rich_message?.blocks);
      if (fileIds.length !== order.length) return;
      order.forEach((url, index) => {
        const item = found.get(url);
        uploaded.set(url, { type: item.type, link: item.link, fileId: fileIds[index] });
      });
    },
  };
}

async function sendSessionArtifact(secret, topic, requestedPath, caption = "") {
  const { file, data, size } = await readSessionFile(topic, requestedPath);
  const extension = path.extname(file).toLowerCase();
  const makeForm = (field) => {
    const form = new FormData();
    form.set("chat_id", String(secret.chatId));
    form.set("message_thread_id", String(topic.threadId));
    form.set(field, new Blob([data]), path.basename(file));
    if (String(caption).trim()) form.set("caption", String(caption).slice(0, 1024));
    return form;
  };
  if (IMAGE_EXTENSIONS.has(extension) && size <= MAX_PHOTO_BYTES) {
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
  richLocalMedia,
  safeFileName,
  sendSessionArtifact,
});

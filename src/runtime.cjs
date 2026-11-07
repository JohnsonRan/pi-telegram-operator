#!/usr/bin/env node

/**
 * TelegraPi runtime for Pi.
 *
 * Pi processes share one localhost broker. The broker owns Telegram long polling,
 * while each connected Pi process injects replies with pi.sendUserMessage().
 */

const { deflateSync } = require("node:zlib");
const { initializeState, requestArtifact, requestNotification, requestQuestion, requestWidget, requestWidgetData } = require("./bridge/client.cjs");
const { closeLeader, startLocalLeader } = require("./broker/server.cjs");
const { readSettings: readSecret } = require("./shared/settings.cjs");
const { attach } = require("./session/streaming.cjs");
const { warn } = require("./shared/errors.cjs");

async function notify(pi, ctx, title, body) {
  await requestNotification(await initializeState(pi, ctx), title, body);
}

async function askQuestion(pi, ctx, question, options, signal) {
  const result = await requestQuestion(await initializeState(pi, ctx), question, options, signal);
  return String(result.answer || "");
}

async function sendFile(pi, ctx, filePath, caption = "") {
  await requestArtifact(await initializeState(pi, ctx), filePath, caption);
}

// Telegram refuses widgets over 32768 bytes of HTML or 4096 bytes after zlib level 9;
// checking here tells the model by how much it is over.
function checkWidgetSize(html) {
  const raw = Buffer.byteLength(html);
  const packed = deflateSync(html, { level: 9 }).length;
  if (raw > 32_768 || packed > 4_096) {
    throw new Error(`Widget HTML is ${raw} bytes, ${packed} compressed; the limits are 32768 and 4096 (zlib level 9)`);
  }
}

async function sendWidget(pi, ctx, widget) {
  checkWidgetSize(widget.html);
  const result = await requestWidget(await initializeState(pi, ctx), widget);
  return result.messageId;
}

async function updateWidget(pi, ctx, messageId, data) {
  await requestWidgetData(await initializeState(pi, ctx), messageId, data);
}

async function runWakeDaemon() {
  const secret = await readSecret();
  if (!secret.wakeMode) throw new Error("wakeMode is disabled in pi-telegram-operator.json");
  let stopping = false;
  for (;;) {
    const leader = await startLocalLeader(secret);
    if (!leader) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const stop = () => {
      stopping = true;
      closeLeader(leader).catch(warn("Cannot stop broker cleanly"));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise((resolve) => leader.server.once("close", resolve));
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (stopping) return;
  }
}

module.exports = Object.freeze({
  askQuestion,
  attach,
  notify,
  runWakeDaemon,
  sendFile,
  sendWidget,
  updateWidget,
});

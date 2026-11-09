const { spawn } = require("node:child_process");
const path = require("node:path");
const { AGENT_DIR } = require("../shared/paths.cjs");
const { scriptRuntimeEnv } = require("../shared/script-runtime.cjs");
const { readSettings } = require("../shared/settings.cjs");
const { telegramCall } = require("../telegram/api.cjs");

// The service manager stops the broker, so the restart and its reply must outlive it.
function restartService(options = {}) {
  const spawnProcess = options.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [
      path.join(__dirname, "..", "..", "service.cjs"),
      "restart", "--notify", JSON.stringify(options.replyOptions || {}),
    ], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ...scriptRuntimeEnv(), PI_CODING_AGENT_DIR: AGENT_DIR },
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`Service restart helper failed (${signal || `code ${code}`}); check service.cjs status and the daemon log`));
    });
    child.unref();
  });
}

async function reportServiceRestart(text, replyOptions) {
  const secret = await readSettings();
  await telegramCall(secret, "sendMessage", {
    chat_id: secret.chatId,
    text,
    ...(Number.isSafeInteger(replyOptions.threadId) ? { message_thread_id: replyOptions.threadId } : {}),
    ...(Number.isSafeInteger(replyOptions.replyTo) ? { reply_to_message_id: replyOptions.replyTo } : {}),
  });
}

module.exports = Object.freeze({ restartService, reportServiceRestart });

const { queuePersist } = require("../broker/state.cjs");
const { enqueueKeyed } = require("../shared/queue.cjs");
const { formatLocalTimestamp } = require("../shared/time.cjs");
const { errorMessage, warn } = require("../shared/errors.cjs");
const { telegramCall } = require("./api.cjs");

const CHAT_ACTION_THROTTLE_MS = 4_000;

function sessionActionData(sessionId, action) {
  return `session:${sessionId}:${action}`;
}

function parseSessionAction(value) {
  const match = String(value || "").match(/^session:([0-9a-f-]{36}):(continue|stop|retry|refresh)$/i);
  return match ? { sessionId: match[1], action: match[2].toLowerCase() } : undefined;
}

function dashboardKeyboard(topic) {
  return {
    inline_keyboard: [
      [
        { text: "Continue", callback_data: sessionActionData(topic.sessionId, "continue") },
        { text: "Stop", callback_data: sessionActionData(topic.sessionId, "stop") },
        { text: "Retry", callback_data: sessionActionData(topic.sessionId, "retry") },
      ],
      [{ text: "Refresh status", callback_data: sessionActionData(topic.sessionId, "refresh") }],
    ],
  };
}

function dashboardText(topic) {
  const status = topic.dashboardStatus || {};
  return [
    `Pi Session ${topic.sessionId.slice(0, 8)}`,
    `Status: ${status.phase || "Waiting"}`,
    `Working directory: ${topic.cwd || "unknown"}`,
    ...(status.detail ? [`Current activity: ${String(status.detail).slice(0, 500)}`] : []),
    `Updated: ${formatLocalTimestamp(status.updatedAt || Date.now())}`,
  ].join("\n");
}

async function syncTopicDashboard(state, topic, update = {}) {
  topic.dashboardStatus = {
    phase: String(update.phase || topic.dashboardStatus?.phase || "Waiting"),
    detail: String(update.detail || ""),
    updatedAt: Date.now(),
  };
  return enqueueKeyed(state.dashboardQueues, topic.sessionId, async () => {
    const payload = {
      chat_id: state.secret.chatId,
      text: dashboardText(topic),
      link_preview_options: { is_disabled: true },
      reply_markup: dashboardKeyboard(topic),
    };
    if (Number.isSafeInteger(topic.dashboardMessageId)) {
      try {
        await telegramCall(state.secret, "editMessageText", {
          ...payload,
          message_id: topic.dashboardMessageId,
        });
        return topic.dashboardMessageId;
      } catch (error) {
        if (/message is not modified/i.test(errorMessage(error))) return topic.dashboardMessageId;
        if (!/message to edit not found|message_id_invalid/i.test(errorMessage(error))) throw error;
        delete topic.dashboardMessageId;
      }
    }
    const sent = await telegramCall(state.secret, "sendMessage", {
      ...payload,
      message_thread_id: topic.threadId,
    });
    topic.dashboardMessageId = sent.message_id;
    await telegramCall(state.secret, "pinChatMessage", {
      chat_id: state.secret.chatId,
      message_id: sent.message_id,
      disable_notification: true,
    }).catch(warn("Cannot pin session dashboard"));
    return sent.message_id;
  });
}

// Fire-and-forget dashboard refresh that persists the pinned message id.
function updateDashboard(state, topic, update) {
  return syncTopicDashboard(state, topic, update).then(() => queuePersist(state)).catch(() => {});
}

async function sendTopicChatAction(state, topic, action = "typing") {
  const previous = state.chatActionSentAt.get(topic.sessionId) || 0;
  if (Date.now() - previous < CHAT_ACTION_THROTTLE_MS) return false;
  state.chatActionSentAt.set(topic.sessionId, Date.now());
  await telegramCall(state.secret, "sendChatAction", {
    chat_id: state.secret.chatId,
    message_thread_id: topic.threadId,
    action,
  });
  return true;
}

module.exports = Object.freeze({
  dashboardKeyboard,
  dashboardText,
  parseSessionAction,
  sendTopicChatAction,
  sessionActionData,
  syncTopicDashboard,
  updateDashboard,
});

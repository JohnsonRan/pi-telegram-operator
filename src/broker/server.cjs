const { randomUUID } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { PROTOCOL_VERSION, attachLineReader, sendLine } = require("../bridge/protocol.cjs");
const { MAX_PENDING_QUESTIONS, pruneExpiredBrokerState, queuePersist, readBrokerState, trimMappings } = require("./state.cjs");
const { formatWakeExitDetail, normalizePiCommands } = require("../telegram/control.cjs");
const { escapeHtml, renderTelegramChunkPairs, renderTelegramHtml, splitMarkdown } = require("../telegram/format.cjs");
const { sendSessionArtifact } = require("../telegram/files.cjs");
const { dashboardKeyboard, sendTopicChatAction, updateDashboard } = require("../telegram/dashboard.cjs");
const { questionKeyboard } = require("../telegram/questions.cjs");
const { AGENT_DIR } = require("../shared/paths.cjs");
const { errorMessage, warn } = require("../shared/errors.cjs");
const { telegramCall, telegramFormattedCall } = require("../telegram/api.cjs");
const {
  deliverPendingForSession,
  deliverPendingReply,
  enqueueStream,
  pollTelegram,
  releaseWakeFollowups,
  sendBrokerText,
  syncTelegramCommandMenu,
  withTopicRetry,
  __test: telegramRouterTest,
} = require("../telegram/router.cjs");
const { WakeLauncher } = require("../wake/launcher.cjs");
const { version: PACKAGE_VERSION } = require("../../package.json");

const STATE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function sendNotification(state, client, message) {
  const title = String(message.title || "Pi").slice(0, 256);
  const body = String(message.body || "");
  const sessionId = String(message.sessionId || client.sessionId);
  const bodySources = splitMarkdown(body, 3200);
  const bodyHtml = bodySources.map(renderTelegramHtml);
  const sent = await withTopicRetry(
    state,
    sessionId,
    message.cwd || client.cwd,
    message.sessionName || client.sessionName,
    async (topic) => {
      let result;
      for (let index = 0; index < bodyHtml.length; index += 1) {
        const first = index === 0;
        const last = index === bodyHtml.length - 1;
        const html = first
          ? `<b>${escapeHtml(title)}</b>${bodyHtml[index] ? `\n\n${bodyHtml[index]}` : ""}`
          : bodyHtml[index];
        const plain = first
          ? `${title}${bodySources[index] ? `\n\n${bodySources[index]}` : ""}`
          : bodySources[index];
        result = await telegramFormattedCall(state.secret, "sendMessage", {
          chat_id: state.secret.chatId,
          message_thread_id: topic.threadId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: !state.secret.linkPreview },
          ...(last ? { reply_markup: dashboardKeyboard(topic) } : {}),
        }, plain);
      }
      return { result, topic };
    },
  );
  const topic = sent.topic;
  const sentMessage = sent.result;
  const mapping = {
    messageId: sentMessage.message_id,
    threadId: topic.threadId,
    sessionId,
    cwd: String(message.cwd || client.cwd),
    createdAt: Date.now(),
  };
  state.mappings.set(mapping.messageId, mapping);
  trimMappings(state);
  await queuePersist(state);
  return sentMessage;
}

function handleStreamRequest(state, client, message) {
  if (!client.registered || message.sessionId !== client.sessionId || !Number.isSafeInteger(message.draftId)) {
    return Promise.reject(new Error("Invalid stream request"));
  }
  const text = String(message.text || "");
  return enqueueStream(state, client.sessionId, () => withTopicRetry(
    state,
    client.sessionId,
    client.cwd,
    client.sessionName,
    async (topic) => {
      if (message.type === "streamDraft") {
        const sourceChunks = splitMarkdown(text);
        const tail = sourceChunks[sourceChunks.length - 1] || "";
        // Keep the ellipsis on its own line so a leading code fence still parses.
        const preview = sourceChunks.length > 1 ? `…\n${tail}` : tail;
        const html = renderTelegramHtml(preview);
        sendTopicChatAction(state, topic).catch(() => {});
        if (topic.dashboardStatus?.phase !== "Working") {
          updateDashboard(state, topic, { phase: "Working", detail: tail.split("\n")[0] });
        }
        await telegramFormattedCall(state.secret, "sendMessageDraft", {
          chat_id: state.secret.chatId,
          message_thread_id: topic.threadId,
          draft_id: message.draftId,
          text: html,
          ...(html ? { parse_mode: "HTML" } : {}),
        }, preview);
        return;
      }
      if (message.type === "streamFinal") {
        if (text.trim()) {
          const chunks = renderTelegramChunkPairs(text);
          for (const chunk of chunks) {
            await telegramFormattedCall(state.secret, "sendMessage", {
              chat_id: state.secret.chatId,
              message_thread_id: topic.threadId,
              text: chunk.html,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: !state.secret.linkPreview },
            }, chunk.source);
          }
        }
        updateDashboard(state, topic, { phase: "Ready", detail: "Waiting for input" });
      }
    },
  ));
}

function schedulePendingRetry(state, pending) {
  if (pending.retryTimer) return;
  pending.retryCount = (pending.retryCount || 0) + 1;
  if (pending.retryCount > 5) {
    state.pendingReplies.delete(pending.deliveryId);
    queuePersist(state).catch(() => {});
    telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      ...(Number.isSafeInteger(pending.threadId) ? { message_thread_id: pending.threadId } : {}),
      text: "Pi could not accept this reply after several retries. Please send it again.",
    }).catch(warn("Cannot report failed reply"));
    return;
  }
  queuePersist(state).catch(() => {});
  const delay = Math.min(8_000, 500 * 2 ** (pending.retryCount - 1));
  pending.retryTimer = setTimeout(() => {
    pending.retryTimer = undefined;
    if (state.pendingReplies.has(pending.deliveryId) && !deliverPendingReply(state, pending)) {
      schedulePendingRetry(state, pending);
    }
  }, delay);
  pending.retryTimer.unref?.();
}

function sendSuccess(client, requestId, extra = {}) {
  sendLine(client.socket, { type: "result", requestId, ok: true, ...extra });
}

function sendFailure(client, requestId, error) {
  sendLine(client.socket, { type: "result", requestId, ok: false, error: errorMessage(error) });
}

function trackTask(state, promise) {
  const task = Promise.resolve(promise);
  state.activeTasks.add(task);
  const cleanup = () => state.activeTasks.delete(task);
  task.then(cleanup, cleanup);
  return task;
}

function handleRegister(state, client, message) {
  if (message.version !== PROTOCOL_VERSION || typeof message.clientId !== "string" || typeof message.sessionId !== "string") {
    client.socket.destroy(new Error("Invalid Telegram bridge registration"));
    return;
  }
  client.clientId = message.clientId;
  client.sessionId = message.sessionId;
  client.cwd = typeof message.cwd === "string" ? message.cwd : "";
  client.sessionName = typeof message.sessionName === "string" ? message.sessionName : "";
  client.wakeChild = message.wakeChild === true;
  client.commands = normalizePiCommands(message.commands);
  const previousCommands = state.sessionCommands.get(client.sessionId);
  const commandsChanged = JSON.stringify(previousCommands || []) !== JSON.stringify(client.commands);
  state.sessionCommands.set(client.sessionId, client.commands);
  const topic = state.topics.get(client.sessionId);
  if (topic) {
    const topicChanged = topic.cwd !== client.cwd || topic.sessionName !== client.sessionName;
    if (topicChanged) {
      topic.cwd = client.cwd;
      topic.sessionName = client.sessionName;
    }
    if (commandsChanged) {
      topic.commands = client.commands;
      syncTelegramCommandMenu(state).catch(warn("Cannot sync bot commands"));
    }
    if (topicChanged || commandsChanged) queuePersist(state).catch(() => {});
    updateDashboard(state, topic, { phase: "Connected", detail: client.sessionName || "Pi session connected" });
  }
  client.registered = true;
  if (!client.wakeChild && state.wakeReservations.has(client.sessionId)) {
    state.wakeLauncher.cancel(client.sessionId);
    state.wakeReservations.delete(client.sessionId);
  }
  for (const [registeredSessionId, registeredClient] of state.clientsBySession) {
    if (registeredClient === client && registeredSessionId !== client.sessionId) state.clientsBySession.delete(registeredSessionId);
  }
  const previous = state.clientsBySession.get(client.sessionId);
  if (previous && previous !== client) previous.socket.destroy();
  state.clients.set(client.clientId, client);
  state.clientsBySession.set(client.sessionId, client);
  sendLine(client.socket, { type: "registered", version: PROTOCOL_VERSION });
  for (const question of state.pendingQuestions.values()) {
    if (question.clientId === client.clientId && question.sessionId === client.sessionId && typeof question.answer === "string") {
      sendSuccess(client, question.requestId, { questionId: question.questionId, answer: question.answer });
    }
  }
  if (client.wakeChild) deliverPendingForSession(state, client.sessionId);
  else releaseWakeFollowups(state, client.sessionId);
}

function handleQuestionAck(state, client, message) {
  if (!(client.registered && typeof message.questionId === "string")) return;
  const question = state.pendingQuestions.get(message.questionId);
  if (question?.sessionId === client.sessionId && question.clientId === client.clientId) {
    state.pendingQuestions.delete(message.questionId);
    queuePersist(state).catch(warn("Cannot persist question ACK"));
  }
}

function handleReplyAck(state, client, message) {
  if (!(client.registered && typeof message.deliveryId === "string")) return;
  const pending = state.pendingReplies.get(message.deliveryId);
  if (!pending || pending.sessionId !== client.sessionId) return;
  if (message.ok === true) {
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
    state.pendingReplies.delete(message.deliveryId);
    for (const [messageId, mapping] of state.mappings) {
      if (messageId === pending.notificationMessageId ||
          (mapping.sessionId === pending.sessionId &&
           (!pending.threadId || mapping.threadId === pending.threadId) &&
           mapping.createdAt <= pending.createdAt)) {
        state.mappings.delete(messageId);
      }
    }
    queuePersist(state).catch(warn("Cannot persist reply ACK"));
  } else {
    schedulePendingRetry(state, pending);
  }
}

function handleStreamDraft(state, client, message) {
  trackTask(state, handleStreamRequest(state, client, message)).catch(warn("Draft stream failed"));
}

function handleStreamFinal(state, client, message) {
  if (typeof message.requestId !== "string") return;
  trackTask(state, handleStreamRequest(state, client, message)).then(() => {
    if (client.wakeChild) releaseWakeFollowups(state, client.sessionId);
    sendSuccess(client, message.requestId);
  }).catch((error) => {
    sendFailure(client, message.requestId, error);
  });
}

function handleQuestion(state, client, message) {
  if (!(client.registered && typeof message.requestId === "string")) return;
  const options = Array.isArray(message.options) ? message.options.map(String).filter(Boolean).slice(0, 10) : [];
  if (options.length === 0) {
    sendFailure(client, message.requestId, "Question has no selectable options");
    return;
  }
  const questionId = randomUUID();
  trackTask(state, withTopicRetry(state, client.sessionId, client.cwd, client.sessionName, async (topic) => {
    const sent = await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      message_thread_id: topic.threadId,
      text: String(message.question || "Pi needs your input").slice(0, 3000),
      reply_markup: questionKeyboard(questionId, options),
    });
    state.pendingQuestions.set(questionId, {
      questionId,
      requestId: message.requestId,
      clientId: client.clientId,
      sessionId: client.sessionId,
      threadId: topic.threadId,
      messageId: sent.message_id,
      question: String(message.question || "Pi needs your input").slice(0, 3000),
      options,
      createdAt: Date.now(),
    });
    while (state.pendingQuestions.size > MAX_PENDING_QUESTIONS) state.pendingQuestions.delete(state.pendingQuestions.keys().next().value);
    await queuePersist(state);
    updateDashboard(state, topic, { phase: "Waiting for answer", detail: String(message.question || "Pi needs your input") });
    return sent;
  })).catch((error) => {
    sendFailure(client, message.requestId, error);
  });
}

function handleArtifact(state, client, message) {
  if (!(client.registered && typeof message.requestId === "string")) return;
  const topic = state.topics.get(client.sessionId);
  if (!topic) {
    sendFailure(client, message.requestId, "No Telegram topic exists for this session");
    return;
  }
  sendTopicChatAction(state, topic, "upload_document").catch(() => {});
  updateDashboard(state, topic, { phase: "Uploading artifact", detail: String(message.path || "") });
  trackTask(state, sendSessionArtifact(state.secret, { ...topic, cwd: client.cwd }, String(message.path || ""), String(message.caption || ""))).then((sent) => {
    updateDashboard(state, topic, { phase: "Ready", detail: "Artifact sent" });
    sendSuccess(client, message.requestId, { messageId: sent.message_id });
  }).catch((error) => {
    sendFailure(client, message.requestId, error);
  });
}

function handleNotify(state, client, message) {
  if (!client.registered || typeof message.requestId !== "string") return;
  trackTask(state, sendNotification(state, client, message)).then((sent) => {
    sendSuccess(client, message.requestId, { messageId: sent.message_id });
  }).catch((error) => {
    sendFailure(client, message.requestId, error);
  });
}

const BROKER_HANDLERS = new Map(Object.entries({
  register: handleRegister,
  questionAck: handleQuestionAck,
  replyAck: handleReplyAck,
  streamDraft: handleStreamDraft,
  streamFinal: handleStreamFinal,
  question: handleQuestion,
  artifact: handleArtifact,
  notify: handleNotify,
}));

function handleBrokerRequest(state, client, message) {
  if (!message || message.auth !== state.secret.bridgeSecret) {
    client.socket.destroy(new Error("Telegram bridge authentication failed"));
    return;
  }
  BROKER_HANDLERS.get(message.type)?.(state, client, message);
}

function closeLeader(state) {
  if (state.closePromise) return state.closePromise;
  state.closed = true;
  state.pollController?.abort();
  if (state.cleanupTimer) clearInterval(state.cleanupTimer);
  for (const pending of state.pendingReplies.values()) {
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
  }
  const sockets = new Set([...state.clients.values()].map((client) => client.socket));
  for (const socket of sockets) socket.destroy();
  state.clients.clear();
  state.clientsBySession.clear();
  state.closePromise = (async () => {
    await state.pollTask?.catch(() => {});
    for (;;) {
      const work = [
        ...(state.activeTasks || []),
        ...(state.streamQueues?.values?.() || []),
        ...(state.dashboardQueues?.values?.() || []),
      ];
      if (work.length === 0) break;
      await Promise.allSettled(work);
    }
    await Promise.resolve(state.persistQueue).catch(() => {});
    await new Promise((resolve, reject) => {
      if (!state.server.listening) {
        resolve(undefined);
        return;
      }
      state.server.close((error) => error ? reject(error) : resolve(undefined));
      state.server.closeAllConnections?.();
    });
  })();
  return state.closePromise;
}

async function reportWakeExit(state, { sessionId, code, signal, cancelled, stderr }) {
  if (state.foregroundStartups.has(sessionId)) return;
  state.wakeReservations.delete(sessionId);
  if (code === 0 || cancelled) return;
  const topic = state.topics.get(sessionId);
  if (!topic) return;
  const detail = formatWakeExitDetail(stderr);
  await sendBrokerText(state, [
    `Background Pi exited before completing (${signal || `code ${code}`}).`,
    ...(detail ? ["", detail] : []),
  ].join("\n"), { threadId: topic.threadId });
}

async function startLocalLeader(secret) {
  const server = net.createServer({ pauseOnConnect: true });
  const acquired = await new Promise((resolve, reject) => {
    const onBindError = (error) => {
      if (error?.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    server.once("error", onBindError);
    server.listen(secret.port, "127.0.0.1", () => {
      server.off("error", onBindError);
      resolve(true);
    });
  });
  if (!acquired) return undefined;

  let stored;
  try {
    stored = await readBrokerState();
  } catch (error) {
    server.close();
    throw error;
  }
  const state = {
    secret,
    pid: process.pid,
    packageVersion: PACKAGE_VERSION,
    startedAt: Date.now(),
    generation: stored.generation,
    offset: stored.offset,
    mappings: new Map(stored.mappings.map((item) => [item.messageId, item])),
    pendingReplies: new Map(stored.pendingReplies.map((item) => [item.deliveryId, item])),
    pendingQuestions: new Map(stored.pendingQuestions.map((item) => [item.questionId, item])),
    topics: new Map(stored.topics.map((item) => [item.sessionId, item])),
    sessionCommands: new Map(stored.topics.map((item) => [item.sessionId, Array.isArray(item.commands) ? item.commands : []])),
    commandMenuSignature: undefined,
    topicPromises: new Map(),
    streamQueues: new Map(),
    dashboardQueues: new Map(),
    chatActionSentAt: new Map(),
    activeTasks: new Set(),
    clients: new Map(),
    clientsBySession: new Map(),
    // Sessions with a wake launch in progress or a wake process running.
    wakeReservations: new Set(),
    // Sessions whose foreground terminal is still being verified; their exits
    // are expected (cancel + fallback) and are not reported as failures.
    foregroundStartups: new Set(),
    wakeLauncher: undefined,
    persistQueue: Promise.resolve(),
    cleanupTimer: undefined,
    pollController: undefined,
    closePromise: undefined,
    closed: false,
    server,
  };
  state.wakeLauncher = new WakeLauncher({
    piCommand: secret.wakePiCommand,
    piCommandArgs: secret.wakePiCommandArgs,
    openTerminal: secret.wakeOpenTerminal,
    terminalSpecDir: path.join(AGENT_DIR, "terminal-launches"),
    onExit: (exit) => reportWakeExit(state, exit),
  });
  pruneExpiredBrokerState(state);
  queuePersist(state).catch(warn("Cannot normalize state"));
  state.cleanupTimer = setInterval(() => {
    if (pruneExpiredBrokerState(state)) {
      queuePersist(state).catch(warn("Cannot clean state"));
    }
  }, STATE_CLEANUP_INTERVAL_MS);
  state.cleanupTimer.unref?.();

  server.on("connection", (socket) => {
    if (state.closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const client = { socket, registered: false };
    attachLineReader(socket, (message) => handleBrokerRequest(state, client, message), () => socket.destroy());
    socket.on("close", () => {
      if (client.clientId && state.clients.get(client.clientId) === client) state.clients.delete(client.clientId);
      if (client.sessionId && state.clientsBySession.get(client.sessionId) === client) {
        state.clientsBySession.delete(client.sessionId);
        const topic = state.topics.get(client.sessionId);
        if (!topic) state.sessionCommands.delete(client.sessionId);
        else if (!state.closed) updateDashboard(state, topic, { phase: "Disconnected", detail: "Pi session is not connected" });
      }
    });
    socket.on("error", () => {});
    socket.resume();
  });
  server.on("error", warn("Broker error"));
  server.on("close", () => {
    state.closed = true;
    if (state.cleanupTimer) clearInterval(state.cleanupTimer);
  });
  server.unref?.();
  syncTelegramCommandMenu(state).catch(warn("Cannot sync bot commands"));
  state.pollTask = pollTelegram(state).catch(warn("Poller stopped"));
  return state;
}

module.exports = Object.freeze({
  closeLeader,
  startLocalLeader,
  __test: Object.freeze({ enqueueStream, handleBrokerRequest, reportWakeExit, schedulePendingRetry, ...telegramRouterTest }),
});

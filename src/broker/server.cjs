const { randomUUID } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { PROTOCOL_VERSION, attachLineReader, sendLine } = require("../bridge/protocol.cjs");
const { MAX_PENDING_QUESTIONS, pruneExpiredBrokerState, queuePersist, readBrokerState, trimMappings } = require("./state.cjs");
const { formatWakeExitDetail, normalizePiCommands } = require("../telegram/control.cjs");
const {
  RICH_SOURCE_CHARS,
  escapeMarkdown,
  prepareRichDraft,
  prepareRichMarkdown,
  renderTelegramChunkPairs,
  richThinking,
  renderTelegramHtml,
  splitMarkdown,
} = require("../telegram/format.cjs");
const { richLocalMedia, sendSessionArtifact } = require("../telegram/files.cjs");
const { dashboardKeyboard, sendTopicChatAction, updateDashboard } = require("../telegram/dashboard.cjs");
const { questionKeyboard, toggleKeyboard, widgetQuestionCaption, widgetQuestionKeyboard } = require("../telegram/questions.cjs");
const { AGENT_DIR } = require("../shared/paths.cjs");
const { errorMessage, warn } = require("../shared/errors.cjs");
const { richEnabled, telegramBetaCall, telegramCall, telegramFormattedCall, telegramRichCall } = require("../telegram/api.cjs");
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
// Widget message ids kept per topic to route taps back to its session.
const MAX_TOPIC_WIDGETS = 50;

// Sends Markdown as rich messages; a piece the API rejects goes out as legacy HTML chunks.
async function sendMarkdown(state, topic, markdown, replyMarkup) {
  const target = { chat_id: state.secret.chatId, message_thread_id: topic.threadId };
  const pieces = splitMarkdown(markdown, RICH_SOURCE_CHARS);
  const uploaded = new Map();
  let sent;
  for (let index = 0; index < pieces.length; index += 1) {
    const extra = replyMarkup && index === pieces.length - 1 ? { reply_markup: replyMarkup } : {};
    // Legacy messages cannot carry inline media, so do not read the files at all then.
    const local = richEnabled()
      ? await richLocalMedia(topic, pieces[index], uploaded)
      : { markdown: pieces[index], media: [], files: [], remember() {} };
    sent = await telegramRichCall(state.secret, "sendRichMessage", {
      ...target,
      rich_message: { markdown: prepareRichMarkdown(local.markdown), ...(local.media.length ? { media: local.media } : {}) },
      ...extra,
    }, async () => {
      let result;
      const chunks = renderTelegramChunkPairs(pieces[index]);
      for (let chunk = 0; chunk < chunks.length; chunk += 1) {
        result = await telegramFormattedCall(state.secret, "sendMessage", {
          ...target,
          text: chunks[chunk].html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: !state.secret.linkPreview },
          ...(chunk === chunks.length - 1 ? extra : {}),
        }, chunks[chunk].source);
      }
      return result;
    }, local.files);
    local.remember(sent);
  }
  return sent;
}

// Keeps the end of a long streaming text, marking the cut with an ellipsis line.
function draftTail(text, limit) {
  const chunks = splitMarkdown(text, limit);
  const tail = chunks[chunks.length - 1] || "";
  // Keep the ellipsis on its own line so a leading code fence still parses.
  return { tail, preview: chunks.length > 1 ? `…\n${tail}` : tail };
}

async function sendNotification(state, client, message) {
  const title = String(message.title || "Pi").slice(0, 256);
  const body = String(message.body || "");
  const sessionId = String(message.sessionId || client.sessionId);
  const markdown = `**${escapeMarkdown(title)}**${body ? `\n\n${body}` : ""}`;
  const sent = await withTopicRetry(
    state,
    sessionId,
    message.cwd || client.cwd,
    message.sessionName || client.sessionName,
    async (topic) => ({ result: await sendMarkdown(state, topic, markdown, dashboardKeyboard(topic)), topic }),
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
        const { tail, preview } = draftTail(text, RICH_SOURCE_CHARS);
        sendTopicChatAction(state, topic).catch(() => {});
        if (topic.dashboardStatus?.phase !== "Working") {
          const detail = tail.split("\n").find((line) => line.trim() && !/^\s*```/.test(line)) || "";
          updateDashboard(state, topic, { phase: "Working", detail });
        }
        // can_stop shows Telegram's own stop button; the router maps the tap to a Pi stop.
        // keep_on_stop leaves the partial draft visible until the final reply replaces it.
        const target = {
          chat_id: state.secret.chatId,
          message_thread_id: topic.threadId,
          draft_id: message.draftId,
          can_stop: true,
          keep_on_stop: true,
        };
        state.activeDrafts.set(client.sessionId, message.draftId);
        await telegramRichCall(state.secret, "sendRichMessageDraft", {
          ...target,
          rich_message: { markdown: message.status ? richThinking(preview) : prepareRichDraft(preview) },
        }, () => {
          const legacy = draftTail(text).preview;
          const html = renderTelegramHtml(legacy);
          return telegramFormattedCall(state.secret, "sendMessageDraft", {
            ...target,
            text: html,
            ...(html ? { parse_mode: "HTML" } : {}),
          }, legacy);
        });
        return;
      }
      if (message.type === "streamFinal") {
        if (state.activeDrafts.get(client.sessionId) === message.draftId) state.activeDrafts.delete(client.sessionId);
        if (text.trim()) await sendMarkdown(state, topic, text);
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
  if (previous && previous !== client) {
    // Otherwise two processes on one session would evict each other every reconnect.
    sendLine(previous.socket, { type: "superseded", sessionId: client.sessionId });
    previous.socket.end();
  }
  state.clients.set(client.clientId, client);
  state.clientsBySession.set(client.sessionId, client);
  sendLine(client.socket, { type: "registered", version: PROTOCOL_VERSION });
  for (const question of state.pendingQuestions.values()) {
    if (question.clientId === client.clientId && question.sessionId === client.sessionId && typeof question.answer === "string") {
      sendSuccess(client, question.requestId, { questionId: question.questionId, answer: question.answer });
    }
  }
  // Held follow-ups wait for a wake child's first turn; any other client takes them now.
  deliverPendingForSession(state, client.sessionId);
  if (!client.wakeChild) releaseWakeFollowups(state, client.sessionId);
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
  // A multi-select keeps its state on the pending question and only answers on Done.
  const multiSelect = message.multiSelect === true;
  const questionId = randomUUID();
  trackTask(state, withTopicRetry(state, client.sessionId, client.cwd, client.sessionName, async (topic) => {
    // Questions often quote code or compare options in a table, so they get rich formatting too.
    const keyboard = multiSelect ? toggleKeyboard(questionId, options) : questionKeyboard(questionId, options);
    const sent = await sendMarkdown(state, topic, String(message.question || "Pi needs your input").slice(0, 3000), keyboard);
    state.pendingQuestions.set(questionId, {
      questionId,
      requestId: message.requestId,
      clientId: client.clientId,
      sessionId: client.sessionId,
      threadId: topic.threadId,
      messageId: sent.message_id,
      question: String(message.question || "Pi needs your input").slice(0, 3000),
      options,
      ...(multiSelect ? { multiSelect: true, selected: [] } : {}),
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

// A question drawn as a widget: the widget carries the question itself and its options sit in the
// inline keyboard under it (widgetQuestionKeyboard). Both live in the same message, so a tap comes
// back as the usual question:<id>:<index> callback and takes exactly the same path as an
// inline-keyboard question, including the replay on reconnect.
function handleWidgetQuestion(state, client, message) {
  if (!(client.registered && typeof message.requestId === "string")) return;
  const options = Array.isArray(message.options) ? message.options.map(String).filter(Boolean).slice(0, 10) : [];
  const html = typeof message.widget === "string" ? message.widget.trim() : "";
  if (options.length === 0 || !html) {
    sendFailure(client, message.requestId, "A widget question needs a widget and selectable options");
    return;
  }
  const questionId = randomUUID();
  const question = String(message.question || "Pi needs your input").slice(0, 3000);
  const multiSelect = message.multiSelect === true;
  trackTask(state, withTopicRetry(state, client.sessionId, client.cwd, client.sessionName, async (topic) => {
    const sent = await telegramBetaCall(state.secret, "sendWidget", {
      chat_id: state.secret.chatId,
      message_thread_id: topic.threadId,
      html,
      caption: widgetQuestionCaption(question, options),
      allow_queries: true,
      reply_markup: multiSelect ? toggleKeyboard(questionId, options) : widgetQuestionKeyboard(questionId, options),
    });
    state.pendingQuestions.set(questionId, {
      questionId,
      requestId: message.requestId,
      clientId: client.clientId,
      sessionId: client.sessionId,
      threadId: topic.threadId,
      messageId: sent.message_id,
      question,
      options,
      ...(multiSelect ? { multiSelect: true, selected: [] } : {}),
      createdAt: Date.now(),
    });
    topic.widgetIds = [...(topic.widgetIds || []), sent.message_id].slice(-MAX_TOPIC_WIDGETS);
    while (state.pendingQuestions.size > MAX_PENDING_QUESTIONS) state.pendingQuestions.delete(state.pendingQuestions.keys().next().value);
    await queuePersist(state);
    updateDashboard(state, topic, { phase: "Waiting for answer", detail: question });
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

// Optional text fields: undefined leaves the widget state alone, "" clears it.
function widgetState(message) {
  return {
    ...(typeof message.chatData === "string" ? { chat_data: message.chatData } : {}),
    ...(typeof message.publicData === "string" ? { public_data: message.publicData } : {}),
  };
}

function handleWidget(state, client, message) {
  if (!(client.registered && typeof message.requestId === "string")) return;
  trackTask(state, withTopicRetry(state, client.sessionId, client.cwd, client.sessionName, async (topic) => {
    const sent = await telegramBetaCall(state.secret, "sendWidget", {
      chat_id: state.secret.chatId,
      message_thread_id: topic.threadId,
      html: String(message.html || ""),
      ...(message.caption ? { caption: String(message.caption) } : {}),
      ...(Number.isSafeInteger(message.width) && message.width > 0 ? { width: message.width } : {}),
      ...(Number.isSafeInteger(message.height) && message.height > 0 ? { height: message.height } : {}),
      ...(message.allowQueries !== false ? { allow_queries: true } : {}),
      ...widgetState(message),
    });
    topic.widgetIds = [...(topic.widgetIds || []), sent.message_id].slice(-MAX_TOPIC_WIDGETS);
    await queuePersist(state);
    return sent;
  })).then((sent) => {
    sendSuccess(client, message.requestId, { messageId: sent.message_id });
  }).catch((error) => {
    sendFailure(client, message.requestId, error);
  });
}

function handleWidgetData(state, client, message) {
  if (!(client.registered && typeof message.requestId === "string")) return;
  const topic = state.topics.get(client.sessionId);
  if (!topic?.widgetIds?.includes(message.messageId)) {
    sendFailure(client, message.requestId, `Widget ${message.messageId} was not sent by this session`);
    return;
  }
  trackTask(state, telegramBetaCall(state.secret, "editMessageWidgetData", {
    chat_id: state.secret.chatId,
    message_id: message.messageId,
    ...widgetState(message),
  }).catch((error) => {
    if (!/message is not modified/i.test(errorMessage(error))) throw error;
  })).then(() => {
    sendSuccess(client, message.requestId);
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
  widgetQuestion: handleWidgetQuestion,
  artifact: handleArtifact,
  notify: handleNotify,
  widget: handleWidget,
  widgetData: handleWidgetData,
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
    offset: stored.offset,
    offsets: { ...stored.offsets },
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
    // Latest streaming draft per session, for Telegram's native stop button.
    activeDrafts: new Map(),
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

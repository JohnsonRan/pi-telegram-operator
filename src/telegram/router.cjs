const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { sendLine } = require("../bridge/protocol.cjs");
const { enqueueKeyed } = require("../shared/queue.cjs");
const { MAX_PENDING_REPLIES, MAX_TOPICS, pruneExpiredBrokerState, queuePersist } = require("../broker/state.cjs");
const { CONTROL_COMMANDS, CONTROL_PANEL_COMMANDS, RESTORE_CONTEXT_PROMPT, controlPanel, parseControlCallback, parseRestoreCallback, topicName, translateTelegramCommand } = require("./control.cjs");
const { splitMarkdown } = require("./format.cjs");
const { attachmentFromMessage, downloadTelegramAttachment } = require("./files.cjs");
const { parseSessionAction, sendTopicChatAction, syncTopicDashboard, updateDashboard } = require("./dashboard.cjs");
const { parseQuestionCallback } = require("./questions.cjs");
const { cloneRepository, parseGitCloneCommand } = require("./git-clone.cjs");
const { parsePiUpdateCommand, runPiUpdate } = require("./pi-update.cjs");
const { errorMessage, warn } = require("../shared/errors.cjs");
const { telegramCall } = require("./api.cjs");
const { parseControlCommand, resolveWakeCwd } = require("../wake/launcher.cjs");

const WAKE_REGISTRATION_TIMEOUT_MS = 15_000;
const WAKE_STOP_TIMEOUT_MS = 5_000;
const WAKE_STABILITY_TIMEOUT_MS = 1_500;

async function ensureTopic(state, sessionId, cwd, sessionName) {
  const existing = state.topics.get(sessionId);
  if (existing) return existing;
  const inflight = state.topicPromises.get(sessionId);
  if (inflight) return inflight;

  const promise = (async () => {
    if (state.topics.size >= MAX_TOPICS) throw new Error(`Telegram topic limit reached (${MAX_TOPICS})`);
    const created = await telegramCall(state.secret, "createForumTopic", {
      chat_id: state.secret.chatId,
      name: topicName(sessionId, cwd, sessionName),
    });
    const topic = {
      sessionId,
      threadId: created.message_thread_id,
      name: created.name,
      cwd: String(cwd || ""),
      commands: state.sessionCommands.get(sessionId) || [],
      createdAt: Date.now(),
    };
    state.topics.set(sessionId, topic);
    await queuePersist(state);
    updateDashboard(state, topic, { phase: "Waiting", detail: "Session topic created" });
    syncTelegramCommandMenu(state).catch(warn("Cannot sync bot commands"));
    return topic;
  })().finally(() => state.topicPromises.delete(sessionId));
  state.topicPromises.set(sessionId, promise);
  return promise;
}

function isStaleTopicError(error) {
  return /message thread not found|topic.*(?:closed|not found|deleted)|thread.*not found/i.test(errorMessage(error));
}

async function withTopicRetry(state, sessionId, cwd, sessionName, operation) {
  let topic = await ensureTopic(state, sessionId, cwd, sessionName);
  try {
    return await operation(topic);
  } catch (error) {
    if (!isStaleTopicError(error)) throw error;
    state.topics.delete(sessionId);
    await queuePersist(state);
    topic = await ensureTopic(state, sessionId, cwd, sessionName);
    return operation(topic);
  }
}

function findReplyTarget(state, message) {
  const threadId = message?.message_thread_id;
  if (Number.isSafeInteger(threadId)) {
    const topic = [...state.topics.values()].find((candidate) => candidate.threadId === threadId);
    if (topic) {
      const mapping = [...state.mappings.values()].reverse().find((candidate) => candidate.threadId === threadId);
      return mapping || { sessionId: topic.sessionId, threadId, createdAt: Date.now() };
    }
  }
  const replyId = message?.reply_to_message?.message_id;
  if (Number.isSafeInteger(replyId) && state.mappings.has(replyId)) return state.mappings.get(replyId);
  return undefined;
}

function enqueueStream(state, sessionId, task) {
  return enqueueKeyed(state.streamQueues, sessionId, task);
}

function connectedTarget(state, sessionId) {
  const client = state.clientsBySession.get(sessionId);
  return client?.registered && !client.socket.destroyed ? client : undefined;
}

function deliverPendingReply(state, pending) {
  const client = connectedTarget(state, pending.sessionId);
  if (!client) return false;
  sendLine(client.socket, { type: "reply", ...pending });
  return true;
}

function deliverPendingForSession(state, sessionId) {
  for (const pending of state.pendingReplies.values()) {
    if (pending.sessionId === sessionId && !pending.holdForWake) deliverPendingReply(state, pending);
  }
}

function sendSessionControl(state, sessionId, action) {
  const client = connectedTarget(state, sessionId);
  if (!client) return false;
  sendLine(client.socket, { type: "control", sessionId, action });
  return true;
}

async function syncTelegramCommandMenu(state) {
  const commands = state.secret.wakeMode ? [...CONTROL_COMMANDS] : [];
  const seen = new Set(commands.map((item) => item.command));
  for (const topic of state.topics.values()) {
    for (const item of Array.isArray(topic.commands) ? topic.commands : []) {
      if (seen.has(item.telegramName) || commands.length >= 100) continue;
      seen.add(item.telegramName);
      commands.push({ command: item.telegramName, description: item.description.slice(0, 48) });
    }
  }
  let published = commands;
  for (;;) {
    const signature = JSON.stringify(published);
    if (signature === state.commandMenuSignature) return;
    try {
      await telegramCall(state.secret, "setMyCommands", {
        scope: { type: "chat", chat_id: state.secret.chatId },
        commands: published,
      });
      state.commandMenuSignature = signature;
      return;
    } catch (error) {
      if (!/BOT_COMMANDS_TOO_MUCH/i.test(errorMessage(error)) || published.length <= CONTROL_COMMANDS.length + 10) throw error;
      published = published.slice(0, Math.max(CONTROL_COMMANDS.length, published.length - 10));
    }
  }
}

async function sendBrokerText(state, text, options = {}) {
  return telegramCall(state.secret, "sendMessage", {
    chat_id: state.secret.chatId,
    text: String(text),
    link_preview_options: { is_disabled: true },
    ...(Number.isSafeInteger(options.threadId) ? { message_thread_id: options.threadId } : {}),
    ...(Number.isSafeInteger(options.replyTo) ? { reply_to_message_id: options.replyTo } : {}),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
}

async function waitForWakeRegistration(state, sessionId, timeoutMs = WAKE_REGISTRATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = connectedTarget(state, sessionId);
    if (client?.wakeChild) return client;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function waitForWakeStop(state, sessionId, timeoutMs = WAKE_STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (state.wakeLauncher.isRunning(sessionId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !state.wakeLauncher.isRunning(sessionId);
}

async function waitForWakeStability(state, sessionId, timeoutMs = WAKE_STABILITY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!state.wakeLauncher.isRunning(sessionId)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state.wakeLauncher.isRunning(sessionId);
}

async function launchWakeSession(state, topic, prompt, replyTo) {
  if (state.wakeReservations.has(topic.sessionId)) return { started: false, reserved: true };
  state.wakeReservations.add(topic.sessionId);
  try {
    const cwd = await resolveWakeCwd(topic.cwd, state.secret.wakeDefaultCwd, state.secret.wakeAllowedRoots);
    if (connectedTarget(state, topic.sessionId)) {
      state.wakeReservations.delete(topic.sessionId);
      return { started: false, connected: true };
    }
    for (const pending of state.pendingReplies.values()) {
      if (pending.sessionId === topic.sessionId) pending.holdForWake = true;
    }
    queuePersist(state).catch(() => {});
    const preferForeground = state.secret.wakeOpenTerminal;
    if (preferForeground) state.foregroundStartups.add(topic.sessionId);
    let launched = await state.wakeLauncher.launch({
      sessionId: topic.sessionId,
      cwd,
      sessionName: topic.name,
      prompt,
    });
    if (!launched.foreground) state.foregroundStartups.delete(topic.sessionId);
    if (launched.started) {
      let mode = launched.foreground
        ? `Opening ${launched.terminal || "terminal"}`
        : launched.fallbackReason
          ? `No terminal available; using background mode (${launched.fallbackReason})`
          : "Starting in background mode";
      await sendBrokerText(state, `Waking Pi session ${topic.sessionId.slice(0, 8)}…\n${mode}`, {
        threadId: topic.threadId,
        replyTo,
      });
      if (launched.foreground) {
        const registered = await waitForWakeRegistration(state, topic.sessionId);
        const stable = registered ? await waitForWakeStability(state, topic.sessionId) : false;
        if (!stable) {
          state.wakeLauncher.cancel(topic.sessionId);
          const stopped = await waitForWakeStop(state, topic.sessionId);
          const connected = connectedTarget(state, topic.sessionId);
          if (stopped) {
            state.foregroundStartups.delete(topic.sessionId);
            state.wakeReservations.add(topic.sessionId);
            const fallback = await state.wakeLauncher.launch({
              sessionId: topic.sessionId,
              cwd,
              sessionName: topic.name,
              prompt,
              openTerminal: false,
            });
            if (fallback.started) {
              launched = fallback;
              mode = registered
                ? "Terminal exited during startup; switched to background mode"
                : "Terminal did not connect; switched to background mode";
              await sendBrokerText(state, mode, { threadId: topic.threadId, replyTo });
            }
          } else {
            state.foregroundStartups.delete(topic.sessionId);
            if (!connected) throw new Error("The terminal opened but Pi did not connect to the Telegram broker");
          }
        } else {
          state.foregroundStartups.delete(topic.sessionId);
        }
      }
    } else if (!state.wakeLauncher.isRunning(topic.sessionId)) {
      state.wakeReservations.delete(topic.sessionId);
    }
    return launched;
  } catch (error) {
    state.foregroundStartups.delete(topic.sessionId);
    state.wakeReservations.delete(topic.sessionId);
    throw error;
  }
}

async function handleControlMessage(state, message) {
  const cloneCommand = parseGitCloneCommand(message.text);
  const updateCommand = parsePiUpdateCommand(message.text);
  const parsed = parseControlCommand(message.text);
  const replyOptions = {
    replyTo: message.message_id,
    ...(Number.isSafeInteger(message.message_thread_id) ? { threadId: message.message_thread_id } : {}),
  };
  if (updateCommand) {
    await sendBrokerText(state, "Running pi update --all…", replyOptions);
    const output = await (state.runPiUpdate || runPiUpdate)({
      piCommand: state.secret.wakePiCommand,
      cwd: state.secret.wakeDefaultCwd || process.cwd(),
    });
    await sendBrokerText(state, [
      "Pi update completed.",
      ...(output ? ["", output] : []),
      "",
      "Restart running Pi sessions to load updated extensions.",
    ].join("\n"), replyOptions);
    return;
  }
  if (cloneCommand) {
    await sendBrokerText(state, "Cloning repository into wakeDefaultCwd…", replyOptions);
    const cloned = await (state.cloneRepository || cloneRepository)({
      ...cloneCommand,
      defaultCwd: state.secret.wakeDefaultCwd,
      allowedRoots: state.secret.wakeAllowedRoots,
    });
    const sessionId = randomUUID();
    const topic = await ensureTopic(state, sessionId, cloned.cwd, cloned.directory);
    await sendBrokerText(state, [
      `Repository cloned: ${cloned.directory}`,
      `Working directory: ${cloned.cwd}`,
      `Pi session: ${sessionId.slice(0, 8)}`,
    ].join("\n"), { threadId: topic.threadId });
    await launchWakeSession(state, topic, "");
    return;
  }
  if (!parsed) {
    await sendBrokerText(state, "Use /update, /clone, /new, /sessions, /status, or /help in All Topics.", replyOptions);
    return;
  }
  if (CONTROL_PANEL_COMMANDS.has(parsed.command)) {
    const panel = controlPanel(state, parsed.command);
    await sendBrokerText(state, panel.text, { ...replyOptions, replyMarkup: panel.replyMarkup });
    return;
  }

  const cwd = await resolveWakeCwd(parsed.cwd, state.secret.wakeDefaultCwd, state.secret.wakeAllowedRoots);
  const sessionId = randomUUID();
  const sessionName = path.basename(cwd) || "Pi";
  const topic = await ensureTopic(state, sessionId, cwd, sessionName);
  await sendBrokerText(state, `New Pi session ${sessionId.slice(0, 8)}\nWorking directory: ${cwd}`, { threadId: topic.threadId });
  if (parsed.prompt) await launchWakeSession(state, topic, parsed.prompt);
}

async function queueTelegramReply(state, target, message, holdForWake = false) {
  const deliveryId = typeof message.deliveryId === "string" ? message.deliveryId : randomUUID();
  const existing = state.pendingReplies.get(deliveryId);
  if (existing) return { pending: existing, delivered: holdForWake ? false : deliverPendingReply(state, existing) };
  const pending = {
    deliveryId,
    text: message.text,
    telegramMessageId: message.message_id,
    notificationMessageId: target.messageId,
    threadId: target.threadId || message.message_thread_id,
    sessionId: target.sessionId,
    createdAt: Date.now(),
    ...(holdForWake ? { holdForWake: true } : {}),
  };
  state.pendingReplies.set(pending.deliveryId, pending);
  await queuePersist(state);
  const delivered = holdForWake ? false : deliverPendingReply(state, pending);
  return { pending, delivered };
}

function releaseWakeFollowups(state, sessionId) {
  for (const pending of state.pendingReplies.values()) {
    if (pending.sessionId !== sessionId || !pending.holdForWake) continue;
    delete pending.holdForWake;
    deliverPendingReply(state, pending);
  }
  queuePersist(state).catch(() => {});
}

async function acknowledgeTelegramMessage(state, message) {
  if (!Number.isSafeInteger(message?.message_id)) return false;
  try {
    await telegramCall(state.secret, "setMessageReaction", {
      chat_id: state.secret.chatId,
      message_id: message.message_id,
      reaction: [{ type: "emoji", emoji: "👀" }],
      is_big: false,
    });
    return true;
  } catch (error) {
    warn("Cannot acknowledge Telegram message")(error);
    return false;
  }
}

async function handleTelegramMessage(state, message) {
  if (!message) return;
  if (message.chat?.id !== state.secret.chatId || message.from?.id !== state.secret.allowedUserId) return;
  if (message.from?.is_bot === true) return;

  const topicForThread = Number.isSafeInteger(message.message_thread_id)
    ? [...state.topics.values()].find((topic) => topic.threadId === message.message_thread_id)
    : undefined;
  const threadIsKnown = Boolean(topicForThread);
  const attachment = attachmentFromMessage(message);
  if (attachment) {
    if (!topicForThread) {
      await sendBrokerText(state, "Send files inside a Pi session topic so they can be saved to that session.", {
        replyTo: message.message_id,
        ...(Number.isSafeInteger(message.message_thread_id) ? { threadId: message.message_thread_id } : {}),
      }).catch(() => {});
      return;
    }
    try {
      const downloaded = await downloadTelegramAttachment(state.secret, message, topicForThread);
      const caption = String(message.caption || "").trim();
      sendTopicChatAction(state, topicForThread).catch(() => {});
      message = {
        ...message,
        text: [
          `Telegram attachment saved to ${downloaded.relativePath}.`,
          `MIME type: ${downloaded.mimeType}.`,
          ...(caption ? [`User caption: ${caption}`] : []),
          "Inspect this file and respond to the user.",
        ].join("\n"),
      };
    } catch (error) {
      await sendBrokerText(state, `Could not save attachment: ${errorMessage(error)}`, {
        threadId: message.message_thread_id,
        replyTo: message.message_id,
      }).catch(() => {});
      return;
    }
  }

  if (typeof message.text !== "string") return;
  if (message.text.trim().startsWith("/start")) return;
  if (state.secret.wakeMode && !threadIsKnown) {
    try {
      await handleControlMessage(state, message);
      acknowledgeTelegramMessage(state, message).catch(() => {});
    } catch (error) {
      await sendBrokerText(state, `Command failed: ${errorMessage(error)}`, {
        replyTo: message.message_id,
        ...(Number.isSafeInteger(message.message_thread_id) ? { threadId: message.message_thread_id } : {}),
      }).catch(() => {});
    }
    return;
  }

  const target = findReplyTarget(state, message);
  if (!target) {
    await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      text: "No active Pi session is available for this topic.",
      reply_to_message_id: message.message_id,
      ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
    }).catch(warn("Cannot send reply notice"));
    return;
  }

  const targetTopic = state.topics.get(target.sessionId);
  message = { ...message, text: translateTelegramCommand(targetTopic, message.text) };

  let holdForWake = false;
  if (!connectedTarget(state, target.sessionId) && state.secret.wakeMode) {
    const topic = state.topics.get(target.sessionId);
    if (topic) {
      if (state.wakeLauncher.isRunning(target.sessionId) || state.wakeReservations.has(target.sessionId)) {
        holdForWake = true;
      } else {
        try {
          const launched = await launchWakeSession(state, topic, message.text, message.message_id);
          if (launched.started) {
            acknowledgeTelegramMessage(state, message).catch(() => {});
            return;
          }
          holdForWake = launched.reserved === true;
        } catch (error) {
          await sendBrokerText(state, `Could not wake Pi: ${errorMessage(error)}`, {
            threadId: message.message_thread_id,
            replyTo: message.message_id,
          }).catch(() => {});
          return;
        }
      }
    }
  }

  if (pruneExpiredBrokerState(state)) queuePersist(state).catch(() => {});
  if (state.pendingReplies.size >= MAX_PENDING_REPLIES) {
    await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
      text: "Pi reply queue is full. Please try again after pending replies are delivered.",
    });
    return;
  }

  const queued = await queueTelegramReply(state, target, message, holdForWake);
  acknowledgeTelegramMessage(state, message).catch(() => {});
  if (!queued.delivered) {
    await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      text: holdForWake
        ? "Reply queued behind the session's current wake turn."
        : "Reply queued until the target Pi session reconnects.",
      reply_to_message_id: message.message_id,
      ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
    }).catch(warn("Cannot send reply notice"));
  }
}

async function restoreSessionTopic(state, restoreTopic, options = {}) {
  const retryTopic = options.withTopicRetry || withTopicRetry;
  const sendText = options.sendBrokerText || sendBrokerText;
  const findConnected = options.connectedTarget || connectedTarget;
  const queueReply = options.queueTelegramReply || queueTelegramReply;
  const launchSession = options.launchWakeSession || launchWakeSession;
  return retryTopic(
    state,
    restoreTopic.sessionId,
    restoreTopic.cwd,
    restoreTopic.name,
    async (topic) => {
      const notice = await sendText(state, [
        `Restoring Pi session ${topic.sessionId.slice(0, 8)}…`,
        "Telegram cannot switch topics automatically; open this unread topic to continue.",
        "Pi will post a concise recap of the recovered context.",
      ].join("\n"), { threadId: topic.threadId });
      const message = {
        text: RESTORE_CONTEXT_PROMPT,
        message_id: notice?.message_id,
        message_thread_id: topic.threadId,
      };
      const target = { sessionId: topic.sessionId, threadId: topic.threadId };

      if (findConnected(state, topic.sessionId)) {
        return queueReply(state, target, message);
      }
      if (state.wakeLauncher.isRunning(topic.sessionId) || state.wakeReservations.has(topic.sessionId)) {
        return queueReply(state, target, message, true);
      }

      const launched = await launchSession(state, topic, RESTORE_CONTEXT_PROMPT, notice?.message_id);
      if (launched.started) return launched;
      if (findConnected(state, topic.sessionId) || launched.connected) {
        return queueReply(state, target, message);
      }
      if (launched.reserved || state.wakeLauncher.isRunning(topic.sessionId)) {
        return queueReply(state, target, message, true);
      }
      throw new Error("The Pi session did not start");
    },
  );
}

async function handleCallbackQuery(state, query, options = {}) {
  if (!query || typeof query.id !== "string") return;
  const authorized = query.message?.chat?.id === state.secret.chatId && query.from?.id === state.secret.allowedUserId;
  const command = authorized ? parseControlCallback(query.data) : undefined;
  const questionAction = authorized ? parseQuestionCallback(query.data) : undefined;
  const pendingQuestion = questionAction ? state.pendingQuestions?.get(questionAction.questionId) : undefined;
  const selectedAnswer = pendingQuestion?.options?.[questionAction?.optionIndex];
  const sessionAction = authorized ? parseSessionAction(query.data) : undefined;
  const actionTopic = sessionAction ? state.topics.get(sessionAction.sessionId) : undefined;
  const restoreSessionId = authorized ? parseRestoreCallback(query.data) : undefined;
  const restoreTopic = restoreSessionId ? state.topics.get(restoreSessionId) : undefined;
  if (!selectedAnswer) {
    await telegramCall(state.secret, "answerCallbackQuery", {
      callback_query_id: query.id,
      ...(!authorized ? { text: "Not allowed.", show_alert: true } : {}),
      ...(authorized && !command && !restoreTopic && !actionTopic ? { text: "This button is no longer available." } : {}),
      ...(restoreTopic ? {
        text: "Telegram cannot open topics automatically. Open the unread topic to see the restored context recap.",
        show_alert: true,
      } : {}),
    }).catch(warn("Cannot answer callback"));
  }
  if (!authorized) return;

  if (selectedAnswer && pendingQuestion) {
    const deliverAnswer = options.deliverQuestionAnswer || ((_state, question, answer) => {
      const client = state.clients?.get(question.clientId);
      if (!client?.registered || client.sessionId !== question.sessionId || typeof question.requestId !== "string") return false;
      sendLine(client.socket, {
        type: "result",
        requestId: question.requestId,
        questionId: question.questionId,
        ok: true,
        answer: String(answer),
      });
      return true;
    });
    pendingQuestion.answer = String(selectedAnswer);
    pendingQuestion.answeredAt = Date.now();
    await (options.queuePersist || queuePersist)(state);
    if (!deliverAnswer(state, pendingQuestion, selectedAnswer)) {
      await telegramCall(state.secret, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Pi is disconnected. This answer will be delivered if the question reconnects.",
        show_alert: true,
      }).catch(() => {});
      return;
    }
    await telegramCall(state.secret, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: `Selected: ${String(selectedAnswer).slice(0, 150)}`,
    }).catch(() => {});
    await telegramCall(state.secret, "editMessageText", {
      chat_id: state.secret.chatId,
      message_id: pendingQuestion.messageId,
      text: `${pendingQuestion.question}\n\nSelected: ${selectedAnswer}`,
      link_preview_options: { is_disabled: true },
    }).catch(() => {});
    const topic = state.topics.get(pendingQuestion.sessionId);
    if (topic) await (options.syncTopicDashboard || syncTopicDashboard)(state, topic, { phase: "Answer sent", detail: String(selectedAnswer) })
      .then(() => (options.queuePersist || queuePersist)(state)).catch(() => {});
    return;
  }

  if (actionTopic) {
    if (sessionAction.action === "refresh") {
      await updateDashboard(state, actionTopic, {
        phase: connectedTarget(state, actionTopic.sessionId) ? "Connected" : "Disconnected",
        detail: connectedTarget(state, actionTopic.sessionId) ? "Pi session connected" : "Pi session is not connected",
      });
      return;
    }
    if (sessionAction.action === "stop") {
      const stopped = sendSessionControl(state, actionTopic.sessionId, "stop");
      await updateDashboard(state, actionTopic, {
        phase: stopped ? "Stop requested" : "Disconnected",
        detail: stopped ? "Stopping the active Pi turn" : "Pi session is not connected",
      });
      return;
    }
    const text = sessionAction.action === "continue" ? "/continue" : "Retry the last failed operation.";
    await handleTelegramMessage(state, {
      message_id: query.message?.message_id,
      message_thread_id: actionTopic.threadId,
      text,
      chat: { id: state.secret.chatId },
      from: { id: state.secret.allowedUserId, is_bot: false },
    });
    await updateDashboard(state, actionTopic, { phase: "Command sent", detail: text });
    return;
  }

  if (restoreTopic) {
    try {
      await (options.restoreSessionTopic || restoreSessionTopic)(state, restoreTopic);
    } catch (error) {
      await sendBrokerText(state, `Could not restore Pi session: ${errorMessage(error)}`, {
        ...(Number.isSafeInteger(query.message?.message_thread_id) ? { threadId: query.message.message_thread_id } : {}),
      }).catch(() => {});
    }
    return;
  }

  if (!command || !Number.isSafeInteger(query.message?.message_id)) return;
  const panel = controlPanel(state, command);
  await telegramCall(state.secret, "editMessageText", {
    chat_id: state.secret.chatId,
    message_id: query.message.message_id,
    text: panel.text,
    link_preview_options: { is_disabled: true },
    reply_markup: panel.replyMarkup,
  }).catch((error) => {
    if (!/message is not modified/i.test(errorMessage(error))) {
      warn("Cannot update control panel")(error);
    }
  });
}

async function processTelegramUpdate(state, update, options = {}) {
  if (!Number.isSafeInteger(update?.update_id)) return false;
  if (update.message) await (options.handleTelegramMessage || handleTelegramMessage)(state, update.message);
  if (update.callback_query) await (options.handleCallbackQuery || handleCallbackQuery)(state, update.callback_query);
  state.offset = Math.max(state.offset, update.update_id + 1);
  await (options.queuePersist || queuePersist)(state);
  return true;
}

async function pollTelegram(state) {
  while (!state.closed) {
    const controller = new AbortController();
    state.pollController = controller;
    try {
      const updates = await telegramCall(state.secret, "getUpdates", {
        offset: state.offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      }, 35_000, controller.signal);
      for (const update of updates) await processTelegramUpdate(state, update);
    } catch (error) {
      if (!state.closed) {
        warn("Poll failed")(error);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    } finally {
      if (state.pollController === controller) state.pollController = undefined;
    }
  }
}

module.exports = Object.freeze({
  connectedTarget,
  deliverPendingForSession,
  deliverPendingReply,
  enqueueStream,
  pollTelegram,
  releaseWakeFollowups,
  sendBrokerText,
  syncTelegramCommandMenu,
  withTopicRetry,
  __test: Object.freeze({
    acknowledgeTelegramMessage,
    findReplyTarget,
    handleCallbackQuery,
    handleControlMessage,
    processTelegramUpdate,
    restoreSessionTopic,
    waitForWakeRegistration,
    waitForWakeStability,
    waitForWakeStop,
  }),
});

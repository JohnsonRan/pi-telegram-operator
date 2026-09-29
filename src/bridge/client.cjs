const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { PROTOCOL_VERSION, attachLineReader, sendLine } = require("./protocol.cjs");
const { startLocalLeader } = require("../broker/server.cjs");
const { WINDOWS_DAEMON_MARKER } = require("../shared/paths.cjs");
const { readSettings: readSecret } = require("../shared/settings.cjs");
const { errorMessage, warn } = require("../shared/errors.cjs");

const DAEMON_PATH = path.join(__dirname, "..", "..", "daemon.cjs");
const REQUEST_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 3_000;
const DELIVERY_DEDUPE_MAX = 512;

const clientStates = new WeakMap();
let localLeaderPromise;
let daemonLaunchPromise;

async function launchDetachedWakeDaemon() {
  if (!daemonLaunchPromise) {
    daemonLaunchPromise = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DAEMON_PATH, WINDOWS_DAEMON_MARKER], {
        detached: true,
        env: { ...process.env, PI_TELEGRAM_DAEMON: "1" },
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("spawn", () => {
        child.unref();
        resolve(undefined);
      });
      child.once("error", reject);
    }).finally(() => {
      daemonLaunchPromise = undefined;
    });
  }
  return daemonLaunchPromise;
}

async function ensureLocalLeader(secret) {
  if (!localLeaderPromise) {
    localLeaderPromise = startLocalLeader(secret).catch((error) => {
      localLeaderPromise = undefined;
      throw error;
    });
  }
  const leader = await localLeaderPromise;
  // Another process may own the port now but disappear before our next retry.
  if (!leader || leader.closed) localLeaderPromise = undefined;
  if (leader?.closed) return ensureLocalLeader(secret);
  return leader;
}

function registerClient(state) {
  if (!state.socket || state.socket.destroyed) return;
  sendLine(state.socket, {
    type: "register",
    version: PROTOCOL_VERSION,
    auth: state.secret.bridgeSecret,
    clientId: state.clientId,
    sessionId: state.sessionId,
    cwd: state.cwd,
    sessionName: state.sessionName,
    commands: state.commands,
    wakeChild: process.env.PI_TELEGRAM_WAKE_CHILD === "1",
  });
}

// Durable requests (questions) survive a disconnect: the broker keeps them
// and replays the answer when this client registers again.
function rejectPending(state, error, includeDurable = true) {
  for (const [requestId, pending] of state.pending) {
    if (pending.durable && !includeDurable) continue;
    state.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function scheduleReconnect(state) {
  // A superseded client waits for its own activity or a session change.
  if (state.closed || state.superseded || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined;
    connectClient(state).catch(() => scheduleReconnect(state));
  }, 1_000);
  state.reconnectTimer.unref?.();
}

async function connectClient(state) {
  if (state.closed) throw new Error("Telegram bridge client is closed");
  state.superseded = false;
  if (state.connected && state.socket && !state.socket.destroyed) return;
  if (state.connectPromise) return state.connectPromise;

  state.connectPromise = (async () => {
    const attempt = () => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: state.secret.port });
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.setNoDelay(true);
        state.socket = socket;
        state.connected = false;
        const timer = setTimeout(() => {
          state.handshake = undefined;
          socket.destroy();
          reject(new Error("Telegram bridge handshake timed out"));
        }, HANDSHAKE_TIMEOUT_MS);
        state.handshake = {
          resolve: () => {
            clearTimeout(timer);
            state.handshake = undefined;
            state.connected = true;
            resolve(undefined);
          },
          reject: (error) => {
            clearTimeout(timer);
            state.handshake = undefined;
            reject(error);
          },
        };
        attachLineReader(socket, (message) => handleClientMessage(state, message), (error) => socket.destroy(error));
        socket.on("close", () => {
          if (state.socket !== socket) return;
          state.handshake?.reject(new Error("Telegram bridge disconnected during handshake"));
          state.connected = false;
          state.socket = undefined;
          rejectPending(state, new Error("Telegram bridge disconnected"), false);
          scheduleReconnect(state);
        });
        socket.on("error", () => {});
        registerClient(state);
      });
    });

    try {
      await attempt();
    } catch (firstError) {
      if (state.secret.wakeMode && process.env.PI_TELEGRAM_DAEMON !== "1") {
        await launchDetachedWakeDaemon();
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          await attempt();
          return;
        } catch {}
      }
      await ensureLocalLeader(state.secret);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await attempt();
      } catch {
        throw firstError;
      }
    }
  })().finally(() => {
    state.connectPromise = undefined;
  });
  return state.connectPromise;
}

function handleClientMessage(state, message) {
  if (message?.type === "registered") {
    if (message.version !== PROTOCOL_VERSION) {
      state.handshake?.reject(new Error("Telegram bridge protocol version mismatch"));
      state.socket?.destroy();
      return;
    }
    state.handshake?.resolve();
    return;
  }
  if (message?.type === "result" && typeof message.requestId === "string") {
    const pending = state.pending.get(message.requestId);
    if (pending) {
      state.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message);
      else pending.reject(new Error(message.error || "Telegram notification failed"));
    }
    if (typeof message.questionId === "string" && state.socket && !state.socket.destroyed) {
      sendLine(state.socket, {
        type: "questionAck",
        auth: state.secret.bridgeSecret,
        sessionId: state.sessionId,
        questionId: message.questionId,
      });
    }
    return;
  }
  if (message?.type === "superseded") {
    state.superseded = true;
    return;
  }
  if (message?.type === "control" && message.sessionId === state.sessionId && message.action === "stop") {
    // abort lives on the extension context, not on the extension API.
    state.ctx?.abort?.();
    return;
  }
  if (message?.type !== "reply" || typeof message.text !== "string" || typeof message.deliveryId !== "string") return;
  const sendAck = (ok, error) => sendLine(state.socket, {
    type: "replyAck",
    auth: state.secret.bridgeSecret,
    deliveryId: message.deliveryId,
    ok,
    ...(error ? { error } : {}),
  });
  if (state.seenDeliveries.has(message.deliveryId)) {
    sendAck(true);
    return;
  }
  const liveSessionId = state.ctx?.sessionManager?.getSessionId?.();
  if (message.sessionId !== state.sessionId || liveSessionId !== message.sessionId) {
    if (typeof liveSessionId === "string" && liveSessionId !== state.sessionId) {
      state.sessionId = liveSessionId;
      state.cwd = String(state.ctx?.cwd || state.cwd);
      registerClient(state);
    }
    sendAck(false, "Target Pi session is not active in this process");
    return;
  }
  try {
    if (state.ctx?.isIdle?.() === false) {
      state.pi.sendUserMessage(message.text, { deliverAs: "steer", expandPromptTemplates: true });
    } else {
      state.pi.sendUserMessage(message.text, { expandPromptTemplates: true });
    }
    rememberDelivery(state, message.deliveryId);
    sendAck(true);
  } catch (error) {
    const detail = errorMessage(error);
    sendAck(false, detail);
    warn("Cannot inject reply")(error);
  }
}

function hydrateSeenDeliveries(state) {
  state.seenDeliveries.clear();
  const entries = state.ctx?.sessionManager?.getEntries?.() || [];
  for (const entry of entries.slice(-DELIVERY_DEDUPE_MAX * 2)) {
    if (entry?.type !== "custom" || entry.customType !== "pi_notify_telegram_delivery") continue;
    const deliveryId = entry.data?.deliveryId;
    if (typeof deliveryId === "string") state.seenDeliveries.add(deliveryId);
  }
  trimSeenDeliveries(state);
}

function trimSeenDeliveries(state) {
  while (state.seenDeliveries.size > DELIVERY_DEDUPE_MAX) {
    state.seenDeliveries.delete(state.seenDeliveries.values().next().value);
  }
}

function rememberDelivery(state, deliveryId) {
  state.seenDeliveries.add(deliveryId);
  trimSeenDeliveries(state);
  state.pi.appendEntry?.("pi_notify_telegram_delivery", { deliveryId });
}

function availablePiCommands(pi) {
  try {
    return (typeof pi.getCommands === "function" ? pi.getCommands() : [])
      .filter((command) => command && typeof command.name === "string")
      .map((command) => ({
        name: command.name,
        description: command.description,
        source: command.source,
      }));
  } catch {
    return [];
  }
}

// Copies the live session identity into state; returns true when it changed.
function syncSession(state, ctx) {
  state.ctx = ctx;
  const next = {
    sessionId: String(ctx?.sessionManager?.getSessionId?.() || ""),
    cwd: String(ctx?.cwd || ""),
    sessionName: String(state.pi.getSessionName?.() || ""),
    commands: availablePiCommands(state.pi),
  };
  const changed = Object.keys(next).some((key) => JSON.stringify(state[key]) !== JSON.stringify(next[key]));
  Object.assign(state, next);
  if (changed) hydrateSeenDeliveries(state);
  return changed;
}

function clientStateFor(pi, ctx) {
  let state = clientStates.get(pi);
  if (!state) {
    state = {
      pi,
      ctx,
      secret: undefined,
      clientId: randomUUID(),
      sessionId: undefined,
      cwd: undefined,
      sessionName: undefined,
      commands: undefined,
      socket: undefined,
      connected: false,
      ready: undefined,
      connectPromise: undefined,
      handshake: undefined,
      reconnectTimer: undefined,
      superseded: false,
      pending: new Map(),
      seenDeliveries: new Set(),
      currentStream: undefined,
      agentActivity: undefined,
      statusHeartbeat: undefined,
      closed: false,
    };
    clientStates.set(pi, state);
    const refreshSession = (_event, liveCtx) => {
      if (!liveCtx?.sessionManager || !syncSession(state, liveCtx)) return;
      registerClient(state);
      if (state.superseded && state.secret) connectClient(state).catch(() => scheduleReconnect(state));
    };
    pi.on("session_start", refreshSession);
    pi.on("session_info_changed", refreshSession);
    pi.on("session_shutdown", () => {
      state.closed = true;
      if (state.currentStream?.timer) clearTimeout(state.currentStream.timer);
      if (state.statusHeartbeat) clearTimeout(state.statusHeartbeat);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      rejectPending(state, new Error("Pi session shut down"));
      state.socket?.destroy();
      clientStates.delete(pi);
    });
  }
  if (syncSession(state, ctx) && state.connected) registerClient(state);
  return state;
}

async function requestBroker(state, payload, timeoutLabel, timeoutMs = REQUEST_TIMEOUT_MS, options = {}) {
  const { durable = false, signal } = options;
  signal?.throwIfAborted();
  await connectClient(state);
  signal?.throwIfAborted();
  if (!state.socket || state.socket.destroyed) throw new Error("Telegram bridge disconnected");
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const settle = (callback) => (value) => {
      clearTimeout(timer);
      state.pending.delete(requestId);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = settle(() => reject(signal.reason));
    const timer = setTimeout(settle(() => reject(new Error(`${timeoutLabel} timed out`))), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    state.pending.set(requestId, { resolve: settle(resolve), reject: settle(reject), timer, durable });
    sendLine(state.socket, {
      ...payload,
      auth: state.secret.bridgeSecret,
      requestId,
      sessionId: state.sessionId,
    });
  });
}

function requestNotification(state, title, body) {
  return requestBroker(state, {
    type: "notify",
    title: String(title ?? "Pi"),
    body: String(body ?? ""),
    cwd: state.cwd,
    sessionName: state.sessionName,
  }, "Telegram notification");
}

function requestArtifact(state, filePath, caption) {
  return requestBroker(state, {
    type: "artifact",
    path: String(filePath || ""),
    caption: String(caption || ""),
  }, "Telegram artifact upload", 75_000);
}

function requestQuestion(state, question, options, signal) {
  return requestBroker(state, {
    type: "question",
    question: String(question || "Pi needs your input"),
    options: Array.isArray(options) ? options.map(String) : [],
  }, "Telegram question", 24 * 60 * 60 * 1_000, { durable: true, signal });
}

async function initializeState(pi, ctx) {
  const state = clientStateFor(pi, ctx);
  if (!state.ready) {
    state.ready = (async () => {
      if (!state.secret) state.secret = await readSecret();
      await connectClient(state);
      return state;
    })().catch((error) => {
      state.ready = undefined;
      throw error;
    });
  }
  return state.ready;
}

function getClientState(pi) {
  return clientStates.get(pi);
}

module.exports = Object.freeze({
  connectClient,
  getClientState,
  initializeState,
  requestArtifact,
  requestBroker,
  requestNotification,
  requestQuestion,
  __test: Object.freeze({ handleClientMessage, rejectPending, scheduleReconnect }),
});

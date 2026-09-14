const { randomInt } = require("node:crypto");
const { connectClient, getClientState, initializeState, requestBroker } = require("../bridge/client.cjs");
const { sendLine } = require("../bridge/protocol.cjs");
const { assistantText, formatLiveStatus } = require("./live-status.cjs");
const { errorMessage } = require("../telegram/api.cjs");

const STREAM_THROTTLE_MS = 1_200;
const STATUS_HEARTBEAT_MS = 5_000;
const attachedApis = new WeakSet();

function streamDraftText(stream) {
  return stream.text.trim() ? stream.text : stream.statusText || "Main agent · Running";
}

async function sendStream(state, type, stream) {
  if (state.ready) await state.ready;
  if (type === "streamFinal") {
    const payload = { type, draftId: stream.draftId, text: stream.text };
    try {
      await requestBroker(state, payload, "Telegram stream finalization");
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await requestBroker(state, payload, "Telegram stream finalization retry");
    }
    return;
  }
  await connectClient(state);
  sendLine(state.socket, {
    type,
    auth: state.secret.bridgeSecret,
    sessionId: state.sessionId,
    draftId: stream.draftId,
    text: streamDraftText(stream),
  });
}

function ensureStatusStream(state) {
  if (!state.currentStream) {
    state.currentStream = {
      draftId: randomInt(1, 2_147_483_647),
      text: "",
      statusText: "",
      lastSent: undefined,
      timer: undefined,
    };
  }
  return state.currentStream;
}

function updateLiveStatus(state) {
  if (!state?.agentActivity || state.closed) return;
  const stream = ensureStatusStream(state);
  stream.statusText = formatLiveStatus(state.agentActivity);
  scheduleStreamDraft(state);
}

function scheduleStatusHeartbeat(state) {
  if (state.statusHeartbeat || state.closed || !state.agentActivity) return;
  state.statusHeartbeat = setTimeout(() => {
    state.statusHeartbeat = undefined;
    updateLiveStatus(state);
    scheduleStatusHeartbeat(state);
  }, STATUS_HEARTBEAT_MS);
  state.statusHeartbeat.unref?.();
}

function scheduleStreamDraft(state) {
  const stream = state.currentStream;
  if (!stream || stream.timer) return;
  stream.timer = setTimeout(() => {
    stream.timer = undefined;
    const text = streamDraftText(stream);
    if (state.currentStream !== stream || text === stream.lastSent) return;
    stream.lastSent = text;
    sendStream(state, "streamDraft", stream).catch((error) => {
      console.warn(`[pi-telegram-operator] Cannot stream draft: ${errorMessage(error)}`);
    });
  }, STREAM_THROTTLE_MS);
  stream.timer.unref?.();
}

function attach(pi) {
  if (!pi || typeof pi.on !== "function" || attachedApis.has(pi)) return;
  attachedApis.add(pi);

  pi.on("session_start", (_event, ctx) => {
    return initializeState(pi, ctx).catch((error) => {
      console.warn(`[pi-telegram-operator] Cannot initialize: ${errorMessage(error)}`);
    });
  });

  pi.on("agent_start", () => {
    const state = getClientState(pi);
    if (!state?.secret || state.closed) return;
    state.agentActivity = { startedAt: Date.now(), turnIndex: 0, phase: "Thinking" };
    updateLiveStatus(state);
    scheduleStatusHeartbeat(state);
  });

  pi.on("turn_start", (event) => {
    const state = getClientState(pi);
    if (!state || state.closed || !state.agentActivity) return;
    state.agentActivity.turnIndex = event.turnIndex;
    state.agentActivity.phase = "Thinking";
    state.agentActivity.toolName = undefined;
    state.agentActivity.toolArgs = undefined;
    state.agentActivity.partialResult = undefined;
    state.agentActivity.toolError = false;
    updateLiveStatus(state);
  });

  pi.on("tool_execution_start", (event) => {
    const state = getClientState(pi);
    if (!state || state.closed || !state.agentActivity) return;
    state.agentActivity.phase = "Running tool";
    state.agentActivity.toolName = event.toolName;
    state.agentActivity.toolArgs = event.args;
    state.agentActivity.partialResult = undefined;
    state.agentActivity.toolError = false;
    updateLiveStatus(state);
  });

  pi.on("tool_execution_update", (event) => {
    const state = getClientState(pi);
    if (!state || state.closed || !state.agentActivity || state.agentActivity.toolName !== event.toolName) return;
    state.agentActivity.partialResult = event.partialResult;
    updateLiveStatus(state);
  });

  pi.on("tool_execution_end", (event) => {
    const state = getClientState(pi);
    if (!state || state.closed || !state.agentActivity) return;
    state.agentActivity.phase = event.isError ? "Tool failed; reviewing" : "Reviewing tool result";
    state.agentActivity.toolName = event.toolName;
    state.agentActivity.toolError = event.isError;
    updateLiveStatus(state);
  });

  pi.on("message_start", (event) => {
    if (event.message?.role !== "assistant") return;
    const state = getClientState(pi);
    if (!state?.secret || state.closed) return;
    const stream = ensureStatusStream(state);
    stream.text = assistantText(event.message);
    const text = streamDraftText(stream);
    stream.lastSent = text;
    sendStream(state, "streamDraft", stream).catch((error) => {
      console.warn(`[pi-telegram-operator] Cannot start stream: ${errorMessage(error)}`);
    });
  });

  pi.on("message_update", (event) => {
    const state = getClientState(pi);
    const stream = state?.currentStream;
    if (!stream || event.message?.role !== "assistant") return;
    stream.text = assistantText(event.message);
    scheduleStreamDraft(state);
  });

  pi.on("message_end", (event) => {
    const state = getClientState(pi);
    const stream = state?.currentStream;
    if (!state || !stream || event.message?.role !== "assistant") return;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
    stream.text = assistantText(event.message);
    state.currentStream = undefined;
    sendStream(state, "streamFinal", stream).catch((error) => {
      console.warn(`[pi-telegram-operator] Cannot finalize stream: ${errorMessage(error)}`);
    });
  });

  pi.on("agent_settled", () => {
    const state = getClientState(pi);
    if (!state) return;
    if (state.statusHeartbeat) clearTimeout(state.statusHeartbeat);
    state.statusHeartbeat = undefined;
    state.agentActivity = undefined;
  });
}

module.exports = Object.freeze({ attach });

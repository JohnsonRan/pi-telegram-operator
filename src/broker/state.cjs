const { randomUUID } = require("node:crypto");
const { readFile, rename, unlink, writeFile } = require("node:fs/promises");
const { STATE_PATH } = require("../shared/paths.cjs");

const MAX_MAPPINGS = 200;
const MAX_PENDING_REPLIES = 1000;
const MAX_PENDING_QUESTIONS = 100;
const MAX_TOPICS = 2000;
const STATE_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function readBrokerState(statePath = STATE_PATH) {
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    const offset = Number.isSafeInteger(raw?.offset) && raw.offset >= 0 ? raw.offset : 0;
    const mappings = Array.isArray(raw?.mappings)
      ? raw.mappings
          .filter((item) => item && Number.isSafeInteger(item.messageId) && Number.isSafeInteger(item.threadId) && typeof item.sessionId === "string")
          .slice(-MAX_MAPPINGS)
      : [];
    const pendingReplies = Array.isArray(raw?.pendingReplies)
      ? raw.pendingReplies.filter((item) => item && typeof item.deliveryId === "string" && typeof item.sessionId === "string" && typeof item.text === "string").slice(-MAX_PENDING_REPLIES)
      : [];
    const pendingQuestions = Array.isArray(raw?.pendingQuestions)
      ? raw.pendingQuestions.filter((item) => item && typeof item.questionId === "string" && typeof item.sessionId === "string" && Array.isArray(item.options)).slice(-MAX_PENDING_QUESTIONS)
      : [];
    const topics = Array.isArray(raw?.topics)
      ? raw.topics.filter((item) => item && typeof item.sessionId === "string" && Number.isSafeInteger(item.threadId)).slice(-MAX_TOPICS)
      : [];
    return { offset, mappings, pendingReplies, pendingQuestions, topics };
  } catch (error) {
    if (error?.code === "ENOENT") return { offset: 0, mappings: [], pendingReplies: [], pendingQuestions: [], topics: [] };
    if (error instanceof SyntaxError) throw new Error(`Telegram state contains invalid JSON: ${statePath}`, { cause: error });
    throw error;
  }
}

async function writeStateFile(statePath, content) {
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, statePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function persistBrokerState(state, statePath = STATE_PATH) {
  const mappings = [...state.mappings.values()].slice(-MAX_MAPPINGS);
  const pendingReplies = [...state.pendingReplies.values()]
    .slice(-MAX_PENDING_REPLIES)
    .map(({ retryTimer: _retryTimer, ...item }) => item);
  const pendingQuestions = [...(state.pendingQuestions?.values?.() || [])].slice(-MAX_PENDING_QUESTIONS);
  const topics = [...state.topics.values()].slice(-MAX_TOPICS);
  const content = `${JSON.stringify({ offset: state.offset, mappings, pendingReplies, pendingQuestions, topics }, null, 2)}\n`;
  await writeStateFile(statePath, content);
}

function queuePersist(state) {
  state.persistQueue = state.persistQueue
    .catch(() => {})
    .then(() => persistBrokerState(state));
  return state.persistQueue;
}

function trimMappings(state) {
  while (state.mappings.size > MAX_MAPPINGS) {
    state.mappings.delete(state.mappings.keys().next().value);
  }
}

function pruneExpiredBrokerState(state, now = Date.now()) {
  const cutoff = now - STATE_ENTRY_RETENTION_MS;
  let changed = false;
  for (const [messageId, mapping] of state.mappings) {
    if (Number.isFinite(mapping.createdAt) && mapping.createdAt < cutoff) {
      state.mappings.delete(messageId);
      changed = true;
    }
  }
  for (const [deliveryId, pending] of state.pendingReplies) {
    if (Number.isFinite(pending.createdAt) && pending.createdAt < cutoff) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      state.pendingReplies.delete(deliveryId);
      changed = true;
    }
  }
  for (const [questionId, pending] of state.pendingQuestions || []) {
    if (Number.isFinite(pending.createdAt) && pending.createdAt < cutoff) {
      state.pendingQuestions.delete(questionId);
      changed = true;
    }
  }
  return changed;
}

module.exports = Object.freeze({
  MAX_MAPPINGS,
  MAX_PENDING_QUESTIONS,
  MAX_PENDING_REPLIES,
  MAX_TOPICS,
  persistBrokerState,
  pruneExpiredBrokerState,
  queuePersist,
  readBrokerState,
  trimMappings,
});

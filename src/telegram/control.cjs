const { createHash } = require("node:crypto");
const path = require("node:path");
const { formatLocalTimestamp } = require("../shared/time.cjs");
const { version: PACKAGE_VERSION } = require("../../package.json");

const CONTROL_COMMANDS = Object.freeze([
  { command: "update", description: "Update Pi and extensions, then restart the service" },
  { command: "clone", description: "Clone a Git repository and run Pi" },
  { command: "new", description: "Create a new Pi session" },
  { command: "sessions", description: "List known Pi sessions" },
  { command: "status", description: "Show the Pi wake broker status" },
  { command: "help", description: "Show Telegram wake commands" },
]);
const CONTROL_CALLBACK_PREFIX = "control:";
const CONTROL_PANEL_COMMANDS = new Set(["help", "sessions", "status"]);
const RESTORE_CONTEXT_PROMPT = [
  "Resume this existing Pi session and provide a concise context recap.",
  "Summarize the current objective, key decisions, completed work, and open next steps.",
  "Do not modify files or run tools for this recap.",
].join(" ");

function formatDuration(milliseconds) {
  let seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [
    ...(days ? [`${days}d`] : []),
    ...(hours ? [`${hours}h`] : []),
    ...(minutes ? [`${minutes}m`] : []),
    `${seconds}s`,
  ].join(" ");
}

function formatBrokerStatus(state, now = Date.now()) {
  const startedAt = Number(state.startedAt) || now;
  return [
    "TelegraPi broker is running.",
    `Broker PID: ${state.pid || process.pid}`,
    `Version: ${state.packageVersion || PACKAGE_VERSION}`,
    `Started: ${formatLocalTimestamp(startedAt)}`,
    `Uptime: ${formatDuration(now - startedAt)}`,
    `Connected Pi sessions: ${state.clientsBySession.size}`,
    `Preferred wake mode: ${state.secret.wakeOpenTerminal ? "foreground terminal (auto fallback)" : "background"}`,
    `Wake Pi sessions: ${state.wakeLauncher.runningSessionIds().length}`,
    `Known topics: ${state.topics.size}`,
  ].join("\n");
}

function controlKeyboard(command, topics = []) {
  const button = (text, target) => ({ text, callback_data: `${CONTROL_CALLBACK_PREFIX}${target}` });
  if (command === "status") {
    return { inline_keyboard: [[button("Refresh", "status"), button("Sessions", "sessions")], [button("Help", "help")]] };
  }
  if (command === "sessions") {
    const sessionButtons = topics.map((topic) => [{
      text: `Restore + recap ${String(topic.name || topic.sessionId.slice(0, 8)).slice(0, 40)}`,
      callback_data: `restore:${topic.sessionId}`,
    }]);
    return {
      inline_keyboard: [
        ...sessionButtons,
        [button("Refresh", "sessions"), button("Status", "status")],
        [button("Help", "help")],
      ],
    };
  }
  return { inline_keyboard: [[button("Status", "status"), button("Sessions", "sessions")]] };
}

function controlPanel(state, command, now = Date.now()) {
  if (command === "status") {
    return { text: formatBrokerStatus(state, now), replyMarkup: controlKeyboard(command) };
  }
  if (command === "sessions") {
    const topics = [...state.topics.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20);
    const text = topics.length === 0
      ? "No Pi session topics are known yet."
      : ["Known Pi sessions:", ...topics.map((topic) => `${topic.name || "Pi"} · ${topic.sessionId.slice(0, 8)} · ${topic.cwd || "no cwd"}`)].join("\n");
    return { text, replyMarkup: controlKeyboard(command, topics) };
  }
  return {
    text: [
      "TelegraPi commands:",
      "/update — run pi update --all, then restart the background service",
      "pi update --all — same as /update",
      "/clone <repository-url> [directory] — clone into wakeDefaultCwd and run Pi",
      "git clone <repository-url> [directory] — same as /clone",
      "/new <cwd> | <prompt> — create and run a session",
      "/new <cwd> — create a session topic without running it",
      "/new | <prompt> — use wakeDefaultCwd",
      "/sessions — list known session topics",
      "/status — show broker status",
    ].join("\n"),
    replyMarkup: controlKeyboard("help"),
  };
}

function parseControlCallback(value) {
  const text = String(value || "");
  if (!text.startsWith(CONTROL_CALLBACK_PREFIX)) return undefined;
  const command = text.slice(CONTROL_CALLBACK_PREFIX.length);
  return CONTROL_PANEL_COMMANDS.has(command) ? command : undefined;
}

function parseRestoreCallback(value) {
  const match = String(value || "").match(/^restore:([0-9a-f-]{36})$/i);
  return match?.[1];
}

function formatWakeExitDetail(stderr) {
  const detail = String(stderr || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  if (!detail) return "";
  return detail.length > 1600 ? `…${detail.slice(-1599)}` : detail;
}

function normalizePiCommands(commands) {
  const used = new Set(CONTROL_COMMANDS.map((item) => item.command));
  const result = [];
  for (const item of Array.isArray(commands) ? commands : []) {
    const name = String(item?.name || "").trim();
    if (!name || name === "telegram-wake") continue;
    const normalized = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
    let telegramName = normalized || `pi_${hash}`;
    if (telegramName.length > 32 || used.has(telegramName)) {
      telegramName = `${(normalized || "pi").slice(0, 25)}_${hash}`.slice(0, 32);
    }
    let suffix = 1;
    const base = telegramName.slice(0, 29);
    while (used.has(telegramName)) telegramName = `${base}_${suffix++}`.slice(0, 32);
    used.add(telegramName);
    const description = String(item?.description || `${item?.source || "Pi"} command: /${name}`)
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 256) || `Run /${name}`;
    result.push({ name, telegramName, description, source: String(item?.source || "extension") });
    if (result.length >= 96) break;
  }
  return result;
}

function translateTelegramCommand(topic, text) {
  const value = String(text || "");
  const match = value.match(/^\/([^\s@]+)(?:@\w+)?([\s\S]*)$/);
  if (!match) return value;
  const command = Array.isArray(topic?.commands)
    ? topic.commands.find((item) => item.telegramName === match[1] || item.name === match[1])
    : undefined;
  return command ? `/${command.name}${match[2] || ""}` : value;
}

function topicName(sessionId, cwd, sessionName) {
  const base = String(sessionName || path.basename(String(cwd || "")) || "Pi").replace(/[\r\n\u0000-\u001f]+/g, " ").trim() || "Pi";
  const suffix = ` · ${String(sessionId).slice(0, 8)}`;
  return (base.endsWith(suffix) ? base : `${base}${suffix}`).slice(0, 128);
}

module.exports = Object.freeze({
  CONTROL_COMMANDS,
  CONTROL_PANEL_COMMANDS,
  RESTORE_CONTEXT_PROMPT,
  controlKeyboard,
  controlPanel,
  formatBrokerStatus,
  formatDuration,
  formatWakeExitDetail,
  normalizePiCommands,
  parseControlCallback,
  parseRestoreCallback,
  topicName,
  translateTelegramCommand,
});

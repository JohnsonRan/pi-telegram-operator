const { readFile } = require("node:fs/promises");
const {
  CONFIG_PATH,
  DEFAULT_PORT,
  SECRET_PATH,
} = require("./paths.cjs");
const { DEFAULT_API_BASE_URL } = require("../telegram/api.cjs");

function normalizeApiBaseUrl(value) {
  const text = String(value || DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (!url || !["http:", "https:"].includes(url.protocol) || /[?#]/.test(text)) {
    throw new Error("apiBaseUrl must be an http(s) URL without query or fragment");
  }
  // fetch refuses credentialed URLs and echoes the whole URL, bot token included.
  if (url.username || url.password) throw new Error("apiBaseUrl must not contain a username or password");
  return text;
}

function isValidApiBaseUrl(value) {
  try {
    return typeof value === "string" && Boolean(normalizeApiBaseUrl(value));
  } catch {
    return false;
  }
}

const OPERATIONAL_CONFIG_VALIDATORS = Object.freeze({
  port: (value) => Number.isInteger(value) && value >= 1024 && value <= 65535,
  linkPreview: (value) => typeof value === "boolean",
  apiBaseUrl: isValidApiBaseUrl,
  wakeMode: (value) => typeof value === "boolean",
  wakeDefaultCwd: (value) => typeof value === "string",
  wakeAllowedRoots: (value) => Array.isArray(value) && value.every((root) => typeof root === "string"),
  wakePiCommand: (value) => typeof value === "string" && value.length > 0,
  wakePiCommandArgs: (value) => Array.isArray(value) && value.every((argument) => typeof argument === "string"),
  wakeOpenTerminal: (value) => typeof value === "boolean",
});

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;

function asInteger(value, name) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be a safe integer`);
  return number;
}

function preserveOperationalConfig(config, previousConfig) {
  for (const [key, isValid] of Object.entries(OPERATIONAL_CONFIG_VALIDATORS)) {
    if (isValid(previousConfig[key])) config[key] = previousConfig[key];
  }
  return config;
}

function validateSettings(botTokenValue, raw) {
  const botToken = String(botTokenValue || "").trim();
  if (!BOT_TOKEN_PATTERN.test(botToken)) throw new Error("Telegram bot token is invalid");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Telegram config must be a JSON object");
  const chatId = asInteger(raw.chatId, "chatId");
  const allowedUserId = asInteger(raw.allowedUserId ?? chatId, "allowedUserId");
  const bridgeSecret = String(raw.bridgeSecret || "").trim();
  if (!/^[a-f0-9]{32,128}$/i.test(bridgeSecret)) throw new Error("bridgeSecret is invalid");
  const port = raw.port === undefined ? DEFAULT_PORT : asInteger(raw.port, "port");
  if (port < 1024 || port > 65535) throw new Error("port must be between 1024 and 65535");
  const linkPreview = raw.linkPreview === true;
  const apiBaseUrl = normalizeApiBaseUrl(raw.apiBaseUrl);
  const wakeMode = raw.wakeMode === true;
  const wakeDefaultCwd = String(raw.wakeDefaultCwd || "").trim();
  const wakeAllowedRoots = Array.isArray(raw.wakeAllowedRoots)
    ? raw.wakeAllowedRoots.map((root) => String(root || "").trim()).filter(Boolean)
    : [];
  if (wakeMode && wakeAllowedRoots.length === 0) throw new Error("wakeAllowedRoots must contain at least one directory when wakeMode is enabled");
  const wakePiCommand = String(raw.wakePiCommand || "pi").trim() || "pi";
  if (raw.wakeOpenTerminal !== undefined && typeof raw.wakeOpenTerminal !== "boolean") {
    throw new Error("wakeOpenTerminal must be a boolean");
  }
  const wakeOpenTerminal = raw.wakeOpenTerminal ?? true;
  const wakePiCommandArgs = Array.isArray(raw.wakePiCommandArgs)
    ? raw.wakePiCommandArgs.map((argument) => String(argument))
    : [];
  return Object.freeze({
    botToken,
    chatId,
    allowedUserId,
    bridgeSecret,
    port,
    linkPreview,
    apiBaseUrl,
    wakeMode,
    wakeDefaultCwd,
    wakeAllowedRoots: Object.freeze(wakeAllowedRoots),
    wakePiCommand,
    wakePiCommandArgs: Object.freeze(wakePiCommandArgs),
    wakeOpenTerminal,
  });
}

async function readOptional(read, file) {
  try {
    return await read(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readSettings(options = {}) {
  const read = options.readFile || readFile;
  const configPath = options.configPath || CONFIG_PATH;
  const [token, configText] = await Promise.all([
    readOptional(read, options.secretPath || SECRET_PATH),
    readOptional(read, configPath),
  ]);
  if (token === undefined && configText === undefined) {
    throw new Error("Telegram setup is incomplete. Run the installed pi-telegram-operator setup.cjs first.");
  }
  if (token === undefined || configText === undefined) {
    throw new Error("TelegraPi Telegram settings are incomplete; both secret and config files are required");
  }
  let raw;
  try {
    raw = JSON.parse(configText);
  } catch {
    throw new Error(`Telegram config contains invalid JSON: ${configPath}`);
  }
  return validateSettings(token, raw);
}

module.exports = Object.freeze({ BOT_TOKEN_PATTERN, normalizeApiBaseUrl, preserveOperationalConfig, readSettings, validateSettings });

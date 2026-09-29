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
  if (!url || !["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("apiBaseUrl must be an http(s) URL without query or fragment");
  }
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
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error("Telegram bot token is invalid");
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

async function readSettingsPair(read, secretPath, configPath, label) {
  const [token, configText] = await Promise.all([
    readOptional(read, secretPath),
    readOptional(read, configPath),
  ]);
  const count = Number(token !== undefined) + Number(configText !== undefined);
  if (count === 0) return undefined;
  if (count !== 2) return { incomplete: true, label };
  try {
    return { settings: validateSettings(token, JSON.parse(configText)) };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Telegram config contains invalid JSON: ${configPath}`);
    throw error;
  }
}

async function readSettings(options = {}) {
  const read = options.readFile || readFile;
  const secretPath = options.secretPath || SECRET_PATH;
  const configPath = options.configPath || CONFIG_PATH;
  const pair = await readSettingsPair(read, secretPath, configPath, "TelegraPi");
  if (pair?.incomplete) {
    throw new Error(`${pair.label} Telegram settings are incomplete; both secret and config files are required`);
  }
  if (!pair?.settings) {
    throw new Error("Telegram setup is incomplete. Run the installed pi-telegram-operator setup.cjs first.");
  }
  return pair.settings;
}

module.exports = Object.freeze({ normalizeApiBaseUrl, preserveOperationalConfig, readSettings, validateSettings });

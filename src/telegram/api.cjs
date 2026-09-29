const { errorMessage } = require("../shared/errors.cjs");

const DEFAULT_API_BASE_URL = "https://api.telegram.org";

// Builds a Bot API URL; path is "bot<token>/<method>" or "file/bot<token>/<file_path>".
function telegramUrl(secret, path) {
  return `${secret.apiBaseUrl || DEFAULT_API_BASE_URL}/${path}`;
}

// Network errors can quote the request URL, which contains the bot token.
function redactToken(secret, text) {
  return secret.botToken ? String(text).split(secret.botToken).join("<bot-token>") : String(text);
}

async function postTelegram(secret, method, init, timeoutMs, externalSignal) {
  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    response = await fetch(telegramUrl(secret, `bot${secret.botToken}/${method}`), {
      method: "POST",
      ...init,
      signal: externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal,
    });
  } catch (error) {
    throw new Error(`Telegram ${method} failed: ${redactToken(secret, errorMessage(error))}`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON (HTTP ${response.status})`);
  }
  if (response.ok && result?.ok === true) return result.result;
  throw Object.assign(new Error(`Telegram ${method} failed: ${result?.description || `HTTP ${response.status}`}`), {
    status: response.status,
    retryAfter: Number(result?.parameters?.retry_after),
  });
}

async function telegramCall(secret, method, payload, timeoutMs = 20_000, externalSignal) {
  const init = { headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) };
  try {
    return await postTelegram(secret, method, init, timeoutMs, externalSignal);
  } catch (error) {
    const retryAfter = error.retryAfter;
    if (error.status !== 429 || !Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 60) throw error;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000 + 250));
    return postTelegram(secret, method, init, timeoutMs, externalSignal);
  }
}

function telegramMultipartCall(secret, method, form, timeoutMs = 60_000) {
  return postTelegram(secret, method, { body: form }, timeoutMs);
}

async function telegramFormattedCall(secret, method, payload, plainText) {
  try {
    return await telegramCall(secret, method, payload);
  } catch (error) {
    if (!payload.parse_mode || !/Bad Request|parse entities|unsupported.*tag|can't find end tag/i.test(errorMessage(error))) throw error;
    const fallback = { ...payload, text: String(plainText ?? "") };
    delete fallback.parse_mode;
    return telegramCall(secret, method, fallback);
  }
}

module.exports = Object.freeze({ DEFAULT_API_BASE_URL, telegramCall, telegramFormattedCall, telegramMultipartCall, telegramUrl });

const { errorMessage } = require("../shared/errors.cjs");

async function telegramCall(secret, method, payload, timeoutMs = 20_000, externalSignal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      response = await fetch(`https://api.telegram.org/bot${secret.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal,
      });
    } catch (error) {
      throw new Error(`Telegram ${method} failed: ${errorMessage(error)}`);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Telegram ${method} returned invalid JSON (HTTP ${response.status})`);
    }
    if (response.ok && result?.ok === true) return result.result;

    const retryAfter = Number(result?.parameters?.retry_after);
    if (response.status === 429 && attempt === 0 && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 60) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000 + 250));
      continue;
    }
    throw new Error(`Telegram ${method} failed: ${result?.description || `HTTP ${response.status}`}`);
  }
  throw new Error(`Telegram ${method} failed after retry`);
}

async function telegramMultipartCall(secret, method, form, timeoutMs = 60_000) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${secret.botToken}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Telegram ${method} failed: ${errorMessage(error)}`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON (HTTP ${response.status})`);
  }
  if (response.ok && result?.ok === true) return result.result;
  throw new Error(`Telegram ${method} failed: ${result?.description || `HTTP ${response.status}`}`);
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

module.exports = Object.freeze({ telegramCall, telegramFormattedCall, telegramMultipartCall });

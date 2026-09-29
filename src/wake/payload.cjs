const WAKE_SENTINEL = "pi-telegram-wake-payload";

function decodeWakePayload(encoded) {
  if (!encoded) throw new Error("Telegram wake payload is missing");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  return { text: String(payload?.text ?? "") };
}

function wakePromptArgument(prompt) {
  const text = String(prompt || "");
  return text.trimStart().startsWith("/") ? text : WAKE_SENTINEL;
}

module.exports = Object.freeze({ decodeWakePayload, wakePromptArgument, WAKE_SENTINEL });

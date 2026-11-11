function questionCallbackData(questionId, optionIndex) {
  return `question:${questionId}:${optionIndex}`;
}

function parseQuestionCallback(value) {
  const match = String(value || "").match(/^question:([0-9a-f-]{36}):(\d{1,2})$/i);
  if (!match) return undefined;
  return { questionId: match[1], optionIndex: Number(match[2]) };
}

// Multi-select turns buttons into toggles plus one Done button, so its callbacks need their own
// namespace: `question` means "this option is the answer", `toggle` means "flip it".
function toggleCallbackData(questionId, optionIndex) {
  return `toggle:${questionId}:${optionIndex}`;
}

function parseToggleCallback(value) {
  const match = String(value || "").match(/^toggle:([0-9a-f-]{36}):(\d{1,2})$/i);
  if (!match) return undefined;
  return { questionId: match[1], optionIndex: Number(match[2]) };
}

function questionDoneCallbackData(questionId) {
  return `qdone:${questionId}`;
}

function parseQuestionDoneCallback(value) {
  const match = String(value || "").match(/^qdone:([0-9a-f-]{36})$/i);
  return match ? { questionId: match[1] } : undefined;
}

// Every question also offers a typed answer: after this tap, the next text message in the topic
// answers the question instead of starting a turn.
function customCallbackData(questionId) {
  return `qcustom:${questionId}`;
}

function parseQuestionCustomCallback(value) {
  const match = String(value || "").match(/^qcustom:([0-9a-f-]{36})$/i);
  return match ? { questionId: match[1] } : undefined;
}

const customRow = (questionId) => [{ text: "✏️ Type my own answer", callback_data: customCallbackData(questionId) }];

// Telegram drops a button label past 64 characters and refuses an empty one.
function buttonText(option, selected) {
  const text = String(option).slice(0, 62);
  return selected ? `✓ ${text}` : text;
}

function questionKeyboard(questionId, options) {
  return {
    inline_keyboard: [
      ...options.map((option, index) => [{
        text: buttonText(option, false),
        callback_data: questionCallbackData(questionId, index),
      }]),
      customRow(questionId),
    ],
  };
}

// Multi-select: every option toggles, and nothing is sent to Pi until Done or a typed answer,
// which joins the ticked options. The keyboard is
// redrawn on each toggle so the checkmarks are the state; Telegram edits the same message rather
// than posting new ones, which keeps a long checklist out of the chat history.
function toggleKeyboard(questionId, options, selected = []) {
  const chosen = new Set(selected);
  const rows = options.map((option, index) => [{
    text: buttonText(option, chosen.has(index)),
    callback_data: toggleCallbackData(questionId, index),
  }]);
  rows.push(customRow(questionId));
  rows.push([{
    text: chosen.size ? `Done (${chosen.size})` : "Done",
    callback_data: questionDoneCallbackData(questionId),
  }]);
  return { inline_keyboard: rows };
}

// Bot API 10.4 sendWidget takes reply_markup, so a widget question keeps its options as buttons
// under the widget: they answer down the same path as any other question, which also means the
// widget itself never has to call TelegramWidget.request() for a plain choice.
// Two per row keeps ten options within Telegram's button width.
function widgetQuestionKeyboard(questionId, options) {
  const rows = [];
  for (let index = 0; index < options.length; index += 2) {
    rows.push(options.slice(index, index + 2).map((option, offset) => ({
      text: buttonText(option, false),
      callback_data: questionCallbackData(questionId, index + offset),
    })));
  }
  rows.push(customRow(questionId));
  return { inline_keyboard: rows };
}

// A widget message has no text to rewrite, so an answered widget question swaps its options for
// one inert button that shows the answer (DisabledButton, Bot API 10.3; widgets need 10.4).
function answeredKeyboard(answer) {
  return { inline_keyboard: [[{ text: buttonText(answer, true), disabled: {} }]] };
}

// sendWidget refuses a caption over 1024 characters, which would fail the whole question.
const WIDGET_CAPTION_LIMIT = 1024;

// The caption is the widget's fallback (chat list, forwards, clients without widgets), so it
// repeats the options; the buttons below the widget stay tappable either way. The question is
// shortened first so the option list survives.
function widgetQuestionCaption(question, options) {
  const list = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const text = String(question);
  const room = WIDGET_CAPTION_LIMIT - list.length - 2;
  const head = text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;
  return `${head}\n\n${list}`.slice(0, WIDGET_CAPTION_LIMIT);
}

module.exports = Object.freeze({
  answeredKeyboard,
  customCallbackData,
  parseQuestionCallback,
  parseQuestionCustomCallback,
  parseQuestionDoneCallback,
  parseToggleCallback,
  questionCallbackData,
  questionDoneCallbackData,
  questionKeyboard,
  toggleCallbackData,
  toggleKeyboard,
  widgetQuestionCaption,
  widgetQuestionKeyboard,
});

function questionCallbackData(questionId, optionIndex) {
  return `question:${questionId}:${optionIndex}`;
}

function parseQuestionCallback(value) {
  const match = String(value || "").match(/^question:([0-9a-f-]{36}):(\d{1,2})$/i);
  if (!match) return undefined;
  return { questionId: match[1], optionIndex: Number(match[2]) };
}

function questionKeyboard(questionId, options) {
  return {
    inline_keyboard: options.map((option, index) => [{
      text: String(option).slice(0, 64),
      callback_data: questionCallbackData(questionId, index),
    }]),
  };
}

// Bot API 10.4 sendWidget takes reply_markup, so a widget question keeps its options as buttons
// under the widget: they answer down the same path as any other question, which also means the
// widget itself never has to call TelegramWidget.request() for a plain choice.
// Two per row keeps ten options within Telegram's button width.
function widgetQuestionKeyboard(questionId, options) {
  const rows = [];
  for (let index = 0; index < options.length; index += 2) {
    rows.push(options.slice(index, index + 2).map((option, offset) => ({
      text: String(option).slice(0, 64),
      callback_data: questionCallbackData(questionId, index + offset),
    })));
  }
  return { inline_keyboard: rows };
}

// The caption is the widget's fallback (chat list, forwards, clients without widgets), so it
// repeats the options; the buttons below the widget stay tappable either way.
function widgetQuestionCaption(question, options) {
  const list = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  return `${String(question).slice(0, 2800)}\n\n${list}`;
}

module.exports = Object.freeze({
  parseQuestionCallback,
  questionCallbackData,
  questionKeyboard,
  widgetQuestionCaption,
  widgetQuestionKeyboard,
});

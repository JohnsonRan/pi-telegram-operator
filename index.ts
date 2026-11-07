import type { ExtensionAPI, ExtensionContext, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const { decodeWakePayload, WAKE_SENTINEL } = require("./src/wake/payload.cjs") as {
  decodeWakePayload(encoded: string | undefined): { text: string };
  WAKE_SENTINEL: string;
};
const runtime = require("./src/runtime.cjs") as {
  askQuestion(pi: ExtensionAPI, ctx: ExtensionContext, question: string, options: string[], signal?: AbortSignal): Promise<string>;
  attach(pi: ExtensionAPI): void;
  notify(pi: ExtensionAPI, ctx: ExtensionContext, title: string, body: string): Promise<void>;
  sendFile(pi: ExtensionAPI, ctx: ExtensionContext, filePath: string, caption?: string): Promise<void>;
  sendWidget(pi: ExtensionAPI, ctx: ExtensionContext, widget: WidgetRequest): Promise<number>;
  updateWidget(pi: ExtensionAPI, ctx: ExtensionContext, messageId: number, data: WidgetData): Promise<void>;
};

interface WidgetData {
  chatData?: string;
  publicData?: string;
}

interface WidgetRequest extends WidgetData {
  html: string;
  caption?: string;
  width?: number;
  height?: number;
  allowQueries?: boolean;
}

const WIDGET_STATE = {
  chatData: Type.Optional(Type.String({ maxLength: 1024, description: "Chat state (TelegramWidget.chatData), up to 1024 UTF-8 bytes; \"\" clears it" })),
  publicData: Type.Optional(Type.String({ maxLength: 1024, description: "Shared state (TelegramWidget.publicData), also seen in forwards; up to 1024 UTF-8 bytes; \"\" clears it" })),
};

const SEMANTIC_HOOK_CHANNEL = "pi:semantic-hook:v1";

interface SemanticHook {
  version: 1;
  name: string;
  values?: Record<string, string>;
}

function cleanHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function cleanBody(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function questionBody(event: ToolExecutionStartEvent, ctx: ExtensionContext): string {
  const args = event.args as Record<string, unknown> | undefined;
  const direct = args && typeof args.question === "string" ? args.question : undefined;
  const questions = args && Array.isArray(args.questions)
    ? args.questions
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const value = Reflect.get(item, "question") ?? Reflect.get(item, "prompt") ?? Reflect.get(item, "header");
          return typeof value === "string" ? value : "";
        })
        .filter(Boolean)
        .join("\n\n")
    : "";
  return cleanBody(direct || questions || `Pi needs your input in ${ctx.cwd}`);
}

function isSemanticHook(value: unknown): value is SemanticHook {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.name === "string";
}

export default function telegraPi(pi: ExtensionAPI): void {
  // Subagents report back through their parent; giving each child a Telegram
  // topic would duplicate output and expose internal worker conversations.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("input", (event) => {
    if (event.text !== WAKE_SENTINEL || process.env.PI_TELEGRAM_WAKE_CHILD !== "1") {
      return { action: "continue" };
    }
    const encoded = process.env.PI_TELEGRAM_WAKE_PAYLOAD;
    delete process.env.PI_TELEGRAM_WAKE_PAYLOAD;
    const payload = decodeWakePayload(encoded);
    return { action: "transform", text: payload.text };
  });

  pi.registerTool({
    name: "telegram_send_file",
    label: "Send file to Telegram",
    description: "Send a file or image from the current working directory to this Pi session's private Telegram topic.",
    promptSnippet: "Send a generated file or image to the user's Telegram topic.",
    // Replies are mirrored to Telegram as rich messages; without this the model never uses
    // the Telegram-only parts. Kept short and opt-in, since the terminal shows raw markup.
    promptGuidelines: [
      "Your replies are also shown in the user's Telegram topic, which renders GitHub-flavored Markdown natively (tables, task lists, footnotes, $math$). Plain Markdown reads well in both the terminal and Telegram, so prefer it.",
      "Wrap long logs, diffs or command output the user may not need to read in <details><summary>Short title</summary>, a blank line, the content, then </details>; Telegram shows it collapsed.",
      "To show an image, chart or short video you generated inside the working directory as part of a reply, embed it with ![caption](./path.png); it is uploaded inline. Use telegram_send_file for other files or to send a file on its own.",
      "When a reply ends with a link the user will likely open (pull request, CI run, deployment) or a value to copy, you may add <tg-button-row><tg-button type=\"url\" url=\"https://...\">Open PR</tg-button></tg-button-row>; type=\"copy_text\" text=\"...\" also works. Other button types are disabled.",
      "Use Telegram extras such as ==highlight==, ||spoiler||, <u> or <sup> sparingly and only when they help; the terminal shows them as raw markup.",
    ],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "File path inside the current session working directory" }),
      caption: Type.Optional(Type.String({ description: "Optional Telegram caption" })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await runtime.sendFile(pi, ctx, params.path, params.caption);
      return {
        content: [{ type: "text", text: `Sent ${params.path} to Telegram.` }],
        details: { path: params.path },
      };
    },
  });

  pi.registerTool({
    name: "telegram_ask_user_question",
    label: "Ask user on Telegram",
    description: "Ask the user a multiple-choice question in this session's Telegram topic and wait for the selected answer. Use this instead of ask_user_question when the user is working remotely through Telegram.",
    promptSnippet: "Ask the remote user a multiple-choice question through Telegram and wait for the answer.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "Question shown to the user" }),
      options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10, description: "Selectable answers" }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const answer = await runtime.askQuestion(pi, ctx, params.question, params.options, signal);
      return {
        content: [{ type: "text", text: `The user selected: ${answer}` }],
        details: { question: params.question, answer },
      };
    },
  });

  pi.registerTool({
    name: "telegram_send_widget",
    label: "Send Telegram widget",
    description: [
      "Send an interactive HTML widget (Bot API 10.4) into this session's Telegram topic; returns its message id.",
      "One self-contained HTML document with inline CSS/JS: at most 32768 bytes and 4096 bytes after zlib level 9, so keep it small (no comments, no data: images).",
      "No network, no navigation, no libraries; the bubble is 200-600 px wide and at most 600 px tall, nothing scrolls inside. Style with var(--tg-theme-bg-color), --tg-theme-text-color, --tg-theme-hint-color, --tg-theme-button-color, --tg-theme-button-text-color.",
      "JS API on window.TelegramWidget: chatData / publicData (strings or null, written only by Pi), onEvent('chatDataChanged' | 'publicDataChanged', redraw), request(data) (1-64 bytes, on a tap), openLink(url), copyText(text), HapticFeedback; localStorage (4 KB) for per-device state.",
      "request(data) resolves at once with { result: null }; the data reaches Pi as a user message 'Telegram widget <id> request: <data>', and Pi answers by calling telegram_update_widget, which fires the change events.",
      "Full guide: https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/widget-runtime-profile.md",
    ].join(" "),
    promptSnippet: "Send an interactive HTML/CSS/JS widget (poll, game, dashboard) into the user's Telegram topic.",
    parameters: Type.Object({
      html: Type.String({ minLength: 1, description: "The widget's HTML document" }),
      caption: Type.Optional(Type.String({ description: "Caption, also used for the chat list and as the fallback on old clients" })),
      width: Type.Optional(Type.Integer({ minimum: 0, description: "Width in px (200-600); 0 or omitted = bubble width" })),
      height: Type.Optional(Type.Integer({ minimum: 0, description: "Fixed height in px (50-600); 0 or omitted = content height" })),
      allowQueries: Type.Optional(Type.Boolean({ description: "Let TelegramWidget.request() reach Pi (default true)" })),
      ...WIDGET_STATE,
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const messageId = await runtime.sendWidget(pi, ctx, params);
      return {
        content: [{ type: "text", text: `Sent widget ${messageId} to Telegram.` }],
        details: { messageId },
      };
    },
  });

  pi.registerTool({
    name: "telegram_update_widget",
    label: "Update Telegram widget",
    description: "Replace the chat state and/or shared state of a widget this session sent with telegram_send_widget. The widget redraws through its chatDataChanged / publicDataChanged handlers; omitted fields stay as they are.",
    promptSnippet: "Update the state of a Telegram widget, e.g. after a widget request.",
    parameters: Type.Object({
      messageId: Type.Integer({ description: "Widget message id returned by telegram_send_widget" }),
      ...WIDGET_STATE,
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { messageId, ...data } = params;
      await runtime.updateWidget(pi, ctx, messageId, data);
      return {
        content: [{ type: "text", text: `Updated widget ${messageId}.` }],
        details: { messageId },
      };
    },
  });

  runtime.attach(pi);

  let liveContext: ExtensionContext | undefined;
  let unsubscribeBus: (() => void) | undefined;

  const send = async (ctx: ExtensionContext, title: string, body: string): Promise<void> => {
    try {
      await runtime.notify(pi, ctx, cleanHeader(title), cleanBody(body));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[pi-telegram-operator] Notification failed: ${detail}\n`);
    }
  };

  const handleHook = (data: unknown): void => {
    if (!liveContext || !isSemanticHook(data)) return;
    const values = data.values ?? {};
    const host = hostname();
    const cwd = liveContext.cwd;

    if (data.name === "agent-notify" && typeof values.TITLE === "string" && typeof values.CONTENT === "string") {
      void send(liveContext, `🤖 ${values.TITLE} · ${host} · ${cwd}`, values.CONTENT);
      return;
    }
    if (data.name !== "user-ready") return;
    if (values.STOP_KIND === "AI_UNLOCK") {
      void send(liveContext, `🙋 Pi Done · ${host} · ${cwd}`, values.REASON || "Pi is ready for input");
    } else if (values.STOP_KIND === "EXHAUSTED") {
      void send(liveContext, `🛑 Pi Continue stopped · ${host} · ${cwd}`, "Continue watchdog retry limit reached");
    } else if (values.STOP_KIND === "DECISION_FAILED") {
      void send(liveContext, `⚠️ Pi Continue failed · ${host} · ${cwd}`, "Continue watchdog decision failed");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    liveContext = ctx;
    if (!unsubscribeBus && pi.events && typeof pi.events.on === "function") {
      unsubscribeBus = pi.events.on(SEMANTIC_HOOK_CHANNEL, handleHook);
    }
  });

  pi.on("session_info_changed", (_event, ctx) => {
    liveContext = ctx;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "ask_user_question") return;
    const host = hostname();
    void send(ctx, `❓ Pi Question · ${host} · ${ctx.cwd}`, questionBody(event, ctx));
  });

  pi.on("session_shutdown", () => {
    unsubscribeBus?.();
    unsubscribeBus = undefined;
    liveContext = undefined;
  });
}

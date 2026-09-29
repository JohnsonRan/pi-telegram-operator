import type { ExtensionAPI, ExtensionContext, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const { decodeWakePayload, WAKE_SENTINEL } = require("./src/wake/payload.cjs") as {
  decodeWakePayload(encoded: string | undefined): { text: string; expandPromptTemplates: boolean };
  WAKE_SENTINEL: string;
};
const runtime = require("./src/runtime.cjs") as {
  askQuestion(pi: ExtensionAPI, ctx: ExtensionContext, question: string, options: string[], signal?: AbortSignal): Promise<string>;
  attach(pi: ExtensionAPI): void;
  notify(pi: ExtensionAPI, ctx: ExtensionContext, title: string, body: string): Promise<void>;
  sendFile(pi: ExtensionAPI, ctx: ExtensionContext, filePath: string, caption?: string): Promise<void>;
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

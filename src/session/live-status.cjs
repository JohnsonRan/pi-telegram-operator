function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

// The end of the model's visible reasoning, for the optional thinking preview.
function thinkingTail(message, maxLines = 6, maxChars = 600) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  const text = message.content
    .filter((item) => item?.type === "thinking" && typeof item.thinking === "string")
    .map((item) => item.thinking)
    .join("\n");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-maxLines).join("\n");
  return lines.length > maxChars ? `…${lines.slice(-maxChars)}` : lines;
}

function oneLine(value, limit = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function summarizeToolArgs(toolName, args) {
  const value = args && typeof args === "object" ? args : {};
  if (toolName === "bash") return oneLine(value.command, 140);
  if (["read", "write", "edit"].includes(toolName)) return oneLine(value.path || value.file_path, 140);
  if (toolName === "subagent") {
    if (typeof value.agent === "string") return oneLine(value.agent, 80);
    if (typeof value.action === "string") return oneLine(value.action, 80);
    if (typeof value.workflowScript === "string") return "workflow";
  }
  for (const key of ["query", "question", "prompt", "task", "url", "selector", "path"]) {
    if (typeof value[key] === "string" && value[key].trim()) return oneLine(value[key], 140);
  }
  return "";
}

function subagentProgress(partialResult) {
  const details = partialResult?.details;
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  if (progress.length === 0) return undefined;
  const done = progress.filter((item) => item?.status === "completed").length;
  const failed = progress.filter((item) => item?.status === "failed").length;
  const detached = progress.filter((item) => item?.status === "detached").length;
  const running = progress.filter((item) => item?.status === "running");
  const lines = [`Subagents · ${done}/${progress.length} done${running.length ? ` · ${running.length} running` : ""}${failed ? ` · ${failed} failed` : ""}${detached ? ` · ${detached} detached` : ""}`];
  for (const item of progress.slice(0, 6)) {
    const icon = item?.status === "completed" ? "✓" : item?.status === "failed" ? "✗" : item?.status === "detached" ? "↗" : item?.status === "running" ? "⏳" : "○";
    const activity = item?.currentTool
      ? `${item.currentTool}${item.currentPath ? ` · ${oneLine(item.currentPath, 70)}` : ""}`
      : item?.activityState === "needs_attention"
        ? "needs attention"
        : item?.status || "pending";
    lines.push(`${icon} ${oneLine(item?.agent || `agent ${Number(item?.index || 0) + 1}`, 40)} · ${activity}`);
  }
  return lines.join("\n");
}

function formatLiveStatus(activity, now = Date.now()) {
  if (!activity) return "Main agent · Running";
  const heading = `Main agent · Turn ${Math.max(1, Number(activity.turnIndex || 0) + 1)} · ${formatElapsed(now - activity.startedAt)}`;
  if (activity.toolName === "subagent") {
    return [heading, subagentProgress(activity.partialResult) || `Subagent · ${summarizeToolArgs("subagent", activity.toolArgs) || "starting"}`].join("\n");
  }
  if (activity.toolName) {
    const detail = summarizeToolArgs(activity.toolName, activity.toolArgs);
    return [heading, `Tool · ${activity.toolName}${activity.toolError ? " · failed" : ""}`, detail].filter(Boolean).join("\n");
  }
  return `${heading}\n${activity.phase || "Thinking"}`;
}

module.exports = Object.freeze({ assistantText, formatLiveStatus, subagentProgress, summarizeToolArgs, thinkingTail });

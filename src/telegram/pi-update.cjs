const { spawn } = require("node:child_process");
const { appendBoundedText } = require("../shared/text.cjs");

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_UPDATE_OUTPUT_BYTES = 16 * 1024;

function parsePiUpdateCommand(value) {
  const text = String(value || "").trim();
  return /^(?:\/update(?:@\w+)?|pi\s+update\s+(?:--|—|–)all)$/i.test(text)
    ? { command: "update" }
    : undefined;
}

function runPiUpdate(options = {}) {
  const piCommand = String(options.piCommand || "pi");
  const spawnProcess = options.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(piCommand, ["update", "--all"], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output = appendBoundedText(output, chunk, MAX_UPDATE_OUTPUT_BYTES); });
    child.stderr?.on("data", (chunk) => { output = appendBoundedText(output, chunk, MAX_UPDATE_OUTPUT_BYTES); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("pi update --all timed out after 10 minutes"));
    }, options.timeoutMs || UPDATE_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Cannot start pi update --all: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const detail = output.trim();
      if (code === 0) {
        resolve(detail);
        return;
      }
      reject(new Error([
        `pi update --all failed (${signal || `code ${code}`})`,
        ...(detail ? [detail] : []),
      ].join("\n")));
    });
  });
}

module.exports = Object.freeze({
  parsePiUpdateCommand,
  runPiUpdate,
});

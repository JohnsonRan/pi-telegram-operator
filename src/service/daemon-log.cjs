const { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { format } = require("node:util");
const { errorMessage } = require("../shared/errors.cjs");
const { formatLocalTimestamp } = require("../shared/time.cjs");

const DEFAULT_MAX_BYTES = 256 * 1024;

function daemonLogPath(agentDir) {
  return path.join(agentDir, "pi-telegram-operator.log");
}

function installDaemonLogging(options = {}) {
  const logPath = String(options.logPath);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
  const consoleObject = options.consoleObject || console;
  const now = options.now || (() => new Date());
  const mirror = options.mirror === true;
  const original = {
    log: consoleObject.log.bind(consoleObject),
    warn: consoleObject.warn.bind(consoleObject),
    error: consoleObject.error.bind(consoleObject),
  };

  mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    const content = readFileSync(logPath);
    if (content.length > maxBytes) {
      writeFileSync(logPath, content.subarray(content.length - maxBytes), { mode: 0o600 });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    writeFileSync(logPath, "", { mode: 0o600 });
  }

  const write = (level, args) => {
    const marker = Buffer.from("[earlier daemon output truncated]\n");
    const prefix = `${formatLocalTimestamp(now())} [${level}] `;
    let message = format(...args);
    const lineBudget = Math.max(1, maxBytes - marker.length);
    if (Buffer.byteLength(`${prefix}${message}\n`) > lineBudget) {
      const tailBudget = Math.max(1, lineBudget - Buffer.byteLength(`${prefix}…\n`));
      const tail = Buffer.from(message).subarray(-tailBudget).toString("utf8").replace(/^\uFFFD+/, "");
      message = `…${tail}`;
    }
    const line = `${prefix}${message}\n`;
    try {
      appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
      const size = statSync(logPath).size;
      if (size > maxBytes) {
        const content = readFileSync(logPath);
        // Keep half the budget (at least the new line) so a full log is
        // rewritten once per maxBytes/2 of output instead of on every line.
        const tailBudget = Math.max(1, Math.min(maxBytes - marker.length, Math.max(Buffer.byteLength(line), Math.floor(maxBytes / 2))));
        const tail = content.subarray(Math.max(0, content.length - tailBudget));
        writeFileSync(logPath, Buffer.concat([marker, tail]), { mode: 0o600 });
      }
    } catch (error) {
      original.error(`[pi-telegram-operator] Cannot write daemon log: ${errorMessage(error)}`);
    }
  };

  consoleObject.log = (...args) => {
    write("info", args);
    if (mirror) original.log(...args);
  };
  consoleObject.warn = (...args) => {
    write("warn", args);
    if (mirror) original.warn(...args);
  };
  consoleObject.error = (...args) => {
    write("error", args);
    if (mirror) original.error(...args);
  };

  return logPath;
}

module.exports = Object.freeze({ daemonLogPath, installDaemonLogging });

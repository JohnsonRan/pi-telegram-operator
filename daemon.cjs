#!/usr/bin/env node

const { daemonLogPath, installDaemonLogging } = require("./src/service/daemon-log.cjs");
const { errorMessage } = require("./src/shared/errors.cjs");
const { AGENT_DIR } = require("./src/shared/paths.cjs");

process.env.PI_TELEGRAM_DAEMON = "1";

const logPath = installDaemonLogging({
  logPath: daemonLogPath(AGENT_DIR),
  mirror: process.stdout.isTTY || process.stderr.isTTY,
});
console.log(`[pi-telegram-operator] Wake daemon starting (pid ${process.pid}, log ${logPath})`);

const { runWakeDaemon } = require("./src/runtime.cjs");

runWakeDaemon().catch((error) => {
  console.error(`[pi-telegram-operator] Wake daemon failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});

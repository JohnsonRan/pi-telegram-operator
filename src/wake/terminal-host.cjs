#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const readline = require("node:readline/promises");

let cancelPath;
let pidPath;
let resultPath;

function writeResult(result) {
  if (!resultPath) return;
  try {
    writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 });
  } catch {}
}

async function waitForEnterAfterError(input = process.stdin, output = process.stderr) {
  if (!input.isTTY) return;
  const terminal = readline.createInterface({ input, output });
  try {
    await terminal.question("\nAn error occurred. Press Enter to close this terminal...");
  } catch {} finally {
    terminal.close();
  }
}

function readSpec() {
  const specPath = process.argv[2] || process.env.PI_TELEGRAM_TERMINAL_SPEC_PATH;
  delete process.env.PI_TELEGRAM_TERMINAL_SPEC_PATH;
  if (!specPath) throw new Error("Telegram terminal launch specification path is missing");
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.args) || typeof spec.cwd !== "string") {
      throw new Error("Telegram terminal launch specification is invalid");
    }
    cancelPath = String(spec.cancelPath || `${specPath}.cancel`);
    resultPath = String(spec.resultPath || `${specPath}.result`);
    pidPath = `${specPath}.pid`;
    writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    if (existsSync(cancelPath)) {
      throw Object.assign(new Error("Telegram terminal launch was cancelled"), { code: "PI_TELEGRAM_LAUNCH_CANCELLED" });
    }
    return spec;
  } finally {
    rmSync(specPath, { force: true });
  }
}

async function main() {
  let cancelTimer;
  let cancellationRequested = false;
  try {
    const spec = readSpec();
    const child = spawn(spec.command, spec.args.map(String), {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env || {}) },
      stdio: "inherit",
      windowsHide: false,
    });
    const stopChild = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const cancelChild = () => {
      cancellationRequested = true;
      stopChild();
    };
    process.once("SIGINT", cancelChild);
    process.once("SIGTERM", cancelChild);
    cancelTimer = setInterval(() => {
      if (cancelPath && existsSync(cancelPath)) {
        cancellationRequested = true;
        stopChild();
      }
    }, 250);
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.off("SIGINT", cancelChild);
    process.off("SIGTERM", cancelChild);
    writeResult(result);
    if (cancellationRequested) {
      process.exitCode = 0;
    } else if (result.signal) {
      process.stderr.write(`Pi exited from signal ${result.signal}.\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = Number.isInteger(result.code) ? result.code : 1;
    }
    if (process.exitCode !== 0 && !cancellationRequested) await waitForEnterAfterError();
  } catch (error) {
    if (error?.code === "PI_TELEGRAM_LAUNCH_CANCELLED") {
      writeResult({ code: 0, signal: null, cancelled: true });
      process.exitCode = 0;
    } else {
      const detail = error instanceof Error ? error.stack || error.message : String(error);
      writeResult({ code: 1, signal: null, error: detail });
      process.stderr.write(`${detail}\n`);
      process.exitCode = 1;
      await waitForEnterAfterError();
    }
  } finally {
    if (cancelTimer) clearInterval(cancelTimer);
    if (pidPath) rmSync(pidPath, { force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  main,
  waitForEnterAfterError,
});

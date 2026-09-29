const { execFile, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { closeSync, openSync, readFileSync, writeFileSync } = require("node:fs");
const { mkdir, readdir, realpath, stat, unlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isPathInside } = require("../shared/paths.cjs");
const { appendBoundedText } = require("../shared/text.cjs");
const { createTerminalLaunch } = require("./terminal.cjs");
const { wakePromptArgument } = require("./payload.cjs");

const MAX_STDERR_BYTES = 8 * 1024;
const TERMINAL_HOST_PATH = path.join(__dirname, "terminal-host.cjs");
const TERMINAL_SPEC_MAX_AGE_MS = 60 * 60 * 1000;
const INDEPENDENT_SESSION_ENV_KEYS = [
  "PI_EXTENSION_UTILS_PROCESS_DOMAIN",
  "PI_CONTINUE_WATCHDOG_ROOT_PID",
];

function independentSessionEnvironment(environment) {
  const result = { ...environment };
  for (const key of INDEPENDENT_SESSION_ENV_KEYS) delete result[key];
  return result;
}

async function prepareTerminalSpecDir(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - TERMINAL_SPEC_MAX_AGE_MS;
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("wake-"))
    .map(async (entry) => {
      const file = path.join(directory, entry.name);
      const info = await stat(file).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => {});
    }));
}

function killWindowsProcessTree(pid) {
  const child = execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  child.unref?.();
}

function parseControlCommand(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\/(new|sessions|status|help)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  const command = match[1].toLowerCase();
  const argument = String(match[2] || "").trim();
  if (command !== "new") return { command };
  const separator = argument.indexOf("|");
  if (separator < 0) return { command, cwd: argument, prompt: "" };
  return {
    command,
    cwd: argument.slice(0, separator).trim(),
    prompt: argument.slice(separator + 1).trim(),
  };
}

async function resolveWakeCwd(value, defaultCwd, allowedRoots) {
  const requested = String(value || defaultCwd || "").trim();
  if (!requested) throw new Error("No working directory was provided and wakeDefaultCwd is not configured");
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(String(defaultCwd || ""), requested);
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${resolved}`);
  const cwd = await realpath(resolved);
  const roots = await Promise.all(allowedRoots.map(async (root) => {
    const resolvedRoot = path.resolve(root);
    return realpath(resolvedRoot).catch(() => resolvedRoot);
  }));
  if (roots.length === 0 || !roots.some((root) => isPathInside(root, cwd))) {
    throw new Error(`Working directory is outside wakeAllowedRoots: ${cwd}`);
  }
  return cwd;
}

class WakeLauncher {
  constructor(options = {}) {
    this.piCommand = String(options.piCommand || "pi");
    this.piCommandArgs = Array.isArray(options.piCommandArgs) ? [...options.piCommandArgs] : [];
    this.spawn = options.spawn || spawn;
    this.openTerminal = options.openTerminal === true;
    this.platform = String(options.platform || process.platform);
    this.nodeCommand = options.nodeCommand;
    this.terminalHostPath = options.terminalHostPath;
    this.terminalSpecDir = String(options.terminalSpecDir || path.join(os.tmpdir(), "pi-telegram-operator"));
    this.powershell = options.powershell;
    this.osascript = options.osascript;
    this.processEnvironment = options.processEnvironment || process.env;
    this.terminalEnvironment = options.terminalEnvironment || this.processEnvironment;
    this.findExecutable = options.findExecutable;
    this.killTree = typeof options.killTree === "function" ? options.killTree : killWindowsProcessTree;
    this.terminalCancelGraceMs = Number.isFinite(options.terminalCancelGraceMs) ? Math.max(0, options.terminalCancelGraceMs) : 3_000;
    this.running = new Map();
    this.cancelled = new Set();
    this.onExit = typeof options.onExit === "function" ? options.onExit : () => {};
  }

  isRunning(sessionId) {
    return this.running.has(sessionId);
  }

  runningSessionIds() {
    return [...this.running.keys()];
  }

  cancel(sessionId) {
    const child = this.running.get(sessionId);
    if (!child) return false;
    this.cancelled.add(sessionId);
    if (child.terminalCancelPath) {
      try { writeFileSync(child.terminalCancelPath, "cancel\n", { mode: 0o600 }); } catch {}
      child.terminalCancelTimer = setTimeout(() => {
        if (this.running.get(sessionId) !== child) return;
        let terminalPid;
        try {
          terminalPid = Number(readFileSync(child.terminalPidPath, "utf8"));
        } catch {}
        if (Number.isInteger(terminalPid) && terminalPid > 0) {
          if (this.platform === "win32") this.killTree(terminalPid);
          else {
            try { process.kill(terminalPid, "SIGTERM"); } catch { child.kill(); }
          }
        } else if (this.platform === "win32" && Number.isInteger(child.pid)) {
          this.killTree(child.pid);
        } else {
          child.kill();
        }
      }, this.terminalCancelGraceMs);
      child.terminalCancelTimer.unref?.();
      return true;
    }
    if (this.platform === "win32" && Number.isInteger(child.pid)) this.killTree(child.pid);
    else child.kill();
    return true;
  }

  async launch({ sessionId, cwd, sessionName, prompt, openTerminal = this.openTerminal }) {
    if (this.running.has(sessionId)) return { started: false, process: this.running.get(sessionId) };
    const commonArgs = [
      ...this.piCommandArgs,
      "--session-id", sessionId,
      "--name", String(sessionName || path.basename(cwd) || "Telegram"),
    ];
    const interactiveArgs = [...commonArgs, "--approve", wakePromptArgument(prompt)];
    const backgroundArgs = [...commonArgs, "--print", "--approve", wakePromptArgument(prompt)];
    const wakePayload = Buffer.from(JSON.stringify({ text: String(prompt || "") }), "utf8").toString("base64url");
    // Telegram wake processes are independent sessions, not subprocess workers
    // of whichever Pi instance currently owns the broker.
    const wakeEnv = {
      ...independentSessionEnvironment(this.processEnvironment),
      PI_TELEGRAM_WAKE_CHILD: "1",
      PI_TELEGRAM_WAKE_PAYLOAD: wakePayload,
    };
    await prepareTerminalSpecDir(this.terminalSpecDir);
    const stderrPath = path.join(this.terminalSpecDir, `wake-${process.pid}-${randomUUID()}.stderr`);
    /** @type {Record<string, any>} */
    let launch = { command: this.piCommand, args: backgroundArgs, windowsHide: true };
    let foreground = false;
    let fallbackReason;
    let terminal;
    let terminalSpecPath;
    if (openTerminal) {
      terminalSpecPath = path.join(this.terminalSpecDir, `wake-${process.pid}-${randomUUID()}.json`);
      const terminalLaunch = createTerminalLaunch(terminalSpecPath, {
        platform: this.platform,
        nodeCommand: this.nodeCommand,
        terminalHostPath: this.terminalHostPath || TERMINAL_HOST_PATH,
        powershell: this.powershell,
        osascript: this.osascript,
        display: this.terminalEnvironment.DISPLAY,
        waylandDisplay: this.terminalEnvironment.WAYLAND_DISPLAY,
        environmentPath: this.terminalEnvironment.PATH,
        findExecutable: this.findExecutable,
      });
      if (terminalLaunch.reason) {
        fallbackReason = terminalLaunch.reason;
        terminalSpecPath = undefined;
      } else {
        await writeFile(terminalSpecPath, JSON.stringify({
          command: this.piCommand,
          args: interactiveArgs,
          cwd,
          env: wakeEnv,
          cancelPath: `${terminalSpecPath}.cancel`,
          resultPath: `${terminalSpecPath}.result`,
        }), { mode: 0o600 });
        launch = terminalLaunch;
        foreground = true;
        terminal = terminalLaunch.terminal;
      }
    }
    const cleanupLaunchArtifacts = async () => {
      const files = [stderrPath];
      if (terminalSpecPath) {
        files.push(terminalSpecPath, `${terminalSpecPath}.pid`, `${terminalSpecPath}.cancel`, `${terminalSpecPath}.result`);
      }
      await Promise.all(files.map((file) => unlink(file).catch(() => {})));
    };
    let child;
    try {
      const stderrFd = openSync(stderrPath, "a", 0o600);
      try {
        child = this.spawn(launch.command, launch.args, {
          cwd,
          env: { ...wakeEnv, ...(launch.env || {}) },
          stdio: ["ignore", "ignore", stderrFd],
          // Windows console delegation drops the EncodedCommand when PowerShell
          // is spawned detached, leaving an empty terminal without a host.
          detached: !(foreground && this.platform === "win32"),
          windowsHide: launch.windowsHide,
        });
      } finally {
        closeSync(stderrFd);
      }
    } catch (error) {
      await cleanupLaunchArtifacts();
      throw error;
    }
    child.wakeStderrPath = stderrPath;
    if (terminalSpecPath) {
      child.terminalPidPath = `${terminalSpecPath}.pid`;
      child.terminalCancelPath = `${terminalSpecPath}.cancel`;
      child.terminalResultPath = `${terminalSpecPath}.result`;
    }
    this.running.set(sessionId, child);
    let spawned = false;
    child.once("close", (code, signal) => {
      if (!spawned) return;
      let terminalResult;
      let stderr = "";
      try { terminalResult = JSON.parse(readFileSync(child.terminalResultPath, "utf8")); } catch {}
      try { stderr = appendBoundedText(stderr, readFileSync(stderrPath, "utf8"), MAX_STDERR_BYTES); } catch {}
      const effectiveCode = Number.isInteger(terminalResult?.code) ? terminalResult.code : code;
      const effectiveSignal = terminalResult?.signal || signal;
      if (terminalResult?.error) stderr = appendBoundedText(stderr, `\n${terminalResult.error}`, MAX_STDERR_BYTES);
      const cancelled = this.cancelled.delete(sessionId);
      if (child.terminalCancelTimer) clearTimeout(child.terminalCancelTimer);
      if (terminalSpecPath) {
        unlink(terminalSpecPath).catch(() => {});
        unlink(`${terminalSpecPath}.pid`).catch(() => {});
        unlink(`${terminalSpecPath}.result`).catch(() => {});
        const cancelCleanup = () => unlink(`${terminalSpecPath}.cancel`).catch(() => {});
        if (cancelled) setTimeout(cancelCleanup, 30_000).unref?.();
        else cancelCleanup();
      }
      unlink(stderrPath).catch(() => {});
      if (this.running.get(sessionId) === child) this.running.delete(sessionId);
      Promise.resolve(this.onExit({ sessionId, cwd, code: effectiveCode, signal: effectiveSignal, cancelled, stderr: stderr.trim() })).catch(() => {});
    });
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", () => {
          spawned = true;
          resolve(undefined);
        });
        child.once("error", reject);
      });
    } catch (error) {
      await cleanupLaunchArtifacts();
      this.cancelled.delete(sessionId);
      if (child.terminalCancelTimer) clearTimeout(child.terminalCancelTimer);
      if (this.running.get(sessionId) === child) this.running.delete(sessionId);
      throw error;
    }
    return { started: true, process: child, foreground, fallbackReason, terminal };
  }
}

module.exports = Object.freeze({ WakeLauncher, parseControlCommand, resolveWakeCwd });

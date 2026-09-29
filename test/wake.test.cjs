const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WakeLauncher, parseControlCommand, resolveWakeCwd } = require("../src/wake/launcher.cjs");
const { appendBoundedText } = require("../src/shared/text.cjs");
const { decodeWakePayload, wakePromptArgument, WAKE_SENTINEL } = require("../src/wake/payload.cjs");

test("parses General-topic wake commands", () => {
  assert.deepEqual(parseControlCommand("/new F:\\Work | inspect this"), {
    command: "new",
    cwd: "F:\\Work",
    prompt: "inspect this",
  });
  assert.deepEqual(parseControlCommand("/new | hello"), { command: "new", cwd: "", prompt: "hello" });
  assert.deepEqual(parseControlCommand("/sessions@my_bot"), { command: "sessions" });
  assert.equal(parseControlCommand("normal text"), undefined);
});

test("resolves wake cwd only inside configured roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-wake-"));
  const child = path.join(root, "project");
  await mkdir(child);
  try {
    assert.equal(await resolveWakeCwd("project", root, [root]), await realpath(child));
    await mkdir(path.join(root, "..dots"));
    assert.equal(await resolveWakeCwd("..dots", root, [root]), await realpath(path.join(root, "..dots")));
    await assert.rejects(resolveWakeCwd(path.dirname(root), root, [root]), /outside wakeAllowedRoots/);
    await assert.rejects(resolveWakeCwd("missing", root, [root]), /does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decodes wake payloads and only exposes slash commands as CLI arguments", () => {
  const encoded = Buffer.from(JSON.stringify({
    text: "inspect this",
    expandPromptTemplates: true,
  }), "utf8").toString("base64url");
  assert.deepEqual(decodeWakePayload(encoded), { text: "inspect this", expandPromptTemplates: true });
  assert.equal(wakePromptArgument("inspect this"), WAKE_SENTINEL);
  assert.equal(wakePromptArgument("--help"), WAKE_SENTINEL);
  assert.equal(wakePromptArgument("@secret"), WAKE_SENTINEL);
  assert.equal(wakePromptArgument("/review now"), "/review now");
});

test("launches one full-permission Pi process per session", async () => {
  const calls = [];
  let child;
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    processEnvironment: {
      PATH: "test-path",
      PI_EXTENSION_UTILS_PROCESS_DOMAIN: "parent-domain",
      PI_CONTINUE_WATCHDOG_ROOT_PID: "123",
    },
    spawn(command, args, options) {
      child = new EventEmitter();
      child.pid = 123;
      calls.push({ command, args, options });
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  });
  const first = await launcher.launch({ sessionId: "session-1", cwd: process.cwd(), sessionName: "Test", prompt: "hello" });
  const second = await launcher.launch({ sessionId: "session-1", cwd: process.cwd(), sessionName: "Test", prompt: "again" });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pi-test");
  assert.deepEqual(calls[0].args, ["--session-id", "session-1", "--name", "Test", "--print", "--approve", WAKE_SENTINEL]);
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[0].options.env.PI_TELEGRAM_WAKE_PAYLOAD, "base64url").toString("utf8")),
    { text: "hello", expandPromptTemplates: true },
  );
  assert.equal(calls[0].options.env.PATH, "test-path");
  assert.equal(calls[0].options.env.PI_EXTENSION_UTILS_PROCESS_DOMAIN, undefined);
  assert.equal(calls[0].options.env.PI_CONTINUE_WATCHDOG_ROOT_PID, undefined);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio[0], "ignore");
  assert.equal(calls[0].options.stdio[1], "ignore");
  assert.equal(Number.isInteger(calls[0].options.stdio[2]), true);
  child.emit("close", 0, null);
  assert.equal(launcher.isRunning("session-1"), false);

  for (const prompt of ["--help", "--no-tools", "--session-id other", "@sensitive-file", "/review now"]) {
    await launcher.launch({ sessionId: prompt, cwd: process.cwd(), sessionName: "Test", prompt });
    assert.equal(calls.at(-1).args.at(-1), prompt.startsWith("/") ? prompt : WAKE_SENTINEL);
    assert.equal(
      JSON.parse(Buffer.from(calls.at(-1).options.env.PI_TELEGRAM_WAKE_PAYLOAD, "base64url").toString("utf8")).text,
      prompt,
    );
    child.emit("close", 0, null);
  }
});

test("opens an interactive Pi process through a tracked Windows terminal host", async () => {
  const calls = [];
  const killed = [];
  let child;
  const launcher = new WakeLauncher({
    piCommand: "C:\\Tools\\pi.exe",
    piCommandArgs: ["--model", "test/model"],
    openTerminal: true,
    platform: "win32",
    nodeCommand: "C:\\Node\\node.exe",
    terminalHostPath: "C:\\Package\\terminal-host.cjs",
    powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    terminalCancelGraceMs: 20,
    killTree(pid) {
      killed.push(pid);
    },
    spawn(command, args, options) {
      child = new EventEmitter();
      child.pid = 4321;
      calls.push({ command, args, options });
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  });
  const launched = await launcher.launch({ sessionId: "terminal-session", cwd: "C:\\Work", sessionName: "Work", prompt: "continue here" });
  assert.equal(calls[0].command, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, false);
  const specPath = calls[0].options.env.PI_TELEGRAM_TERMINAL_SPEC_PATH;
  assert.ok(specPath);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  assert.equal(spec.command, "C:\\Tools\\pi.exe");
  assert.equal(spec.cwd, "C:\\Work");
  assert.deepEqual(spec.args, [
    "--model", "test/model",
    "--session-id", "terminal-session",
    "--name", "Work",
    "--approve",
    WAKE_SENTINEL,
  ]);
  assert.ok(!spec.args.includes("--print"));
  assert.equal(launched.foreground, true);
  assert.equal(launched.terminal, "Windows Console");
  await writeFile(`${specPath}.pid`, "9876");
  assert.equal(launcher.cancel("terminal-session"), true);
  assert.equal(await readFile(`${specPath}.cancel`, "utf8"), "cancel\n");
  assert.deepEqual(killed, []);
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(killed, []);
});

test("force-closes an unresponsive Windows terminal after the cancellation grace period", async () => {
  const killed = [];
  let child;
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    openTerminal: true,
    platform: "win32",
    terminalCancelGraceMs: 10,
    killTree(pid) {
      killed.push(pid);
    },
    spawn() {
      child = new EventEmitter();
      child.pid = 4321;
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  });
  const launched = await launcher.launch({ sessionId: "stuck-terminal", cwd: process.cwd(), sessionName: "Test", prompt: "hello" });
  await writeFile(launched.process.terminalPidPath, "9876");
  assert.equal(launcher.cancel("stuck-terminal"), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(killed, [9876]);
  child.emit("close", 1, null);
});

test("falls back to headless mode when Linux has no graphical desktop", async () => {
  const calls = [];
  let child;
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    openTerminal: true,
    platform: "linux",
    terminalEnvironment: {},
    spawn(command, args, options) {
      child = new EventEmitter();
      calls.push({ command, args, options });
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  });
  const launched = await launcher.launch({ sessionId: "fallback", cwd: process.cwd(), sessionName: "Test", prompt: "hello" });
  assert.equal(launched.foreground, false);
  assert.match(launched.fallbackReason, /no graphical desktop/);
  assert.equal(calls[0].command, "pi-test");
  assert.ok(calls[0].args.includes("--print"));
  child.emit("close", 0, null);
});

test("cleans all launch artifacts after an asynchronous spawn error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-wake-spawn-error-"));
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    openTerminal: true,
    platform: "win32",
    terminalSpecDir: directory,
    spawn() {
      const child = new EventEmitter();
      child.pid = 1234;
      process.nextTick(() => child.emit("error", new Error("spawn failed")));
      return child;
    },
  });
  try {
    await assert.rejects(launcher.launch({
      sessionId: "spawn-error",
      cwd: process.cwd(),
      sessionName: "Test",
      prompt: "hello",
    }), /spawn failed/);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(launcher.isRunning("spawn-error"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observes a child that closes immediately after spawning", async () => {
  let exitResult;
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    spawn() {
      const child = new EventEmitter();
      process.nextTick(() => {
        child.emit("spawn");
        child.emit("close", 78, null);
      });
      return child;
    },
    onExit(result) {
      exitResult = result;
    },
  });
  await launcher.launch({ sessionId: "fast-exit", cwd: process.cwd(), sessionName: "Test", prompt: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launcher.isRunning("fast-exit"), false);
  assert.equal(exitResult.code, 78);
});

test("keeps bounded wake stderr and includes it in the exit callback", async () => {
  let child;
  let exitResult;
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    spawn() {
      child = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
    onExit(result) {
      exitResult = result;
    },
  });
  await launcher.launch({ sessionId: "session-error", cwd: process.cwd(), sessionName: "Test", prompt: "hello" });
  await writeFile(child.wakeStderrPath, "configuration failed\n");
  child.emit("close", 78, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exitResult.code, 78);
  assert.equal(exitResult.stderr, "configuration failed");
  assert.ok(Buffer.byteLength(appendBoundedText("", "x".repeat(9000), 8 * 1024)) <= 8 * 1024);
});

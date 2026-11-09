const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { restartService } = require("../src/service/restart.cjs");
const { AGENT_DIR } = require("../src/shared/paths.cjs");

const servicePath = path.resolve(__dirname, "../service.cjs");

// Exercise every service manager without stopping the machine's real broker.
function loadService(platform, { fail, argv = [], reportError, main = false } = {}) {
  const calls = [];
  const reports = [];
  const errors = [];
  const serviceModule = { exports: {} };
  const requireService = createRequire(servicePath);
  const fakeProcess = {
    platform,
    env: {},
    execPath: "/runtime/node",
    argv: ["node", servicePath, ...argv],
    getuid: () => 123,
  };
  function fakeRequire(id) {
    if (id === "node:child_process") return {
      execFileSync(command, args, options) {
        calls.push({ command, args, options });
        if (fail?.(command, args)) throw new Error("service manager unavailable");
        return "";
      },
    };
    if (id === "./src/service/daemon-log.cjs") return {
      daemonLogPath: (directory) => path.join(directory, "pi-telegram-operator.log"),
      installDaemonLogging() {},
    };
    if (id === "./src/service/restart.cjs") return {
      async reportServiceRestart(text, replyOptions) {
        reports.push({ text, replyOptions });
        if (reportError) throw new Error("Telegram unavailable");
      },
    };
    return requireService(id);
  }
  fakeRequire.main = main ? serviceModule : undefined;
  vm.runInNewContext(readFileSync(servicePath, "utf8"), {
    require: fakeRequire,
    module: serviceModule,
    __dirname: path.dirname(servicePath),
    process: fakeProcess,
    console: { log() {}, error: (text) => errors.push(text) },
  }, { filename: servicePath });
  return { service: serviceModule.exports, process: fakeProcess, calls, reports, errors };
}

test("launches the restart helper detached with the correct runtime and chat target", async () => {
  const child = new EventEmitter();
  let unreferenced = false;
  child.unref = () => { unreferenced = true; };
  const calls = [];
  const replyOptions = { replyTo: 9, threadId: 77 };
  const restarting = restartService({
    replyOptions,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.equal(unreferenced, true);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [servicePath, "restart", "--notify", JSON.stringify(replyOptions)]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.env.PI_CODING_AGENT_DIR, AGENT_DIR);
  child.emit("close", 0);
  await restarting;
});

test("the detached helper completes after its broker process is stopped", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-service-restart-"));
  const marker = path.join(directory, "completed");
  const helper = path.join(directory, "helper.cjs");
  const broker = path.join(directory, "broker.cjs");
  writeFileSync(helper, `
process.kill(Number(process.env.TEST_BROKER_PID));
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "restart completed");
`);
  writeFileSync(broker, `
const { spawn } = require("node:child_process");
const { restartService } = require(${JSON.stringify(path.resolve(__dirname, "../src/service/restart.cjs"))});
setInterval(() => {}, 1000);
restartService({ spawn: (command, args, options) => spawn(command, [${JSON.stringify(helper)}, ...args.slice(1)], {
  ...options, env: { ...options.env, TEST_BROKER_PID: String(process.pid) },
}) }).catch((error) => { console.error(error); process.exit(1); });
`);
  try {
    const result = spawnSync(process.execPath, [broker], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, "the fake broker should have been stopped");
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(readFileSync(marker, "utf8"), "restart completed", result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart helper errors and abnormal exits reach the broker", async () => {
  for (const failure of ["spawn", "exit", "signal"]) {
    const child = new EventEmitter();
    child.unref = () => {};
    const restarting = restartService({ spawn: () => child });
    if (failure === "spawn") child.emit("error", new Error("cannot spawn"));
    else child.emit("close", failure === "exit" ? 1 : null, failure === "signal" ? "SIGTERM" : null);
    await assert.rejects(restarting, failure === "spawn" ? /cannot spawn/ : /Service restart helper failed/);
  }
});

test("restarts the Windows task only after confirming it exists", () => {
  const loaded = loadService("win32");
  loaded.service.serviceAction("restart");
  assert.deepEqual(loaded.calls.map(({ command, args }) => [command, ...args.slice(0, 2)]), [
    ["schtasks.exe", "/Query", "/TN"],
    ["schtasks.exe", "/End", "/TN"],
    ["powershell.exe", "-NoProfile", "-NonInteractive"],
    ["powershell.exe", "-NoProfile", "-NonInteractive"],
    ["schtasks.exe", "/Run", "/TN"],
  ]);
  const missing = loadService("win32", { fail: (_command, args) => args[0] === "/Query" });
  assert.throws(() => missing.service.serviceAction("restart"), /service manager unavailable/);
  assert.equal(missing.calls.length, 1, "do not kill a detached daemon with no installed task to restart");
});

test("uses systemd restart and launchctl kickstart for installed services", () => {
  const linux = loadService("linux");
  linux.service.serviceAction("restart");
  assert.equal(linux.calls[0].command, "systemctl");
  assert.deepEqual(Array.from(linux.calls[0].args), ["--user", "restart", "pi-telegram-operator"]);
  const mac = loadService("darwin");
  mac.service.serviceAction("restart");
  assert.equal(mac.calls[1].command, "launchctl");
  assert.deepEqual(Array.from(mac.calls[1].args), ["kickstart", "-k", "gui/123/com.johnsonran.pi-telegram-operator"]);
});

test("restart CLI reports success or failure from the independent helper", async () => {
  for (const fails of [false, true]) {
    const loaded = loadService("linux", {
      argv: ["restart", "--notify", JSON.stringify({ replyTo: 9 })],
      main: true,
      fail: () => fails,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loaded.reports.length, 1);
    assert.equal(loaded.reports[0].replyOptions.replyTo, 9);
    assert.match(loaded.reports[0].text, fails ? /restart failed: service manager unavailable/ : /restart command completed/);
    assert.equal(loaded.process.exitCode, fails ? 1 : undefined);
  }
});

test("a failed restart confirmation does not claim the service restart failed", async () => {
  const loaded = loadService("linux", {
    argv: ["restart", "--notify", "{}"],
    main: true,
    reportError: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded.reports.length, 1);
  assert.match(loaded.reports[0].text, /restart command completed/);
  assert.match(loaded.errors[0], /Cannot report service restart: Telegram unavailable/);
  assert.equal(loaded.process.exitCode, 1);
});

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { waitForEnterAfterError } = require("../src/wake/terminal-host.cjs");
const { createTerminalLaunch, shellQuote } = require("../src/wake/terminal.cjs");

test("builds a Windows console launch around the terminal host", () => {
  const launch = createTerminalLaunch("C:\\Temp\\wake.json", {
    platform: "win32",
    nodeCommand: "C:\\Node\\node.exe",
    terminalHostPath: "C:\\Package\\terminal-host.cjs",
    powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  });
  assert.equal(launch.command, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.ok(launch.args.includes("-EncodedCommand"));
  const script = Buffer.from(launch.args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Start-Process/);
  assert.match(script, /-WindowStyle Normal/);
  assert.equal(launch.env.PI_TELEGRAM_TERMINAL_NODE, "C:\\Node\\node.exe");
  assert.equal(launch.env.PI_TELEGRAM_TERMINAL_HOST, "C:\\Package\\terminal-host.cjs");
  assert.equal(launch.env.PI_TELEGRAM_TERMINAL_SPEC_PATH, "C:\\Temp\\wake.json");
  assert.equal(launch.terminal, "Windows Console");
  const detected = [];
  const automatic = createTerminalLaunch("C:\\Temp\\wake.json", {
    platform: "win32",
    nodeCommand: "node.exe",
    terminalHostPath: "host.cjs",
    findExecutable(name) {
      detected.push(name);
      return name === "pwsh.exe" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : undefined;
    },
  });
  assert.deepEqual(detected, ["pwsh.exe"]);
  assert.equal(automatic.command, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
});

test("builds a waiting macOS Terminal AppleScript", () => {
  const launch = createTerminalLaunch("/tmp/wake spec.json", {
    platform: "darwin",
    nodeCommand: "/opt/homebrew/bin/node",
    terminalHostPath: "/tmp/terminal-host.cjs",
  });
  assert.equal(launch.command, "/usr/bin/osascript");
  assert.ok(launch.args.includes("activate"));
  assert.ok(launch.args.includes("repeat while busy of wakeTab"));
  assert.ok(launch.args.some((argument) => argument.includes(shellQuote("/tmp/wake spec.json"))));
  assert.equal(launch.terminal, "Terminal.app");
});

test("selects supported Linux terminals in priority order", () => {
  const found = [];
  const launch = createTerminalLaunch("/tmp/wake.json", {
    platform: "linux",
    nodeCommand: "/usr/bin/node",
    terminalHostPath: "/package/terminal-host.cjs",
    display: ":0",
    runtimeEnv: {},
    findExecutable(name) {
      found.push(name);
      return name === "konsole" ? `/usr/bin/${name}` : undefined;
    },
  });
  assert.deepEqual(found, ["x-terminal-emulator", "gnome-terminal", "konsole"]);
  assert.equal(launch.command, "/usr/bin/konsole");
  assert.deepEqual(launch.args, ["--nofork", "-e", "/usr/bin/node", "/package/terminal-host.cjs", "/tmp/wake.json"]);
  assert.equal(launch.terminal, "konsole");
});

test("tells a Bun-compiled host to run the terminal host script", () => {
  const runtimeEnv = { BUN_BE_BUN: "1" };
  const windows = createTerminalLaunch("C:\\Temp\\wake.json", {
    platform: "win32",
    nodeCommand: "C:\\Pi\\pi.exe",
    terminalHostPath: "host.cjs",
    powershell: "pwsh.exe",
    runtimeEnv,
  });
  assert.equal(windows.env.BUN_BE_BUN, "1");
  const mac = createTerminalLaunch("/tmp/wake.json", {
    platform: "darwin",
    nodeCommand: "/opt/pi",
    terminalHostPath: "/tmp/host.cjs",
    runtimeEnv,
  });
  assert.ok(mac.args.some((argument) => argument.includes(`${shellQuote("/usr/bin/env")} ${shellQuote("BUN_BE_BUN=1")} ${shellQuote("/opt/pi")}`)));
  const linux = createTerminalLaunch("/tmp/wake.json", {
    platform: "linux",
    nodeCommand: "/opt/pi",
    terminalHostPath: "/tmp/host.cjs",
    display: ":0",
    findExecutable: (name) => (name === "xterm" ? "/usr/bin/xterm" : undefined),
    runtimeEnv,
  });
  assert.deepEqual(linux.args, ["-e", "/usr/bin/env", "BUN_BE_BUN=1", "/opt/pi", "/tmp/host.cjs", "/tmp/wake.json"]);
});

test("script runtime switch is set only on Bun and cleared for child Pi processes", () => {
  const { clearScriptRuntimeEnv, scriptRuntimeEnv } = require("../src/shared/script-runtime.cjs");
  assert.deepEqual(scriptRuntimeEnv({ node: "24.0.0" }), {});
  assert.deepEqual(scriptRuntimeEnv({ node: "24.0.0", bun: "1.4.2" }), { BUN_BE_BUN: "1" });
  const env = { BUN_BE_BUN: "1", PATH: "/bin" };
  clearScriptRuntimeEnv(env);
  assert.deepEqual(env, { PATH: "/bin" });
});

test("terminal host runs Pi with the stored cwd and environment", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-terminal-host-test-"));
  const fake = path.join(directory, "fake.cjs");
  const marker = path.join(directory, "marker.json");
  const specPath = path.join(directory, "wake.json");
  writeFileSync(fake, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), value: process.env.WAKE_TEST_VALUE, bunSwitch: process.env.BUN_BE_BUN ?? null })); process.exitCode = 7;\n`);
  writeFileSync(specPath, JSON.stringify({
    command: process.execPath,
    args: [fake, "hello"],
    cwd: directory,
    env: { WAKE_TEST_VALUE: "inherited" },
  }));
  try {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, "../src/wake/terminal-host.cjs"), specPath], {
      encoding: "utf8",
      env: { ...process.env, BUN_BE_BUN: "1" },
      timeout: 30_000,
    });
    assert.equal(child.status, 7, child.stderr);
    const result = JSON.parse(readFileSync(marker, "utf8"));
    assert.deepEqual(result.args, ["hello"]);
    assert.equal(result.value, "inherited");
    assert.equal(result.bunSwitch, null);
    assert.equal(realpathSync(result.cwd), realpathSync(directory));
    assert.equal(existsSync(specPath), false);
    assert.equal(existsSync(`${specPath}.pid`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal host exits quietly when fallback cancels before Pi starts", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-terminal-host-cancel-test-"));
  const marker = path.join(directory, "started.txt");
  const fake = path.join(directory, "fake.cjs");
  const specPath = path.join(directory, "wake.json");
  writeFileSync(fake, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");\n`);
  writeFileSync(specPath, JSON.stringify({
    command: process.execPath,
    args: [fake],
    cwd: directory,
    cancelPath: `${specPath}.cancel`,
    resultPath: `${specPath}.result`,
  }));
  writeFileSync(`${specPath}.cancel`, "cancel\n");
  try {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, "../src/wake/terminal-host.cjs"), specPath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    assert.equal(existsSync(marker), false);
    assert.deepEqual(JSON.parse(readFileSync(`${specPath}.result`, "utf8")), { code: 0, signal: null, cancelled: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal host waits for Enter after an interactive error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  // readline writes cursor escapes and the prompt as separate chunks; a single read()
  // can return only the first one, so collect everything written.
  let written = "";
  output.on("data", (chunk) => { written += chunk; });

  const waiting = waitForEnterAfterError(input, output);
  input.write("\n");
  await waiting;

  assert.match(written, /Press Enter to close this terminal/);
});

test("terminal host does not wait without an interactive terminal", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  await waitForEnterAfterError(input, output);
  assert.equal(output.read(), null);
});

test("returns a fallback reason without a Linux desktop or terminal", () => {
  assert.match(createTerminalLaunch("/tmp/wake.json", {
    platform: "linux",
  }).reason, /no graphical desktop/);
  assert.match(createTerminalLaunch("/tmp/wake.json", {
    platform: "linux",
    waylandDisplay: "wayland-0",
    findExecutable() {
      return undefined;
    },
  }).reason, /no supported terminal emulator/);
});

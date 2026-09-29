const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WINDOWS_DAEMON_MARKER, launchAgent, proxyEnvironment, systemdUnit, windowsDaemonStopScript, windowsTaskStopWaitScript, windowsTaskXml } = require("../service.cjs");

test("stops only the exact Windows daemon process without killing its Pi children", () => {
  const script = windowsDaemonStopScript("C:\\different checkout\\daemon.cjs");
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /\[regex\]::Escape\(\$marker\)/);
  assert.match(script, /Stop-Process -Id \$_.ProcessId -Force/);
  assert.doesNotMatch(script, /different checkout/);
  assert.match(script, /--pi-telegram-operator-service-daemon/);
  assert.doesNotMatch(script, /pi-notify-telegram/);
  assert.doesNotMatch(script, /taskkill|\/T\b/i);
});

test("Windows daemon cleanup preserves child Pi processes", { skip: process.platform !== "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi telegram daemon cleanup test-"));
  const fakeDaemon = path.join(directory, "fake daemon.cjs");
  const fakePi = path.join(directory, "fake pi.cjs");
  const marker = path.join(directory, "child-pid.txt");
  writeFileSync(fakePi, "setInterval(() => process.stderr.write('still running\\n'), 25);\n");
  writeFileSync(fakeDaemon, `
const { spawn } = require("node:child_process");
const { closeSync, openSync, writeFileSync } = require("node:fs");
const stderrFd = openSync(${JSON.stringify(path.join(directory, "fake-pi.stderr"))}, "a");
const child = spawn(process.execPath, [${JSON.stringify(fakePi)}], { detached: true, stdio: ["ignore", "ignore", stderrFd] });
closeSync(stderrFd);
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  const daemon = spawn(process.execPath, [fakeDaemon, WINDOWS_DAEMON_MARKER], { stdio: "ignore" });
  let childPid;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    childPid = Number(readFileSync(marker, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsDaemonStopScript("C:\\different checkout\\daemon.cjs")]);
    const exitDeadline = Date.now() + 5_000;
    while (daemon.exitCode === null && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.notEqual(daemon.exitCode, null, "the daemon process should stop");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.doesNotThrow(() => process.kill(childPid, 0), "the child Pi process should remain alive and keep writing stderr");
  } finally {
    if (daemon.exitCode === null) process.kill(daemon.pid);
    if (childPid) {
      try { process.kill(childPid); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waits for the Windows Scheduled Task wrapper to stop before restarting", () => {
  const script = windowsTaskStopWaitScript("Task's Name", 1234);
  assert.match(script, /Get-ScheduledTask -TaskName 'Task''s Name'/);
  assert.match(script, /State -ne 'Running'/);
  assert.match(script, /AddMilliseconds\(1234\)/);
});

test("builds a hidden supervised unlimited-runtime Windows task", () => {
  const task = windowsTaskXml(
    "C:\\node.exe",
    "C:\\Pi\\daemon.cjs",
    "DESKTOP\\User",
    "C:\\Windows\\System32\\wscript.exe",
    "C:\\Pi\\daemon-windows.vbs",
  );
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(task, /\/\/B \/\/NoLogo &quot;C:\\Pi\\daemon-windows\.vbs&quot; &quot;C:\\node\.exe&quot; &quot;C:\\Pi\\daemon\.cjs&quot; &quot;--pi-telegram-operator-service-daemon&quot;/);
});

test("Windows launcher waits for the daemon and returns its exit code", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi telegram service test-"));
  const fakeDaemon = path.join(directory, "fake daemon.cjs");
  const marker = path.join(directory, "finished.txt");
  writeFileSync(fakeDaemon, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"); process.exitCode = 7;\n`);
  try {
    const child = spawnSync("cscript.exe", [
      "//B",
      "//NoLogo",
      path.resolve(__dirname, "../daemon-windows.vbs"),
      process.execPath,
      fakeDaemon,
      WINDOWS_DAEMON_MARKER,
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 7, child.stderr);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds a restartable Linux systemd user unit", () => {
  const unit = systemdUnit("/usr/bin/node", "/home/me/pi notify/daemon.cjs", "/home/me/.pi/agent", "/home/me/bin:/usr/bin");
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/me\/pi notify\/daemon\.cjs"/);
  assert.match(unit, /Environment="PATH=\/home\/me\/bin:\/usr\/bin"/);
  assert.match(unit, /PassEnvironment=DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /KillMode=process/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("forwards install-time proxy variables into service definitions", () => {
  const proxy = proxyEnvironment({ HTTPS_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1", NO_PROXY: "", HOME: "/home/me" });
  assert.deepEqual(proxy, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:8080" });
  const unit = systemdUnit("/usr/bin/node", "/d.cjs", "/agent", "/usr/bin", proxy);
  assert.match(unit, /Environment="NODE_USE_ENV_PROXY=1"\nEnvironment="HTTPS_PROXY=http:\/\/proxy:8080"\nPassEnvironment/);
  const plist = launchAgent("/usr/bin/node", "/d.cjs", "/agent", "/usr/bin", { HTTPS_PROXY: "http://u:p&q@proxy:8080" });
  assert.match(plist, /<key>HTTPS_PROXY<\/key><string>http:\/\/u:p&amp;q@proxy:8080<\/string><\/dict>/);
  assert.doesNotMatch(systemdUnit("/n", "/d", "/a", "/p", {}), /PROXY/);
});

test("builds a keep-alive macOS LaunchAgent with escaped paths", () => {
  const plist = launchAgent("/opt/A&B/node", "/Users/me/pi<notify>/daemon.cjs", "/Users/me/.pi/agent", "/opt/homebrew/bin:/usr/bin");
  assert.match(plist, /com\.johnsonran\.pi-telegram-operator/);
  assert.match(plist, /\/opt\/A&amp;B\/node/);
  assert.match(plist, /pi&lt;notify&gt;\/daemon\.cjs/);
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/bin/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
});

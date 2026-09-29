#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { chmodSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { daemonLogPath } = require("./src/service/daemon-log.cjs");
const {
  AGENT_DIR,
  WINDOWS_DAEMON_MARKER,
} = require("./src/shared/paths.cjs");

const SERVICE_NAME = "pi-telegram-operator";
const WINDOWS_TASK = "PiTelegramOperator";
const MAC_LABEL = "com.johnsonran.pi-telegram-operator";
const DAEMON_PATH = path.join(__dirname, "daemon.cjs");
const WINDOWS_DAEMON_LAUNCHER_PATH = path.join(__dirname, "daemon-windows.vbs");

const PROXY_ENV_KEYS = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

// Proxy variables present at install time, baked into the unit because
// service managers do not inherit the installing shell's environment.
function proxyEnvironment(environment = process.env) {
  return Object.fromEntries(PROXY_ENV_KEYS.filter((key) => environment[key]).map((key) => [key, environment[key]]));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function systemdPath(serviceName = SERVICE_NAME) {
  return path.join(os.homedir(), ".config", "systemd", "user", `${serviceName}.service`);
}

function launchAgentPath(label = MAC_LABEL) {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function windowsDaemonStopScript() {
  const marker = WINDOWS_DAEMON_MARKER.replace(/'/g, "''");
  return `$marker='${marker}'; Get-CimInstance Win32_Process | Where-Object { if ($_.Name -ne 'node.exe') { return $false }; $pattern='(?i)(?:^|\\s)"?' + [regex]::Escape($marker) + '"?(?:\\s|$)'; $_.CommandLine -match $pattern } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

function windowsTaskStopWaitScript(taskName = WINDOWS_TASK, timeoutMs = 5_000) {
  const name = String(taskName).replace(/'/g, "''");
  return `$deadline=(Get-Date).AddMilliseconds(${Math.max(0, Number(timeoutMs) || 0)}); do { $task=Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if (-not $task -or $task.State -ne 'Running') { exit 0 }; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $deadline); throw 'Scheduled task did not stop: ${name}'`;
}

function windowsTaskXml(
  nodePath = process.execPath,
  daemonPath = DAEMON_PATH,
  userId = `${process.env.USERDOMAIN || ""}\\${process.env.USERNAME || ""}`,
  wscriptPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
  launcherPath = WINDOWS_DAEMON_LAUNCHER_PATH,
) {
  const argumentsText = `//B //NoLogo "${launcherPath}" "${nodePath}" "${daemonPath}" "${WINDOWS_DAEMON_MARKER}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId></LogonTrigger></Triggers>\n<Principals><Principal id="Author"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>\n<Actions Context="Author"><Exec><Command>${xml(wscriptPath)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(path.dirname(daemonPath))}</WorkingDirectory></Exec></Actions>\n</Task>\n`;
}

// Quotes a systemd unit value; systemd expands % specifiers even inside quotes.
function systemdQuote(value) {
  return JSON.stringify(String(value)).replace(/%/g, "%%");
}

// Service definitions may hold proxy credentials, so keep them owner-only.
function writePrivateFile(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function systemdUnit(nodePath = process.execPath, daemonPath = DAEMON_PATH, agentDir = AGENT_DIR, environmentPath = process.env.PATH || "", proxy = proxyEnvironment()) {
  const proxyLines = Object.entries(proxy).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}\n`).join("");
  return `[Unit]\nDescription=TelegraPi Telegram operator for Pi\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(daemonPath)}\nEnvironment=${systemdQuote(`PI_CODING_AGENT_DIR=${agentDir}`)}\nEnvironment=${systemdQuote(`PATH=${environmentPath}`)}\n${proxyLines}PassEnvironment=DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR\nRestart=always\nRestartSec=3\nKillMode=process\n\n[Install]\nWantedBy=default.target\n`;
}

function launchAgent(nodePath = process.execPath, daemonPath = DAEMON_PATH, agentDir = AGENT_DIR, environmentPath = process.env.PATH || "", proxy = proxyEnvironment()) {
  const proxyEntries = Object.entries(proxy).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${MAC_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(daemonPath)}</string></array>\n<key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${xml(agentDir)}</string><key>PATH</key><string>${xml(environmentPath)}</string>${proxyEntries}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>AbandonProcessGroup</key><true/>\n</dict></plist>\n`;
}

function stopWindowsDaemonProcesses() {
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsDaemonStopScript()]);
}

function stopWindows() {
  try { run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK]); } catch {}
  stopWindowsDaemonProcesses();
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsTaskStopWaitScript(WINDOWS_TASK)]);
}

function startWindows() {
  stopWindows();
  run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK]);
}

function installWindows() {
  const file = path.join(os.tmpdir(), `${SERVICE_NAME}-${process.pid}.xml`);
  stopWindows();
  writeFileSync(file, `\uFEFF${windowsTaskXml()}`, { encoding: "utf16le" });
  try {
    run("schtasks.exe", ["/Create", "/TN", WINDOWS_TASK, "/XML", file, "/F"]);
    run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK]);
  } finally {
    rmSync(file, { force: true });
  }
}

function uninstallWindows() {
  stopWindows();
  try { run("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK, "/F"]); } catch {}
}

function installLinux() {
  const file = systemdPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFile(file, systemdUnit());
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
}

function uninstallLinux() {
  try { run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]); } catch {}
  rmSync(systemdPath(), { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
}

function installMac() {
  const file = launchAgentPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFile(file, launchAgent());
  run("plutil", ["-lint", file]);
  try { run("launchctl", ["bootout", `gui/${process.getuid()}`, file]); } catch {}
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, file]);
}

function startMac() {
  // stop uses bootout, which unloads the agent; reload it before kickstart.
  try { run("launchctl", ["bootstrap", `gui/${process.getuid()}`, launchAgentPath()], { capture: true }); } catch {}
  run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${MAC_LABEL}`]);
}

function uninstallMac() {
  const file = launchAgentPath();
  try { run("launchctl", ["bootout", `gui/${process.getuid()}`, file]); } catch {}
  rmSync(file, { force: true });
}

function serviceAction(action) {
  if (process.platform === "win32") {
    if (action === "install") return installWindows();
    if (action === "uninstall") return uninstallWindows();
    if (action === "start") return startWindows();
    if (action === "stop") return stopWindows();
    if (action === "status") return run("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"]);
  } else if (process.platform === "darwin") {
    const target = `gui/${process.getuid()}/${MAC_LABEL}`;
    if (action === "install") return installMac();
    if (action === "uninstall") return uninstallMac();
    if (action === "start") return startMac();
    if (action === "stop") return run("launchctl", ["bootout", `gui/${process.getuid()}`, launchAgentPath()]);
    if (action === "status") return run("launchctl", ["print", target]);
  } else {
    if (action === "install") return installLinux();
    if (action === "uninstall") return uninstallLinux();
    if (["start", "stop", "status"].includes(action)) return run("systemctl", ["--user", action, SERVICE_NAME]);
  }
  throw new Error(`Unknown action: ${action}`);
}

if (require.main === module) {
  const action = String(process.argv[2] || "status").toLowerCase();
  if (!["install", "uninstall", "start", "stop", "status"].includes(action)) {
    console.error("Usage: node service.cjs <install|uninstall|start|stop|status>");
    process.exit(2);
  }

  try {
    serviceAction(action);
    if (action === "install") console.log(`Installed and started ${SERVICE_NAME} for ${process.platform}.`);
    if (action === "status") console.log(`Daemon log: ${daemonLogPath(AGENT_DIR)}`);
    if (action === "uninstall") console.log(`Uninstalled ${SERVICE_NAME} for ${process.platform}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = Object.freeze({ WINDOWS_DAEMON_MARKER, launchAgent, proxyEnvironment, systemdUnit, windowsDaemonStopScript, windowsTaskStopWaitScript, windowsTaskXml });

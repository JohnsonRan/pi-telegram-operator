const { accessSync, constants } = require("node:fs");
const path = require("node:path");
const { scriptRuntimeEnv } = require("../shared/script-runtime.cjs");

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function findExecutable(name, environmentPath = process.env.PATH || "") {
  for (const directory of String(environmentPath).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

function createTerminalLaunch(specPath, options = {}) {
  const platform = String(options.platform || process.platform);
  const nodeCommand = String(options.nodeCommand || process.execPath);
  const terminalHostPath = String(options.terminalHostPath);
  const runtimeEnv = options.runtimeEnv || scriptRuntimeEnv();
  // Terminal emulators may not inherit our environment, so Unix hosts get it via env(1).
  const runtimeAssignments = Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`);
  const hostCommand = runtimeAssignments.length > 0 ? ["/usr/bin/env", ...runtimeAssignments, nodeCommand] : [nodeCommand];

  if (platform === "win32") {
    const locate = options.findExecutable || findExecutable;
    const environmentPath = options.environmentPath ?? process.env.PATH ?? "";
    const powershell = String(options.powershell || locate("pwsh.exe", environmentPath) || locate("powershell.exe", environmentPath) || "powershell.exe");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$hostArg = '\"' + $env:PI_TELEGRAM_TERMINAL_HOST.Replace('\"', '\\\"') + '\"'",
      "$child = Start-Process -FilePath $env:PI_TELEGRAM_TERMINAL_NODE -ArgumentList $hostArg -WindowStyle Normal -PassThru -Wait",
      "exit $child.ExitCode",
    ].join("\n");
    return {
      command: powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
      env: {
        ...runtimeEnv,
        PI_TELEGRAM_TERMINAL_HOST: terminalHostPath,
        PI_TELEGRAM_TERMINAL_NODE: nodeCommand,
        PI_TELEGRAM_TERMINAL_SPEC_PATH: specPath,
      },
      terminal: "Windows Console",
      windowsHide: true,
    };
  }

  if (platform === "darwin") {
    const osascript = options.osascript || "/usr/bin/osascript";
    const command = [...hostCommand, terminalHostPath, specPath].map(shellQuote).join(" ");
    return {
      command: osascript,
      args: [
        "-e", "tell application \"Terminal\"",
        "-e", "activate",
        "-e", `set wakeTab to do script ${appleScriptString(command)}`,
        "-e", "repeat while busy of wakeTab",
        "-e", "delay 1",
        "-e", "end repeat",
        "-e", "end tell",
      ],
      terminal: "Terminal.app",
      windowsHide: false,
    };
  }

  if (platform === "linux") {
    if (!options.display && !options.waylandDisplay) {
      return { reason: "no graphical desktop is available (DISPLAY and WAYLAND_DISPLAY are unset)" };
    }
    const locate = options.findExecutable || findExecutable;
    const environmentPath = options.environmentPath ?? process.env.PATH ?? "";
    const candidates = [
      { name: "x-terminal-emulator", args: ["-e", ...hostCommand, terminalHostPath, specPath] },
      { name: "gnome-terminal", args: ["--wait", "--", ...hostCommand, terminalHostPath, specPath] },
      { name: "konsole", args: ["--nofork", "-e", ...hostCommand, terminalHostPath, specPath] },
      { name: "xfce4-terminal", args: ["--disable-server", "-x", ...hostCommand, terminalHostPath, specPath] },
      { name: "xterm", args: ["-e", ...hostCommand, terminalHostPath, specPath] },
    ];
    for (const candidate of candidates) {
      const executable = locate(candidate.name, environmentPath);
      if (executable) {
        return {
          command: executable,
          args: candidate.args,
          terminal: candidate.name,
          windowsHide: false,
        };
      }
    }
    return { reason: "no supported terminal emulator was found" };
  }

  return { reason: `foreground terminals are not supported on ${platform}` };
}

module.exports = Object.freeze({ createTerminalLaunch, shellQuote });

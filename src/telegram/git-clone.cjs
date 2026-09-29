const { execFile } = require("node:child_process");
const { lstat, realpath } = require("node:fs/promises");
const path = require("node:path");
const { isPathInside } = require("../shared/paths.cjs");
const { resolveWakeCwd } = require("../wake/launcher.cjs");

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function parseGitCloneCommand(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(?:\/clone(?:@\w+)?|git\s+clone)\s+(\S+)(?:\s+(\S+))?$/i);
  if (!match) return undefined;
  return { remote: match[1], directory: match[2] || "" };
}

function validateRemote(remote) {
  const value = String(remote || "").trim();
  const urlRemote = /^(?:https?|ssh|git):\/\/[^\s]+$/i.test(value);
  const scpRemote = !/^[a-z]:[\\/]/i.test(value) && /^(?:[a-z0-9._-]+@)?[a-z0-9.-]+:[^\s]+$/i.test(value);
  if (!urlRemote && !scpRemote) {
    throw new Error("Repository must use an HTTPS, SSH, or git remote URL");
  }
  return value;
}

function remoteRepositoryName(remote) {
  let pathname;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    pathname = new URL(remote).pathname;
  } else {
    pathname = remote.slice(remote.indexOf(":") + 1);
  }
  const name = path.posix.basename(pathname.replace(/\/+$/, "")).replace(/\.git$/i, "");
  return decodeURIComponent(name);
}

function validateDirectoryName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 120 || name === "." || name === ".." || name.startsWith("-") || name.endsWith(".") || !/^[a-z0-9._-]+$/i.test(name) || WINDOWS_RESERVED_NAMES.test(name)) {
    throw new Error("Clone directory must be a safe single directory name");
  }
  return name;
}

function cloneWithGit(remote, destination, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", ["clone", "--", remote, destination], {
      cwd,
      windowsHide: true,
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(error, { gitOutput: String(stderr || stdout || error.message || "") }));
    });
  });
}

function formatCloneError(error) {
  const text = String(error?.gitOutput || error?.message || error || "Git clone failed")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  if (!text) return "Git clone failed";
  return text.length > 1200 ? `…${text.slice(-1199)}` : text;
}

async function cloneRepository(options) {
  const remote = validateRemote(options.remote);
  const baseCwd = await resolveWakeCwd("", options.defaultCwd, options.allowedRoots);
  const directory = validateDirectoryName(options.directory || remoteRepositoryName(remote));
  const destination = path.join(baseCwd, directory);
  if (await lstat(destination).catch(() => undefined)) {
    throw new Error(`Clone destination already exists: ${destination}`);
  }
  try {
    await (options.runGit || cloneWithGit)(remote, destination, baseCwd);
  } catch (error) {
    throw new Error(formatCloneError(error), { cause: error });
  }
  const clonedCwd = await realpath(destination).catch(() => undefined);
  if (!clonedCwd) throw new Error(`Git clone did not create the repository directory: ${destination}`);
  if (!isPathInside(baseCwd, clonedCwd)) {
    throw new Error("Cloned repository resolved outside wakeDefaultCwd");
  }
  return { remote, directory, cwd: clonedCwd };
}

module.exports = Object.freeze({
  cloneRepository,
  formatCloneError,
  parseGitCloneCommand,
  remoteRepositoryName,
  validateDirectoryName,
  validateRemote,
});

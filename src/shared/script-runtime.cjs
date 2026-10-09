// A standalone Bun executable (such as a compiled pi.exe) runs its own CLI when
// launched with a script path. BUN_BE_BUN=1 makes it run the script instead, so
// process.execPath can start package scripts under both Node and Bun hosts.
const BUN_SCRIPT_VARIABLE = "BUN_BE_BUN";

/** @returns {Record<string, string>} */
function scriptRuntimeEnv(versions = process.versions) {
  return versions.bun ? { [BUN_SCRIPT_VARIABLE]: "1" } : {};
}

// Package scripts must not leak the switch into Pi processes they start;
// otherwise a compiled Pi would behave as bare Bun.
function clearScriptRuntimeEnv(env = process.env) {
  delete env[BUN_SCRIPT_VARIABLE];
}

module.exports = Object.freeze({ clearScriptRuntimeEnv, scriptRuntimeEnv });

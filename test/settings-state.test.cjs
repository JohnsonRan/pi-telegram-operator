const assert = require("node:assert/strict");
const { mkdtemp, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { persistBrokerState, readBrokerState } = require("../src/broker/state.cjs");
const { readSettings } = require("../src/shared/settings.cjs");

const token = `123456:${"a".repeat(32)}`;
const config = {
  chatId: 42,
  allowedUserId: 42,
  bridgeSecret: "b".repeat(64),
  port: 43871,
  wakeMode: false,
};

async function temporaryPaths() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-operator-state-"));
  return {
    directory,
    secretPath: path.join(directory, "pi-telegram-operator.secret"),
    configPath: path.join(directory, "pi-telegram-operator.json"),
    statePath: path.join(directory, "pi-telegram-operator.state.json"),
  };
}

test("reads canonical TelegraPi settings", async () => {
  const paths = await temporaryPaths();
  try {
    await writeFile(paths.secretPath, `${token}\n`, { mode: 0o600 });
    await writeFile(paths.configPath, JSON.stringify(config), { mode: 0o600 });
    const settings = await readSettings(paths);
    assert.equal(settings.botToken, token);
    assert.equal(settings.chatId, 42);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("rejects incomplete canonical settings", async () => {
  const paths = await temporaryPaths();
  try {
    await writeFile(paths.secretPath, `${token}\n`, { mode: 0o600 });
    await assert.rejects(() => readSettings(paths), /both secret and config files are required/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("ignores settings stored under the retired package name", async () => {
  const paths = await temporaryPaths();
  try {
    await writeFile(path.join(paths.directory, "pi-notify-telegram.secret"), `${token}\n`, { mode: 0o600 });
    await writeFile(path.join(paths.directory, "pi-notify-telegram.json"), JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(() => readSettings(paths), /setup is incomplete/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("persists and reads only the canonical broker state", async () => {
  const paths = await temporaryPaths();
  try {
    const state = {
      offset: 12,
      mappings: new Map(),
      pendingReplies: new Map(),
      pendingQuestions: new Map(),
      topics: new Map(),
    };
    await persistBrokerState(state, paths.statePath);
    assert.deepEqual(await readdir(paths.directory), ["pi-telegram-operator.state.json"]);
    const stored = await readBrokerState(paths.statePath);
    assert.equal(stored.offset, 12);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

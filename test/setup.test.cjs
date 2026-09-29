const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { brokerIsRunning, mergePreviousInstallation, preserveOperationalConfig, writeStagedFiles } = require("../setup.cjs");

test("setup checks the configured broker port", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const reads = [];
  const read = async (file) => {
    reads.push(file);
    return JSON.stringify({ port });
  };
  try {
    assert.equal(await brokerIsRunning(read), true);
    assert.deepEqual(reads.map((file) => path.basename(file)), ["pi-telegram-operator.json"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rerunning setup preserves valid operational preferences", () => {
  const config = {
    port: 43871,
    linkPreview: false,
    apiBaseUrl: "https://api.telegram.org",
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  };

  preserveOperationalConfig(config, {
    port: 44000,
    linkPreview: true,
    apiBaseUrl: "http://127.0.0.1:8081",
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakePiCommand: "custom-pi",
    wakePiCommandArgs: ["--profile", "wake"],
    wakeOpenTerminal: false,
  });

  assert.deepEqual(config, {
    port: 44000,
    linkPreview: true,
    apiBaseUrl: "http://127.0.0.1:8081",
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakePiCommand: "custom-pi",
    wakePiCommandArgs: ["--profile", "wake"],
    wakeOpenTerminal: false,
  });
});

test("rerunning setup preserves config when the previous state file is missing", async () => {
  const config = {
    chatId: 42,
    allowedUserId: 42,
    port: 43871,
    wakeMode: false,
    wakeAllowedRoots: [],
    wakeOpenTerminal: true,
  };
  const state = { offset: 7, mappings: [], pendingReplies: [], topics: [] };
  const read = async (file) => {
    if (file.endsWith("pi-telegram-operator.json")) {
      return JSON.stringify({ ...config, port: 44000, wakeMode: true, wakeAllowedRoots: ["F:\\"], wakeOpenTerminal: false });
    }
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  const merged = await mergePreviousInstallation(config, state, { chat: { id: 42 }, from: { id: 42 } }, read);
  assert.equal(merged.config.port, 44000);
  assert.equal(merged.config.wakeMode, true);
  assert.deepEqual(merged.config.wakeAllowedRoots, ["F:\\"]);
  assert.equal(merged.config.wakeOpenTerminal, false);
  assert.equal(merged.state, state);
});

test("rerunning setup preserves pending Telegram questions", async () => {
  const config = { chatId: 42, allowedUserId: 42, port: 43871 };
  const state = { offset: 0, mappings: [], pendingReplies: [], pendingQuestions: [], topics: [] };
  const question = { questionId: "q1", sessionId: "s1", options: ["Yes", "No"] };
  const read = async (file) => JSON.stringify(file.endsWith("pi-telegram-operator.json")
    ? config
    : { offset: 8, mappings: [], pendingReplies: [], pendingQuestions: [question], topics: [] });
  const merged = await mergePreviousInstallation(config, state, { chat: { id: 42 }, from: { id: 42 } }, read);
  assert.equal(merged.state.offset, 8);
  assert.deepEqual(merged.state.pendingQuestions, [question]);
});

test("rerunning setup preserves canonical state", async () => {
  const config = { chatId: 42, allowedUserId: 42, port: 43871 };
  const state = { offset: 0, mappings: [], pendingReplies: [], pendingQuestions: [], topics: [] };
  const pendingReply = { deliveryId: "current", sessionId: "a", text: "one" };
  const read = async (file) => {
    if (file.endsWith("pi-telegram-operator.json")) return JSON.stringify(config);
    if (file.endsWith("pi-telegram-operator.state.json")) {
      return JSON.stringify({ offset: 9, mappings: [], pendingReplies: [pendingReply], pendingQuestions: [], topics: [] });
    }
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  const merged = await mergePreviousInstallation(config, state, { chat: { id: 42 }, from: { id: 42 } }, read);
  assert.equal(merged.state.offset, 9);
  assert.deepEqual(merged.state.pendingReplies, [pendingReply]);
});

test("stages all setup files before replacing their destinations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-operator-setup-stage-"));
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  try {
    await Promise.all([writeFile(first, "old one"), writeFile(second, "old two")]);
    await writeStagedFiles([
      { file: first, content: "one", options: { mode: 0o600 } },
      { file: second, content: "two", options: { mode: 0o600 } },
    ]);
    assert.equal(await readFile(first, "utf8"), "one");
    assert.equal(await readFile(second, "utf8"), "two");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rerunning setup ignores invalid operational preferences", () => {
  const config = {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  };

  preserveOperationalConfig(config, {
    port: 0,
    linkPreview: "yes",
    wakeMode: 1,
    wakeDefaultCwd: null,
    wakeAllowedRoots: ["F:\\", 42],
    wakePiCommand: "",
    wakePiCommandArgs: [null],
    wakeOpenTerminal: "yes",
  });

  assert.deepEqual(config, {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  });
});

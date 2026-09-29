const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// launchWakeSession persists broker state under the agent directory.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telegram-wake-session-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { __test: router } = require("../src/telegram/router.cjs");

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

// plan: one entry per launch() call, each { started, foreground, terminal, throws, registers }.
// registers: the launched Pi connects to the broker as a wake child.
// cancelStops: whether cancel() ends the running process.
function fakeLauncher(plan, { cancelStops = true, runningAfterLaunch = true } = {}) {
  const launcher = {
    launches: [],
    cancels: 0,
    running: false,
    async launch(options) {
      launcher.launches.push(options);
      const next = plan.shift();
      if (next.throws) throw new Error(next.throws);
      launcher.running = runningAfterLaunch;
      if (next.registers) launcher.onRegister();
      return { started: true, foreground: false, ...next };
    },
    isRunning: () => launcher.running,
    cancel() {
      launcher.cancels += 1;
      if (cancelStops) launcher.running = false;
    },
  };
  return launcher;
}

function wakeState(t, launcher, { wakeOpenTerminal = true, connected = false } = {}) {
  const notices = [];
  t.mock.method(global, "fetch", async (_url, init) => {
    notices.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: notices.length } }));
  });
  const topic = { sessionId: "11111111-1111-4111-8111-111111111111", threadId: 9, name: "demo", cwd: agentDir };
  const state = {
    secret: { botToken: "token", chatId: 42, wakeDefaultCwd: agentDir, wakeAllowedRoots: [agentDir], wakeOpenTerminal },
    offset: 0,
    topics: new Map([[topic.sessionId, topic]]),
    mappings: new Map(),
    pendingReplies: new Map(),
    pendingQuestions: new Map(),
    clientsBySession: new Map(),
    wakeReservations: new Set(),
    foregroundStartups: new Set(),
    wakeLauncher: launcher,
    persistQueue: Promise.resolve(),
  };
  if (connected) state.clientsBySession.set(topic.sessionId, wakeClient(false));
  launcher.onRegister = () => state.clientsBySession.set(topic.sessionId, wakeClient());
  return { state, topic, notices };
}

function wakeClient(wakeChild = true) {
  return { registered: true, wakeChild, socket: { destroyed: false } };
}

// Advances mocked time in 100 ms steps until the promise settles.
async function drive(t, promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
  }
  return promise;
}

function enableTimers(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
}

test("starts a background wake session without terminal checks", async (t) => {
  const launcher = fakeLauncher([{ started: true }]);
  const { state, topic, notices } = wakeState(t, launcher, { wakeOpenTerminal: false });
  const launched = await router.launchWakeSession(state, topic, "hello", 5);
  assert.equal(launched.started, true);
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.cancels, 0);
  assert.match(notices[0], /Starting in background mode/);
  assert.equal(state.wakeReservations.has(topic.sessionId), true);
  assert.equal(state.foregroundStartups.size, 0);
});

test("keeps a foreground terminal that registers and stays running", async (t) => {
  enableTimers(t);
  const launcher = fakeLauncher([{ foreground: true, terminal: "Windows Console", registers: true }]);
  const { state, topic, notices } = wakeState(t, launcher);
  const launched = await drive(t, router.launchWakeSession(state, topic, "hello"));
  assert.equal(launched.foreground, true);
  assert.equal(launcher.launches.length, 1);
  assert.deepEqual(notices, [`Waking Pi session 11111111…\nOpening Windows Console`]);
  assert.equal(state.wakeReservations.has(topic.sessionId), true);
  assert.equal(state.foregroundStartups.size, 0);
});

test("falls back to background when the terminal never connects", async (t) => {
  enableTimers(t);
  const launcher = fakeLauncher([{ foreground: true, terminal: "xterm" }, { started: true }]);
  const { state, topic, notices } = wakeState(t, launcher);
  const launched = await drive(t, router.launchWakeSession(state, topic, "hello"));
  assert.equal(launched.foreground, false);
  assert.equal(launcher.cancels, 1);
  assert.equal(launcher.launches[1].openTerminal, false);
  assert.match(notices[1], /Terminal did not connect; switched to background mode/);
  assert.equal(state.wakeReservations.has(topic.sessionId), true);
  assert.equal(state.foregroundStartups.size, 0);
});

test("falls back to background when the terminal exits after registering", async (t) => {
  enableTimers(t);
  const launcher = fakeLauncher([{ foreground: true, registers: true }, { started: true }], { runningAfterLaunch: false });
  const { state, topic, notices } = wakeState(t, launcher);
  await drive(t, router.launchWakeSession(state, topic, "hello"));
  assert.equal(launcher.launches.length, 2);
  assert.match(notices[1], /Terminal exited during startup; switched to background mode/);
  assert.equal(state.foregroundStartups.size, 0);
});

test("fails and releases the reservation when a silent terminal cannot be stopped", async (t) => {
  enableTimers(t);
  const launcher = fakeLauncher([{ foreground: true }], { cancelStops: false });
  const { state, topic } = wakeState(t, launcher);
  await assert.rejects(drive(t, router.launchWakeSession(state, topic, "hello")), /did not connect to the Telegram broker/);
  assert.equal(launcher.launches.length, 1);
  assert.equal(state.wakeReservations.size, 0);
  assert.equal(state.foregroundStartups.size, 0);
});

test("does not launch twice for a reserved or connected session", async (t) => {
  const launcher = fakeLauncher([]);
  const reserved = wakeState(t, launcher);
  reserved.state.wakeReservations.add(reserved.topic.sessionId);
  assert.deepEqual(await router.launchWakeSession(reserved.state, reserved.topic, "hi"), { started: false, reserved: true });

  const connected = wakeState(t, launcher, { connected: true });
  assert.deepEqual(await router.launchWakeSession(connected.state, connected.topic, "hi"), { started: false, connected: true });
  assert.equal(connected.state.wakeReservations.size, 0);
  assert.equal(launcher.launches.length, 0);
});

test("releases wake bookkeeping when launching throws", async (t) => {
  const launcher = fakeLauncher([{ throws: "spawn pi ENOENT" }]);
  const { state, topic } = wakeState(t, launcher);
  await assert.rejects(router.launchWakeSession(state, topic, "hi"), /ENOENT/);
  assert.equal(state.wakeReservations.size, 0);
  assert.equal(state.foregroundStartups.size, 0);
});

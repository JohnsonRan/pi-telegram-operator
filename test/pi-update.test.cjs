const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  parsePiUpdateCommand,
  runPiUpdate,
} = require("../src/telegram/pi-update.cjs");

function fakeChild(result) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  process.nextTick(() => {
    if (result.stdout) child.stdout.write(result.stdout);
    if (result.stderr) child.stderr.write(result.stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", result.code ?? 0, result.signal || null);
  });
  return child;
}

test("parses only exact Pi update control commands", () => {
  assert.deepEqual(parsePiUpdateCommand("/update"), { command: "update" });
  assert.deepEqual(parsePiUpdateCommand("/update@my_bot"), { command: "update" });
  assert.deepEqual(parsePiUpdateCommand("pi update --all"), { command: "update" });
  assert.deepEqual(parsePiUpdateCommand("pi update —all"), { command: "update" });
  assert.equal(parsePiUpdateCommand("pi update --all && whoami"), undefined);
  assert.equal(parsePiUpdateCommand("pi update package-name"), undefined);
});

test("runs pi update --all without a shell and returns bounded output", async () => {
  const calls = [];
  const output = await runPiUpdate({
    piCommand: "custom-pi",
    cwd: "/work",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild({ stdout: "Updated package-a\n", stderr: "Updated package-b\n" });
    },
  });
  assert.equal(output, "Updated package-a\nUpdated package-b");
  assert.equal(calls[0].command, "custom-pi");
  assert.deepEqual(calls[0].args, ["update", "--all"]);
  assert.equal(calls[0].options.cwd, "/work");
  assert.equal(calls[0].options.shell, undefined);
});

test("reports Pi update failures with command output", async () => {
  await assert.rejects(() => runPiUpdate({
    spawn: () => fakeChild({ code: 1, stderr: "network unavailable" }),
  }), /pi update --all failed \(code 1\)\nnetwork unavailable/);
});

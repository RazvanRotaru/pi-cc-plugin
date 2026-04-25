import test from "node:test";
import assert from "node:assert/strict";
import { resolvePi, describePi } from "../plugins/pi/scripts/lib/pi-spawn.mjs";

test("unix path resolution: pi from $PATH", () => {
  const desc = resolvePi({ env: {}, platform: "linux" });
  assert.equal(desc.command, "pi");
  assert.deepEqual(desc.args, []);
  assert.equal(desc.source, "path");
});

test("unix on darwin: pi from $PATH", () => {
  const desc = resolvePi({ env: {}, platform: "darwin" });
  assert.equal(desc.command, "pi");
  assert.equal(desc.source, "path");
});

test("env override: PI_BROKER_PI_BIN", () => {
  const desc = resolvePi({
    env: { PI_BROKER_PI_BIN: "/usr/local/bin/fake-pi" },
    platform: "linux",
  });
  assert.equal(desc.command, "/usr/local/bin/fake-pi");
  assert.deepEqual(desc.args, []);
  assert.equal(desc.source, "env-override");
});

test("env override: PI_BROKER_PI_BIN + PI_BROKER_PI_ARGS", () => {
  const desc = resolvePi({
    env: {
      PI_BROKER_PI_BIN: "/usr/bin/node",
      PI_BROKER_PI_ARGS: "/path/to/fake-pi.mjs,--shim",
    },
    platform: "linux",
  });
  assert.equal(desc.command, "/usr/bin/node");
  assert.deepEqual(desc.args, ["/path/to/fake-pi.mjs", "--shim"]);
  assert.equal(desc.source, "env-override");
});

test("env override beats platform-specific resolution on win32", () => {
  const desc = resolvePi({
    env: { PI_BROKER_PI_BIN: "node", PI_BROKER_PI_ARGS: "C:/x/pi.js" },
    platform: "win32",
  });
  assert.equal(desc.source, "env-override");
});

test("describePi: bare command", () => {
  assert.equal(describePi({ command: "pi", args: [] }), "pi");
});

test("describePi: command with args", () => {
  assert.equal(
    describePi({ command: "node", args: ["/path/to/pi.js", "--flag"] }),
    "node /path/to/pi.js --flag",
  );
});

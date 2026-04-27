// Scaffold smoke test — proves the plugin manifest is well-formed and the
// broker dispatches actions without errors. Real /pi:* behavior is tested
// in the milestone-specific test files.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO_ROOT, runBroker, withTempCwd } from "./helpers.mjs";

test("/pi:status (no args) prints the alive message", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await runBroker(["status"], { cwd });
    assert.equal(code, 0);
    assert.match(stdout, /pi-cc-plugin alive/);
  });
});

test("unknown action exits non-zero with a hint", async () => {
  const { code, stderr } = await runBroker(["nope"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown action/);
  assert.match(stderr, /available:/);
});

test("missing action exits non-zero", async () => {
  const { code, stderr } = await runBroker([]);
  assert.notEqual(code, 0);
  assert.match(stderr, /missing action/);
});

test("marketplace.json lists exactly one plugin named 'pi'", async () => {
  const data = JSON.parse(
    await readFile(resolve(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  );
  assert.equal(data.plugins.length, 1);
  assert.equal(data.plugins[0].name, "pi");
});

test("plugin.json has version + description", async () => {
  const data = JSON.parse(
    await readFile(
      resolve(REPO_ROOT, "plugins/pi/.claude-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(data.name, "pi");
  assert.ok(data.version);
  assert.ok(data.description);
});

test("every command file references the broker", async () => {
  const cmds = ["status", "run", "result", "cancel", "setup"];
  for (const cmd of cmds) {
    const body = await readFile(
      resolve(REPO_ROOT, `plugins/pi/commands/${cmd}.md`),
      "utf8",
    );
    assert.match(body, /pi-broker\.mjs/, `command "${cmd}" must invoke pi-broker.mjs`);
    assert.match(body, new RegExp(`pi-broker\\.mjs"?\\s+${cmd}\\b`));
  }
});

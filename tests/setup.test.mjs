import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fakePiEnv, runBroker, withTempCwd } from "./helpers.mjs";

test("/pi:setup with all checks ok prints OK lines and exits 0", async () => {
  await withTempCwd(async (cwd) => {
    // Pre-create .git so the gitignore step is a no-op (clean output).
    await mkdir(join(cwd, ".git"));
    const env = fakePiEnv();
    const { code, stdout } = await runBroker(["setup", "--yes"], { cwd, env });
    assert.equal(code, 0);
    assert.match(stdout, /pi installed/);
    assert.match(stdout, /pi-subagents installed/);
    assert.match(stdout, /specialist seeds/);
    assert.match(stdout, /setup done/);
  });
});

test("/pi:setup --yes scaffolds .pi/agents/ on first run", async () => {
  await withTempCwd(async (cwd) => {
    const env = fakePiEnv();
    await runBroker(["setup", "--yes"], { cwd, env });
    const files = await readdir(join(cwd, ".pi/agents"));
    const expected = [
      "architect.md",
      "test-writer.md",
      "test-reviewer.md",
      "implementer.md",
      "code-reviewer.md",
      "ci-triage.md",
    ];
    for (const name of expected) {
      assert.ok(files.includes(name), `missing seed: ${name}`);
    }
  });
});

test("/pi:setup is idempotent — second run reports seeds already present", async () => {
  await withTempCwd(async (cwd) => {
    const env = fakePiEnv();
    await runBroker(["setup", "--yes"], { cwd, env });
    const { code, stdout } = await runBroker(["setup", "--yes"], { cwd, env });
    assert.equal(code, 0);
    assert.match(stdout, /all 6 seeds present/);
  });
});

test("/pi:setup never overwrites a user-customized seed", async () => {
  await withTempCwd(async (cwd) => {
    const env = fakePiEnv();
    await runBroker(["setup", "--yes"], { cwd, env });
    const archPath = join(cwd, ".pi/agents/architect.md");
    const customized = "---\ndescription: my custom architect\n---\n\nI am customized.\n";
    await (await import("node:fs/promises")).writeFile(archPath, customized);
    await runBroker(["setup", "--yes"], { cwd, env });
    const after = await readFile(archPath, "utf8");
    assert.equal(after, customized);
  });
});

test("/pi:setup without pi installed: hard fails", async () => {
  await withTempCwd(async (cwd) => {
    const env = fakePiEnv({ PI_BROKER_PI_BIN: "/no/such/binary" });
    const { code, stdout, stderr } = await runBroker(["setup", "--yes"], { cwd, env });
    assert.notEqual(code, 0);
    assert.match(stdout, /pi installed/);
    assert.match(stderr, /hard failures/);
  });
});

test("/pi:setup with pi-subagents missing: hard fails", async () => {
  await withTempCwd(async (cwd) => {
    const env = fakePiEnv({ FAKE_PI_INSTALLED: "0" });
    const { code, stdout, stderr } = await runBroker(["setup", "--yes"], { cwd, env });
    assert.notEqual(code, 0);
    assert.match(stdout, /pi-subagents installed.*Install via/s);
    assert.match(stderr, /hard failures/);
  });
});

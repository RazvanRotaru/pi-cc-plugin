import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakePiEnv, runBroker, withTempCwd } from "./helpers.mjs";

async function withFakePiTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cc-plugin-fakepi-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("/pi:chain runs N steps and records a chain job", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        [
          "chain",
          "scout[find affected modules]",
          "->",
          "planner[draft a plan]",
          "->",
          "worker[execute the plan]",
          "--bg",
        ],
        { cwd, env },
      );
      assert.equal(code, 0);
      assert.match(stdout, /Started job-001 \(chain, 3 steps/);

      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs[0].kind, "chain");
      assert.deepEqual(state.jobs[0].agents, ["scout", "planner", "worker"]);
    }),
  );
});

test("/pi:chain status reflects per-step progress from pi", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      await runBroker(
        ["chain", "scout[a]", "->", "worker[b]", "--bg"],
        { cwd, env },
      );
      const { stdout } = await runBroker(["status", "job-001"], { cwd });
      assert.match(stdout, /chain/);
      assert.match(stdout, /scout/);
      assert.match(stdout, /worker/);
      assert.match(stdout, /steps:/);
    }),
  );
});

test("/pi:parallel runs N tasks with --worktree", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        [
          "parallel",
          "test-writer[module A]",
          "test-writer[module B]",
          "test-writer[module C]",
          "--worktree",
          "--bg",
        ],
        { cwd, env },
      );
      assert.equal(code, 0);
      assert.match(stdout, /parallel, 3 tasks, worktree/);

      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs[0].kind, "parallel");
      assert.equal(state.jobs[0].worktree, true);
      assert.equal(state.jobs[0].agents.length, 3);
    }),
  );
});

test("/pi:parallel rejects bare-form items (must use agent[task])", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stderr } = await runBroker(
        ["parallel", "writer", "task A", "writer", "task B", "--bg"],
        { cwd, env },
      );
      assert.notEqual(code, 0);
      assert.match(stderr, /agent\["task"\]/);
    }),
  );
});

test("/pi:result on a chain job reads output-N.log", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      await runBroker(
        ["chain", "scout[a]", "->", "worker[b]", "--bg"],
        { cwd, env },
      );
      const { code, stdout } = await runBroker(["result", "job-001"], { cwd });
      assert.equal(code, 0);
      assert.match(stdout, /Lorem ipsum/);
    }),
  );
});

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

test("/pi:result reads output-N.log from pi's status dir", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      await runBroker(["run", "worker", "fix the bug", "--bg"], { cwd, env });
      const { code, stdout } = await runBroker(["result", "job-001"], { cwd });
      assert.equal(code, 0);
      assert.match(stdout, /# job-001/);
      assert.match(stdout, /## Result/);
      assert.match(stdout, /Lorem ipsum simulated output/);
      assert.match(stdout, /Task: fix the bug/);
    }),
  );
});

test("/pi:result accepts pi-run-id prefix", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp, FAKE_PI_RUN_ID: "feedface1234" });
      await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      const { code, stdout } = await runBroker(["result", "feedface"], { cwd });
      assert.equal(code, 0);
      assert.match(stdout, /feedface1234/);
    }),
  );
});

test("/pi:result on a missing-result run falls back to log/empty message", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_SCENARIO: "stale-dir",
      });
      await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      const { code, stdout } = await runBroker(["result", "job-001"], { cwd });
      assert.equal(code, 0);
      assert.match(stdout, /no output-N\.log/);
    }),
  );
});

test("/pi:cancel marks state as cancelled (clean-shutdown path)", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      // Keep fake-pi running long enough that cancel really has to act.
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp, FAKE_PI_DELAY_MS: "10000" });
      await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      const { code, stdout } = await runBroker(["cancel", "job-001"], { cwd, env });
      assert.equal(code, 0);
      assert.match(stdout, /job-001: cancelled/);
      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs[0].status, "cancelled");
      assert.ok(state.jobs[0].completed_at);
    }),
  );
});

test("/pi:cancel reconciles when pi finished while we weren't watching", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      // fake-pi finishes immediately, but state.json still says "running"
      // until the next broker call reconciles.
      await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      const { code, stdout } = await runBroker(["cancel", "job-001"], { cwd, env });
      assert.equal(code, 0);
      assert.match(stdout, /pi finished before cancel/);
      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs[0].status, "completed");
    }),
  );
});

test("/pi:cancel on already-completed job is a no-op", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      await runBroker(["run", "worker", "task", "--wait"], { cwd, env });
      const { code, stdout } = await runBroker(["cancel", "job-001"], { cwd, env });
      assert.equal(code, 0);
      assert.match(stdout, /already completed/);
      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs[0].status, "completed");
    }),
  );
});

test("/pi:cancel by pi-run-id prefix", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp, FAKE_PI_RUN_ID: "cafef00d99" });
      await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      const { code } = await runBroker(["cancel", "cafef0"], { cwd, env });
      assert.equal(code, 0);
    }),
  );
});

test("/pi:cancel on missing job errors", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stderr } = await runBroker(["cancel", "no-such-job"], { cwd });
    assert.notEqual(code, 0);
    assert.match(stderr, /no job found/);
  });
});

test("/pi:result without an id errors", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stderr } = await runBroker(["result"], { cwd });
    assert.notEqual(code, 0);
    assert.match(stderr, /expects a job id/);
  });
});

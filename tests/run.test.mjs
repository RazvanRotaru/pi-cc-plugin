import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

test("/pi:run worker 'task' --bg records a job and returns the run id", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_RUN_ID: "abc1234567890def",
      });
      const { code, stdout, stderr } = await runBroker(
        ["run", "worker", "fix the auth bug", "--bg"],
        { cwd, env },
      );
      assert.equal(code, 0, `stderr: ${stderr}`);
      assert.match(stdout, /Started job-001/);
      assert.match(stdout, /pi-run-id abc1234567890def/);

      const stateRaw = await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8");
      const state = JSON.parse(stateRaw);
      assert.equal(state.jobs.length, 1);
      assert.equal(state.jobs[0].internal_id, "job-001");
      assert.equal(state.jobs[0].id, "abc1234567890def");
      assert.equal(state.jobs[0].kind, "single");
      assert.deepEqual(state.jobs[0].agents, ["worker"]);
      assert.equal(state.jobs[0].task, "fix the auth bug");
      assert.match(state.jobs[0].pi_status_dir ?? "", new RegExp(piTmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }),
  );
});

test("/pi:run gitignores .pi-cc-plugin/ on first use in a git repo", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      await mkdir(join(cwd, ".git"));
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code } = await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      assert.equal(code, 0);
      const gi = await readFile(join(cwd, ".gitignore"), "utf8");
      assert.match(gi, /\.pi-cc-plugin\//);
    }),
  );
});

test("/pi:status with no args shows the alive line for an empty workspace", async () => {
  await withTempCwd(async (cwd) => {
    const { code, stdout } = await runBroker(["status"], { cwd });
    assert.equal(code, 0);
    assert.match(stdout, /alive/);
  });
});

test("/pi:status after one /pi:run shows the job", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp, FAKE_PI_RUN_ID: "deadbeef00" });
      await runBroker(["run", "worker", "do thing", "--bg"], { cwd, env });
      const { code, stdout } = await runBroker(["status"], { cwd });
      assert.equal(code, 0);
      assert.match(stdout, /job-001/);
      assert.match(stdout, /worker/);
      assert.match(stdout, /do thing/);
      // pi's status.json says "completed" (fake-pi finishes immediately).
      assert.match(stdout, /completed/);
    }),
  );
});

test("/pi:status <id> inspects one job by internal id", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      await runBroker(["run", "worker", "task A", "--bg"], { cwd, env });
      await runBroker(["run", "worker", "task B", "--bg"], { cwd, env });
      const { stdout } = await runBroker(["status", "job-002"], { cwd });
      assert.match(stdout, /job-002/);
      assert.match(stdout, /task B/);
    }),
  );
});

test("concurrent /pi:run calls produce unique internal_ids", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const N = 5;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          runBroker(["run", "worker", `task-${i}`, "--bg"], { cwd, env }),
        ),
      );
      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs.length, N);
      const ids = new Set(state.jobs.map((j) => j.internal_id));
      assert.equal(ids.size, N, "internal_ids must be unique");
    }),
  );
});

test("/pi:run --wait streams pi output and records completion", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        ["run", "worker", "do thing", "--wait"],
        { cwd, env },
      );
      assert.equal(code, 0);
      assert.match(stdout, /Finished job-001/);
      const state = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(state.jobs[0].status, "completed");
    }),
  );
});

test("missing run-id marker → broker errors", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp, FAKE_PI_NO_MARKERS: "1" });
      const { code, stderr } = await runBroker(
        ["run", "worker", "do thing", "--bg"],
        { cwd, env },
      );
      assert.notEqual(code, 0);
      assert.match(stderr, /markers|run-id/);
    }),
  );
});

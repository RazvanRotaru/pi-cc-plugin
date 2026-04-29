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

test("/pi:agent worker 'task' --bg records a job and returns the run id", async () => {
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

test("/pi:agent gitignores .pi-cc-plugin/ on first use in a git repo", async () => {
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

test("/pi:status after one /pi:agent shows the job", async () => {
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
      // events.jsonl from pi-subagents is forwarded raw under `events:`.
      assert.match(stdout, /events:/);
      assert.match(stdout, /"type":"subagent\.run\.started"/);
      assert.match(stdout, /"type":"subagent\.run\.completed"/);
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

test("concurrent /pi:agent calls produce unique internal_ids", async () => {
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

test("/pi:agent (default) waits for pi to complete and prints the final output", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        ["run", "worker", "do thing"],
        { cwd, env },
      );
      assert.equal(code, 0);
      assert.match(stdout, /Running job-001/);
      assert.match(stdout, /Finished job-001 — completed/);
      assert.match(stdout, /--- output ---/);
      assert.match(stdout, /Lorem ipsum/);
      const state = JSON.parse(
        await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"),
      );
      assert.equal(state.jobs[0].status, "completed");
      assert.ok(state.jobs[0].completed_at);
    }),
  );
});

test("/pi:agent --wait is the same as the default", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        ["run", "worker", "do thing", "--wait"],
        { cwd, env },
      );
      assert.equal(code, 0);
      assert.match(stdout, /Finished job-001 — completed/);
    }),
  );
});

test("/pi:agent polls until pi reaches a terminal state (delayed completion)", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      // pi takes ~250ms to mark the run complete. The polling loop
      // should hold the broker until then and then print the result.
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_DELAY_MS: "250",
        PI_BROKER_POLL_INTERVAL_MS: "50",
      });
      const t0 = Date.now();
      const { code, stdout } = await runBroker(
        ["run", "worker", "do thing"],
        { cwd, env },
      );
      const elapsed = Date.now() - t0;
      assert.equal(code, 0);
      assert.ok(elapsed >= 200, `expected >=200ms wait, got ${elapsed}ms`);
      assert.match(stdout, /Finished job-001 — completed/);
      assert.match(stdout, /Lorem ipsum/);
    }),
  );
});

test("/pi:agent --verbose emits step transitions while polling", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_DELAY_MS: "200",
        PI_BROKER_POLL_INTERVAL_MS: "40",
      });
      const { code, stdout } = await runBroker(
        ["run", "worker", "do thing", "--verbose"],
        { cwd, env },
      );
      assert.equal(code, 0);
      // Saw at least one step-transition line ("· worker: running" then
      // "· worker: complete" — both from the same agent token).
      assert.match(stdout, /· worker.*running/);
      assert.match(stdout, /· worker.*complete/);
    }),
  );
});

test("/pi:agent with a failing pi run records 'failed' and exits non-zero", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_SCENARIO: "fail",
      });
      const { code, stdout } = await runBroker(
        ["run", "worker", "do thing"],
        { cwd, env },
      );
      assert.notEqual(code, 0);
      assert.match(stdout, /Finished job-001 — failed/);
      const state = JSON.parse(
        await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"),
      );
      assert.equal(state.jobs[0].status, "failed");
    }),
  );
});

test("missing subagent-slash-result → broker errors", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp, FAKE_PI_NO_MARKERS: "1" });
      const { code, stderr } = await runBroker(
        ["run", "worker", "do thing", "--bg"],
        { cwd, env },
      );
      assert.notEqual(code, 0);
      assert.match(stderr, /subagent-slash-result|timed out/);
    }),
  );
});

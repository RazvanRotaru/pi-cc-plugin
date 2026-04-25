import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakePiEnv, runBroker, withTempCwd } from "./helpers.mjs";
import { stateFilePath } from "../plugins/pi/scripts/lib/state.mjs";
import { reconcileJob } from "../plugins/pi/scripts/lib/reconcile.mjs";
import { addJob } from "../plugins/pi/scripts/lib/tracked-jobs.mjs";

async function withFakePiTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cc-plugin-rec-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reconcileJob: leaves running job as-is when pi is also running", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    const piDir = await mkdtemp(join(tmpdir(), "rec-pi-"));
    try {
      await writeFile(
        join(piDir, "status.json"),
        JSON.stringify({ runId: "x", state: "running" }),
      );
      const job = await addJob(sf, {
        id: "x",
        status: "running",
        started_at: "2026-04-25T00:00:00Z",
        pi_status_dir: piDir,
      });
      const out = await reconcileJob(sf, job);
      assert.equal(out.status, "running");
      assert.equal(out.completed_at ?? null, null);
    } finally {
      await rm(piDir, { recursive: true, force: true });
    }
  });
});

test("reconcileJob: flips broker status from running -> completed when pi finished", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    const piDir = await mkdtemp(join(tmpdir(), "rec-pi-"));
    try {
      const endedAt = Date.UTC(2026, 3, 25, 12, 0, 0);
      await writeFile(
        join(piDir, "status.json"),
        JSON.stringify({ runId: "x", state: "complete", endedAt }),
      );
      const job = await addJob(sf, {
        id: "x",
        status: "running",
        started_at: "2026-04-25T00:00:00Z",
        pi_status_dir: piDir,
      });
      const out = await reconcileJob(sf, job);
      assert.equal(out.status, "completed");
      assert.equal(out.completed_at, new Date(endedAt).toISOString());
    } finally {
      await rm(piDir, { recursive: true, force: true });
    }
  });
});

test("reconcileJob: terminal broker status wins over pi running (cancel case)", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    const piDir = await mkdtemp(join(tmpdir(), "rec-pi-"));
    try {
      await writeFile(
        join(piDir, "status.json"),
        JSON.stringify({ runId: "x", state: "running" }),
      );
      const job = await addJob(sf, {
        id: "x",
        status: "cancelled",
        started_at: "2026-04-25T00:00:00Z",
        completed_at: "2026-04-25T00:00:05Z",
        pi_status_dir: piDir,
      });
      const out = await reconcileJob(sf, job);
      assert.equal(out.status, "cancelled");
    } finally {
      await rm(piDir, { recursive: true, force: true });
    }
  });
});

test("/pi:status auto-reconciles: running job in state.json finds pi state.json complete", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      // Dispatch — broker writes state.json with status: running.
      await runBroker(["run", "worker", "do thing", "--bg"], { cwd, env });
      // Confirm pre-reconcile: state.json says running.
      const before = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(before.jobs[0].status, "running");
      // /pi:status should reconcile (fake-pi finishes immediately).
      await runBroker(["status"], { cwd });
      const after = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(after.jobs[0].status, "completed");
      assert.ok(after.jobs[0].completed_at);
    }),
  );
});

test("/pi:result auto-reconciles", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      await runBroker(["run", "worker", "do thing", "--bg"], { cwd, env });
      const before = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(before.jobs[0].status, "running");
      await runBroker(["result", "job-001"], { cwd });
      const after = JSON.parse(await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"));
      assert.equal(after.jobs[0].status, "completed");
    }),
  );
});

// Integration test — drives the broker through every command + every
// failure mode the fake-pi fixture supports. No LLM in the loop; we just
// exercise the same surface a Claude Code session would.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakePiEnv, runBroker, withTempCwd } from "./helpers.mjs";

async function withFakePiTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cc-plugin-int-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("happy path: setup → run → status → result → cancel", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      // Provide a fake extensions dir with pi-subagents present so setup passes.
      const extDir = await mkdtemp(join(tmpdir(), "pi-cc-plugin-ext-"));
      await (await import("node:fs/promises")).writeFile(
        join(extDir, "pi-subagents.ts"),
        "// fixture\n",
      );
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        PI_BROKER_FAKE_EXTENSIONS_DIR: extDir,
      });

      // 1. setup
      await mkdir(join(cwd, ".git"));
      const setup = await runBroker(["setup", "--yes"], { cwd, env });
      assert.equal(setup.code, 0, `setup stderr: ${setup.stderr}`);

      // 2. run
      const run = await runBroker(["run", "worker", "fix the bug", "--bg"], {
        cwd,
        env,
      });
      assert.equal(run.code, 0);
      assert.match(run.stdout, /Started job-001/);

      // 3. status (list)
      const list = await runBroker(["status"], { cwd });
      assert.equal(list.code, 0);
      assert.match(list.stdout, /job-001/);

      // 4. status (single)
      const one = await runBroker(["status", "job-001"], { cwd });
      assert.match(one.stdout, /worker/);

      // 5. result
      const res = await runBroker(["result", "job-001"], { cwd });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /Lorem ipsum/);

      // 6. cancel — already completed (fake-pi finishes immediately)
      const cancel = await runBroker(["cancel", "job-001"], { cwd, env });
      assert.equal(cancel.code, 0);
      assert.match(cancel.stdout, /already completed/);
    }),
  );
});

test("/pi:agent --worktree dispatches via tool form (no slash)", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        ["run", "test-writer", "module A", "--worktree", "--bg"],
        { cwd, env },
      );
      assert.equal(code, 0);
      assert.match(stdout, /worktree/);
      const state = JSON.parse(
        await readFile(join(cwd, ".pi-cc-plugin/state.json"), "utf8"),
      );
      assert.equal(state.jobs[0].worktree, true);
    }),
  );
});

test("failure mode: pi crashes before markers", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_SCENARIO: "crash",
      });
      const r = await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      assert.notEqual(r.code, 0);
      // No state record should be written for a crash before markers.
      const stateRaw = await readFile(
        join(cwd, ".pi-cc-plugin/state.json"),
        "utf8",
      ).catch(() => null);
      if (stateRaw) {
        const state = JSON.parse(stateRaw);
        assert.equal(state.jobs.length, 0);
      }
    }),
  );
});

test("failure mode: pi run dir was purged (stale-dir scenario)", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_SCENARIO: "stale-dir",
      });
      const r = await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      assert.equal(r.code, 0); // run itself succeeded — we got markers
      const status = await runBroker(["status", "job-001"], { cwd });
      assert.match(status.stdout, /pi status dir not readable/);
    }),
  );
});

test("failure mode: pi wrote malformed status.json", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_SCENARIO: "bad-json",
      });
      const r = await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      assert.equal(r.code, 0); // markers emitted; status.json is just unreadable
      const status = await runBroker(["status", "job-001"], { cwd });
      // Renderer falls back gracefully — our state.json says "running" or
      // "completed" depending on timing; pi status dir is unreadable so we
      // surface that.
      assert.match(status.stdout, /job-001/);
    }),
  );
});

test("failure mode: pi exits before subagent-slash-result", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({
        FAKE_PI_TMPDIR: piTmp,
        FAKE_PI_NO_MARKERS: "1",
      });
      const r = await runBroker(["run", "worker", "task", "--bg"], { cwd, env });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /subagent-slash-result|timed out/);
    }),
  );
});

test("multiple sequential runs accumulate cleanly", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      for (let i = 0; i < 4; i++) {
        const r = await runBroker(["run", "worker", `task-${i}`, "--bg"], {
          cwd,
          env,
        });
        assert.equal(r.code, 0);
      }
      const list = await runBroker(["status"], { cwd });
      assert.match(list.stdout, /4 jobs/);
    }),
  );
});

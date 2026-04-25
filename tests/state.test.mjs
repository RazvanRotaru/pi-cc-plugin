import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempCwd } from "./helpers.mjs";
import {
  DEFAULT_STATE,
  readState,
  stateFilePath,
  updateState,
  writeState,
} from "../plugins/pi/scripts/lib/state.mjs";
import {
  addJob,
  findJob,
  listJobs,
  updateJob,
} from "../plugins/pi/scripts/lib/tracked-jobs.mjs";

test("readState: missing file returns DEFAULT_STATE", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    const s = await readState(sf);
    assert.deepEqual(s, DEFAULT_STATE);
  });
});

test("readState: malformed JSON throws with file path", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await mkdir(join(cwd, ".pi-cc-plugin"), { recursive: true });
    await writeFile(sf, "{not-json", "utf8");
    await assert.rejects(readState(sf), /malformed/);
  });
});

test("writeState then readState round-trips", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    const next = { version: 1, jobs: [{ internal_id: "job-001", id: "abc", status: "running" }] };
    await writeState(sf, next);
    const back = await readState(sf);
    assert.deepEqual(back, next);
  });
});

test("addJob assigns internal_id job-001, job-002, …", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    const a = await addJob(sf, { id: "x1", status: "running", started_at: "2026-04-24T00:00:00Z" });
    const b = await addJob(sf, { id: "x2", status: "running", started_at: "2026-04-24T00:01:00Z" });
    assert.equal(a.internal_id, "job-001");
    assert.equal(b.internal_id, "job-002");
  });
});

test("findJob: matches by internal_id, full pi id, and unambiguous prefix", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await addJob(sf, { id: "abcdef0123", status: "running", started_at: "2026-04-24T00:00:00Z" });
    await addJob(sf, { id: "999fff", status: "running", started_at: "2026-04-24T00:01:00Z" });
    assert.equal((await findJob(sf, "job-001")).id, "abcdef0123");
    assert.equal((await findJob(sf, "abcdef0123")).id, "abcdef0123");
    assert.equal((await findJob(sf, "abc")).id, "abcdef0123"); // prefix
    assert.equal((await findJob(sf, "999")).id, "999fff");
  });
});

test("findJob: ambiguous prefix throws", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await addJob(sf, { id: "abcd1", status: "running", started_at: "2026-04-24T00:00:00Z" });
    await addJob(sf, { id: "abcd2", status: "running", started_at: "2026-04-24T00:01:00Z" });
    await assert.rejects(findJob(sf, "abcd"), /ambiguous/);
  });
});

test("findJob: missing id throws", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await assert.rejects(findJob(sf, "nope"), /no job found/);
  });
});

test("updateJob patches a record", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await addJob(sf, { id: "x", status: "running", started_at: "2026-04-24T00:00:00Z" });
    const j = await updateJob(sf, "job-001", { status: "completed", completed_at: "2026-04-24T00:00:05Z" });
    assert.equal(j.status, "completed");
    assert.equal(j.completed_at, "2026-04-24T00:00:05Z");
  });
});

test("listJobs returns newest first", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await addJob(sf, { id: "old", status: "running", started_at: "2026-04-24T00:00:00Z" });
    await addJob(sf, { id: "new", status: "running", started_at: "2026-04-24T01:00:00Z" });
    const list = await listJobs(sf);
    assert.equal(list[0].id, "new");
    assert.equal(list[1].id, "old");
  });
});

test("concurrent updateState calls don't lose writes", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        addJob(sf, {
          id: `concurrent-${i}`,
          status: "running",
          started_at: new Date(Date.now() + i).toISOString(),
        }),
      ),
    );
    const list = await listJobs(sf);
    assert.equal(list.length, 10);
    const internals = list.map((j) => j.internal_id).sort();
    assert.deepEqual(
      internals,
      Array.from({ length: 10 }, (_, i) => `job-${String(i + 1).padStart(3, "0")}`),
    );
  });
});

test("updateState mutator can return a new object", async () => {
  await withTempCwd(async (cwd) => {
    const sf = stateFilePath(cwd);
    await updateState(sf, () => ({ version: 1, jobs: [{ internal_id: "job-007", id: "zzz" }] }));
    const s = await readState(sf);
    assert.equal(s.jobs[0].internal_id, "job-007");
  });
});

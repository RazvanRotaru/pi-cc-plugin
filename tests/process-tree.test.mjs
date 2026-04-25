import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { findRunWorkers, alive, killAll } from "../plugins/pi/scripts/lib/process-tree.mjs";

/** Spawn a node process whose argv contains a known marker; return its pid. */
function spawnMarked(marker) {
  // Use `--` so node stops parsing flags before our marker, otherwise
  // node would reject e.g. `--pi-cc-plugin-marker=…` as an unknown flag.
  const child = spawn(
    process.execPath,
    ["-e", `setInterval(()=>{}, 60000);`, "--", `pi-cc-marker-${marker}`],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  child.unref();
  return child.pid;
}

test("findRunWorkers locates a process by marker on its command line", async () => {
  const marker = `pi-cc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pid = spawnMarked(marker);
  // Give the OS a beat to register the process in ps.
  await new Promise((r) => setTimeout(r, 100));
  try {
    const found = findRunWorkers(marker);
    assert.ok(found.includes(pid), `expected to find ${pid} in ${found}`);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test("findRunWorkers excludes self process even if marker is on its command", () => {
  // The test runner's argv won't contain a wild marker, but we verify
  // selfPid filtering by passing an obviously-self pid.
  const marker = `pi-cc-test-${Date.now()}`;
  const pid = spawnMarked(marker);
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }, 200);
  // selfPid override = the spawned pid; should be excluded.
  const found = findRunWorkers(marker, { selfPid: pid });
  assert.ok(!found.includes(pid));
});

test("findRunWorkers returns [] for a marker no process carries", () => {
  const found = findRunWorkers(`absolutely-no-process-has-this-${Math.random()}`);
  assert.deepEqual(found, []);
});

test("findRunWorkers returns [] when runId is empty/null", () => {
  assert.deepEqual(findRunWorkers(""), []);
  assert.deepEqual(findRunWorkers(null), []);
});

test("killAll: SIGTERM-able processes are killed", async () => {
  const marker = `pi-cc-killall-${Date.now()}`;
  const pid = spawnMarked(marker);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), true);
  await killAll([pid], { graceMs: 200 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false);
});

test("killAll on already-dead pids is a no-op (no throw)", async () => {
  const r = await killAll([999999999], { graceMs: 50 });
  // killed should be empty since the pid is dead — process.kill throws inside try.
  assert.deepEqual(r.killed, []);
});

test("killAll([]) is a fast no-op", async () => {
  const r = await killAll([], { graceMs: 99999 });
  assert.deepEqual(r.killed, []);
  assert.deepEqual(r.escalated, []);
});

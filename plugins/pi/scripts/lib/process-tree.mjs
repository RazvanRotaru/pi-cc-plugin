// process-tree.mjs — find and kill the worker subagents pi-subagents
// detaches when /pi:agent dispatches in --bg mode.
//
// The problem: when /pi:cancel SIGTERMs the parent pid recorded in
// pi-subagents' status.json, that parent is the orchestrator/controller
// process. The actual worker(s) — `pi-subagents/subagent-runner.ts ...
// /tmp/pi-subagents-uid-<uid>/async-cfg-<runId>.json` — are detached
// children that survive their parent's death and become orphans (re-
// parented to init).
//
// Mitigation: scan `ps` for processes whose command line contains the
// runId we're cancelling, send them SIGTERM (then SIGKILL after grace).
// Cross-platform: relies on `ps -eo pid,command` which works on linux
// + macOS. Windows: not supported (the broker doesn't target Windows
// for live runs anyway).

import { execSync } from "node:child_process";

/**
 * Return PIDs of any process whose command line mentions `runId`.
 * Excludes self.
 */
export function findRunWorkers(runId, { selfPid = process.pid } = {}) {
  if (!runId) return [];
  let lines;
  try {
    lines = execSync("ps -eo pid,command", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n");
  } catch {
    return [];
  }
  const pids = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === selfPid) continue;
    if (cmd.includes(runId)) pids.push(pid);
  }
  return pids;
}

/**
 * SIGTERM each pid, wait `graceMs`, escalate to SIGKILL on survivors.
 */
export async function killAll(pids, { graceMs = 5000 } = {}) {
  if (pids.length === 0) return { killed: [], escalated: [] };
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // already dead — skip
    }
  }
  await sleep(graceMs);
  const escalated = [];
  for (const pid of killed) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
        escalated.push(pid);
      } catch {
        // race
      }
    }
  }
  return { killed, escalated };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

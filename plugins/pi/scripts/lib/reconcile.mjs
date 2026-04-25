// reconcile.mjs — sync state.json against pi-subagents' fresher status.json.
//
// Background runs are detached: pi-subagents writes status.json, but our
// state.json is only written on explicit broker calls. Without
// reconciliation, a job that pi has long since finished still shows up in
// state.json as "running", which is misleading. Every command that reads
// jobs (status, result, cancel) calls reconcile before rendering so the
// user always sees pi's latest view AND state.json catches up.
//
// Rule:
//   - If pi has progressed to a terminal state (complete | failed | cancelled)
//     and our state.json still says "running", update state.json.
//   - Always back-fill completed_at from pi's endedAt when missing.
//   - Never override a broker-side terminal state (e.g. "cancelled" wins
//     over pi's stale "running"; see render.mjs reconciliation rule).

import { readPiStatus, mapPiState } from "./pi-status-reader.mjs";
import { listJobs, updateJob } from "./tracked-jobs.mjs";

const TERMINAL_BROKER = new Set(["completed", "cancelled", "failed"]);

/**
 * Sync one job's state.json record against pi's status.json. Returns the
 * (possibly updated) job. No-op if pi's status dir is unreadable.
 */
export async function reconcileJob(stateFile, job) {
  // Broker already in terminal state — its decision wins.
  if (TERMINAL_BROKER.has(job.status)) return job;
  const piStatus = await readPiStatus(job.pi_status_dir);
  if (!piStatus) return job;
  const piState = mapPiState(piStatus.state);
  const patch = {};
  if (TERMINAL_BROKER.has(piState) && piState !== job.status) {
    patch.status = piState;
  }
  if (!job.completed_at && piStatus.endedAt) {
    patch.completed_at = new Date(piStatus.endedAt).toISOString();
  }
  if (Object.keys(patch).length === 0) return job;
  return updateJob(stateFile, job.internal_id, patch);
}

/**
 * Reconcile every job in state.json. Returns the post-sync list,
 * newest-first (matching listJobs).
 */
export async function reconcileAllJobs(stateFile) {
  const jobs = await listJobs(stateFile);
  const reconciled = [];
  for (const job of jobs) {
    reconciled.push(await reconcileJob(stateFile, job));
  }
  return reconciled;
}

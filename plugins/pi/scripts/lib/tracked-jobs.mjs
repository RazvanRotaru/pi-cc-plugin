// tracked-jobs.mjs — CRUD on the jobs[] array inside state.json.
//
// Internal IDs:
//   "job-001", "job-002", … — assigned monotonically. We never reuse.
//   pi run id is the canonical id; internal id is for human convenience.

import { readState, updateState } from "./state.mjs";

/**
 * Append a new job. Returns the saved record (with its assigned internal_id).
 *
 * @param {string} stateFile
 * @param {Omit<Job, "internal_id">} job
 * @returns {Promise<Job>}
 */
export async function addJob(stateFile, job) {
  let saved;
  await updateState(stateFile, (state) => {
    const internal_id = nextInternalId(state.jobs);
    saved = { internal_id, ...job };
    state.jobs.push(saved);
    return state;
  });
  return saved;
}

/**
 * Patch an existing job by id (internal_id, pi_run_id, or unambiguous prefix).
 * Throws if no match or ambiguous.
 */
export async function updateJob(stateFile, idOrPrefix, patch) {
  let updated;
  await updateState(stateFile, (state) => {
    const idx = findJobIndex(state.jobs, idOrPrefix);
    state.jobs[idx] = { ...state.jobs[idx], ...patch };
    updated = state.jobs[idx];
    return state;
  });
  return updated;
}

/**
 * List all jobs. Newest first.
 */
export async function listJobs(stateFile) {
  const state = await readState(stateFile);
  return [...state.jobs].sort(
    (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
  );
}

/**
 * Find a single job. Accepts internal_id, pi_run_id, or any unambiguous
 * prefix of pi_run_id.
 *
 * @returns {Promise<Job>}
 */
export async function findJob(stateFile, idOrPrefix) {
  const state = await readState(stateFile);
  const idx = findJobIndex(state.jobs, idOrPrefix);
  return state.jobs[idx];
}

function findJobIndex(jobs, idOrPrefix) {
  if (!idOrPrefix) throw new Error("job id is required");
  const exactInternal = jobs.findIndex((j) => j.internal_id === idOrPrefix);
  if (exactInternal !== -1) return exactInternal;
  const exactPi = jobs.findIndex((j) => j.id === idOrPrefix);
  if (exactPi !== -1) return exactPi;
  const prefixHits = jobs
    .map((j, i) => ({ j, i }))
    .filter(({ j }) => j.id?.startsWith(idOrPrefix));
  if (prefixHits.length === 1) return prefixHits[0].i;
  if (prefixHits.length > 1) {
    throw new Error(
      `ambiguous job id "${idOrPrefix}" matches: ${prefixHits.map((h) => h.j.id).join(", ")}`,
    );
  }
  throw new Error(`no job found matching "${idOrPrefix}"`);
}

function nextInternalId(jobs) {
  const max = jobs.reduce((acc, j) => {
    const m = /^job-(\d+)$/.exec(j.internal_id ?? "");
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `job-${String(max + 1).padStart(3, "0")}`;
}

// Exposed for tests.
export const _internals = { findJobIndex, nextInternalId };

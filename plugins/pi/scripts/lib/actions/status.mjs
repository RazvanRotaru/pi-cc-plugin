// /pi:status — list active runs, or inspect one by id/prefix.

import { parseArgs } from "../args.mjs";
import { findJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { readPiEvents, readPiStatus } from "../pi-status-reader.mjs";
import { reconcileAllJobs, reconcileJob } from "../reconcile.mjs";
import { renderJob, renderJobList } from "../render.mjs";

async function loadJobEvents(statusDir) {
  const batch = await readPiEvents(statusDir);
  return batch?.events ?? null;
}

export default async function status(argv, ctx) {
  const { payload } = parseArgs("status", argv);
  const stateFile = stateFilePath(ctx.cwd);

  if (payload.id) {
    const job = await reconcileJob(stateFile, await findJob(stateFile, payload.id));
    const [piStatus, events] = await Promise.all([
      readPiStatus(job.pi_status_dir),
      loadJobEvents(job.pi_status_dir),
    ]);
    ctx.stdout.write(`${renderJob(job, piStatus, events)}\n`);
    return 0;
  }

  const jobs = await reconcileAllJobs(stateFile);
  if (jobs.length === 0) {
    ctx.stdout.write("pi-cc-plugin alive — no jobs tracked yet. Try /pi:agent.\n");
    return 0;
  }
  const [piStatuses, eventsList] = await Promise.all([
    Promise.all(jobs.map((j) => readPiStatus(j.pi_status_dir))),
    Promise.all(jobs.map((j) => loadJobEvents(j.pi_status_dir))),
  ]);
  ctx.stdout.write(`${renderJobList(jobs, piStatuses, eventsList)}\n`);
  return 0;
}

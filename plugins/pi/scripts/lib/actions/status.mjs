// /pi:status — list active runs, or inspect one by id/prefix.

import { parseArgs } from "../args.mjs";
import { findJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { readPiStatus } from "../pi-status-reader.mjs";
import { reconcileAllJobs, reconcileJob } from "../reconcile.mjs";
import { renderJob, renderJobList } from "../render.mjs";

export default async function status(argv, ctx) {
  const { payload } = parseArgs("status", argv);
  const stateFile = stateFilePath(ctx.cwd);

  if (payload.id) {
    const job = await reconcileJob(stateFile, await findJob(stateFile, payload.id));
    const piStatus = await readPiStatus(job.pi_status_dir);
    ctx.stdout.write(`${renderJob(job, piStatus)}\n`);
    return 0;
  }

  const jobs = await reconcileAllJobs(stateFile);
  if (jobs.length === 0) {
    ctx.stdout.write("pi-cc-plugin alive — no jobs tracked yet. Try /pi:agent.\n");
    return 0;
  }
  const piStatuses = await Promise.all(jobs.map((j) => readPiStatus(j.pi_status_dir)));
  ctx.stdout.write(`${renderJobList(jobs, piStatuses)}\n`);
  return 0;
}

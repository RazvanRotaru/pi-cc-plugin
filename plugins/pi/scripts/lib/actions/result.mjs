// /pi:result — show the final markdown output of a completed pi run.

import { parseArgs } from "../args.mjs";
import { findJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { mapPiState, readPiResult, readPiStatus, readPiLog } from "../pi-status-reader.mjs";

export default async function result(argv, ctx) {
  const { payload } = parseArgs("result", argv);
  const stateFile = stateFilePath(ctx.cwd);
  const job = await findJob(stateFile, payload.id);

  const piStatus = await readPiStatus(job.pi_status_dir);
  const md = await readPiResult(job.pi_status_dir);

  const renderedState = piStatus ? mapPiState(piStatus.state) : job.status;
  ctx.stdout.write(`# ${job.internal_id} (pi-run-id ${job.id})\n\n`);
  ctx.stdout.write(`status: ${renderedState}\n`);
  if (piStatus?.error) ctx.stdout.write(`error: ${piStatus.error}\n`);
  // Per-step errors live under steps[].error; surface the first one.
  const stepErr = piStatus?.steps?.find((s) => s.error)?.error;
  if (stepErr && stepErr !== piStatus?.error) {
    ctx.stdout.write(`step-error: ${stepErr}\n`);
  }
  ctx.stdout.write("\n");

  if (md) {
    ctx.stdout.write("## Result\n\n");
    ctx.stdout.write(md.endsWith("\n") ? md : `${md}\n`);
    return 0;
  }

  // No output yet. If the run is still going, surface the log instead.
  const log = await readPiLog(job.pi_status_dir);
  if (log) {
    ctx.stdout.write("## Log (no final output yet)\n\n");
    ctx.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
    return 0;
  }

  ctx.stdout.write(
    "(no output-N.log or subagent-log-*.md found — pi may not have completed, or its run dir was cleaned up)\n",
  );
  return 0;
}

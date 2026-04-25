// /pi:cancel — abort a running pi-subagents job.
//
// Strategy (cleanest first):
//   1. Reconcile: read status.json. If state ∈ {complete, failed, cancelled},
//      sync our state and exit — nothing to cancel.
//   2. SIGTERM the pid recorded in status.json.pid (the running pi-subagent
//      process). Wait up to PI_BROKER_SIGTERM_GRACE_MS (default 5s).
//   3. Escalate to SIGKILL if still alive.
//
// The fall-back to `pi cancel` via RPC is unnecessary for pi-subagents:
// the async-run process IS the work — killing it terminates everything.
// pi-subagents' status watcher writes a final status.json marked cancelled
// when it sees the pid go away, so there's nothing extra to coordinate.

import { parseArgs } from "../args.mjs";
import { findJob, updateJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { mapPiState, readPiStatus } from "../pi-status-reader.mjs";
import { alive, findRunWorkers, killAll } from "../process-tree.mjs";

const DEFAULT_SIGTERM_GRACE_MS = 5000;
const TERMINAL_BROKER = new Set(["completed", "cancelled", "failed"]);
// Race window: pi-subagents' status.json may not exist yet immediately
// after dispatch. Poll briefly so we don't miss the worker pids.
const STATUS_POLL_MS = 200;
const STATUS_POLL_ATTEMPTS = 10; // 2 seconds total

export default async function cancel(argv, ctx) {
  const sigtermGraceMs = Number(
    ctx.env.PI_BROKER_SIGTERM_GRACE_MS ?? DEFAULT_SIGTERM_GRACE_MS,
  );
  const { payload } = parseArgs("cancel", argv);
  const stateFile = stateFilePath(ctx.cwd);
  const job = await findJob(stateFile, payload.id);

  if (TERMINAL_BROKER.has(job.status)) {
    ctx.stdout.write(
      `${job.internal_id}: already ${job.status} — nothing to cancel.\n`,
    );
    return 0;
  }

  // Race window: status.json may not exist yet right after dispatch.
  // Poll briefly so we can pick up pi-subagents' canonical pid.
  let piStatus = null;
  for (let i = 0; i < STATUS_POLL_ATTEMPTS; i++) {
    piStatus = await readPiStatus(job.pi_status_dir);
    if (piStatus) break;
    await sleep(STATUS_POLL_MS);
  }
  const reconciled = piStatus ? mapPiState(piStatus.state) : null;
  if (reconciled && TERMINAL_BROKER.has(reconciled)) {
    await updateJob(stateFile, job.internal_id, {
      status: reconciled,
      completed_at: piStatus.endedAt
        ? new Date(piStatus.endedAt).toISOString()
        : new Date().toISOString(),
    });
    ctx.stdout.write(
      `${job.internal_id}: already ${reconciled} (pi finished before cancel) — nothing to do.\n`,
    );
    return 0;
  }

  // Kill targets: pi-subagents' parent process AND the detached
  // worker(s) that survive its death (they're orphans by design — see
  // process-tree.mjs). The recorded pid is the parent; workers are
  // discovered by scanning `ps` for the runId on the command line.
  const targets = new Set();
  const parentPid = piStatus?.pid ?? job.pid;
  if (parentPid && alive(parentPid)) targets.add(parentPid);
  for (const pid of findRunWorkers(job.id)) targets.add(pid);

  await killAll([...targets], { graceMs: sigtermGraceMs });

  await updateJob(stateFile, job.internal_id, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
  ctx.stdout.write(`${job.internal_id}: cancelled (pi-run-id ${job.id}).\n`);
  return 0;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// /pi:cancel — abort a running pi job.
//
// Strategy:
//   1. Try `pi exec '{"action":"cancel","id":"..."}'` so pi gets a chance to
//      write a final status.json. (TBD-VERIFY in docs/PI_INVOCATION.md §5.)
//   2. If that fails or the process is still alive after a short grace,
//      send SIGTERM to the recorded pid.
//   3. Escalate to SIGKILL after 5s.
//
// In every branch, we mark our local state.json `cancelled` so /pi:status
// reflects the user's intent regardless of what pi wrote.

import { parseArgs } from "../args.mjs";
import { findJob, updateJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { piExec } from "../pi-cli.mjs";
import { readPiStatus } from "../pi-status-reader.mjs";

const DEFAULT_SIGTERM_GRACE_MS = 5000;
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

export default async function cancel(argv, ctx) {
  const sigtermGraceMs = Number(ctx.env.PI_BROKER_SIGTERM_GRACE_MS ?? DEFAULT_SIGTERM_GRACE_MS);
  const { payload } = parseArgs("cancel", argv);
  const stateFile = stateFilePath(ctx.cwd);
  const job = await findJob(stateFile, payload.id);

  if (TERMINAL.has(job.status)) {
    ctx.stdout.write(`${job.internal_id}: already ${job.status} — nothing to cancel.\n`);
    return 0;
  }

  // Reconcile with pi's status.json first — pi may have already finished
  // even though our state.json still says "running" (we only update state
  // on explicit broker calls).
  const piStatus = await readPiStatus(job.pi_status_dir);
  if (piStatus && TERMINAL.has(piStatus.status)) {
    await updateJob(stateFile, job.internal_id, {
      status: piStatus.status,
      completed_at: piStatus.completed_at ?? new Date().toISOString(),
    });
    ctx.stdout.write(
      `${job.internal_id}: already ${piStatus.status} (pi finished before cancel) — nothing to do.\n`,
    );
    return 0;
  }

  // Try the polite path first.
  let cleanShutdown = false;
  try {
    await piExec({
      payload: { action: "cancel", id: job.id },
      background: false,
      cwd: ctx.cwd,
      env: ctx.env,
      stdout: { write: () => {} }, // suppress pi cancel chatter
      markerTimeoutMs: 1500,
    });
    cleanShutdown = true;
  } catch {
    // pi cancel API not available — fall through to signals.
  }

  if (!cleanShutdown && job.pid && processStillAlive(job.pid)) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // already dead
    }
    await sleep(sigtermGraceMs);
    if (processStillAlive(job.pid)) {
      try {
        process.kill(job.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }

  await updateJob(stateFile, job.internal_id, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
  ctx.stdout.write(`${job.internal_id}: cancelled (pi-run-id ${job.id}).\n`);
  return 0;
}

function processStillAlive(pid) {
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

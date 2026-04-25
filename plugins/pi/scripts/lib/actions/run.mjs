// /pi:run — delegate one task to one pi agent.

import { parseArgs } from "../args.mjs";
import { piExec } from "../pi-cli.mjs";
import { addJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { ensureGitignored } from "../gitignore.mjs";

export default async function run(argv, ctx) {
  const { payload, flags } = parseArgs("run", argv);

  const stateFile = stateFilePath(ctx.cwd);
  const gi = await ensureGitignored(ctx.cwd);
  if (gi.updated) {
    ctx.stderr.write(`pi-cc-plugin: ${gi.reason}\n`);
  }

  const startedAt = new Date().toISOString();

  const launch = await piExec({
    payload,
    background: payload.background,
    cwd: payload.cwd ?? ctx.cwd,
    env: ctx.env,
    stdout: ctx.stdout,
  });

  const job = await addJob(stateFile, {
    id: launch.runId,
    kind: "single",
    agents: [payload.agent],
    task: payload.task,
    status: payload.background ? "running" : exitCodeStatus(launch.exitCode),
    started_at: startedAt,
    completed_at: payload.background ? null : new Date().toISOString(),
    pi_status_dir: launch.statusDir,
    model: payload.model ?? null,
    pid: launch.pid ?? null,
    fork: !!payload.fork,
  });

  if (payload.background) {
    ctx.stdout.write(
      `Started ${job.internal_id} (pi-run-id ${job.id}) — agent=${payload.agent}, model=${payload.model ?? "default"}\n`,
    );
    ctx.stdout.write(`Use /pi:status ${job.internal_id} to inspect.\n`);
  } else {
    ctx.stdout.write(
      `\nFinished ${job.internal_id} — exit ${launch.exitCode ?? "unknown"} (pi-run-id ${job.id}).\n`,
    );
    ctx.stdout.write(`Use /pi:result ${job.internal_id} for the final output.\n`);
  }

  return launch.exitCode === null ? 0 : launch.exitCode === 0 ? 0 : 1;
}

function exitCodeStatus(code) {
  if (code === 0) return "completed";
  if (code === null) return "running";
  return "failed";
}

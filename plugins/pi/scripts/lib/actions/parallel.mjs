// /pi:parallel — run several pi agents in parallel.

import { parseArgs } from "../args.mjs";
import { piExec } from "../pi-cli.mjs";
import { addJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { ensureGitignored } from "../gitignore.mjs";

export default async function parallel(argv, ctx) {
  const { payload } = parseArgs("parallel", argv);
  const stateFile = stateFilePath(ctx.cwd);
  const gi = await ensureGitignored(ctx.cwd);
  if (gi.updated) ctx.stderr.write(`pi-cc-plugin: ${gi.reason}\n`);

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
    kind: "parallel",
    agents: payload.tasks.map((s) => s.agent),
    task: payload.tasks.map((s) => `${s.agent}["${s.task}"]`).join(" || "),
    status: payload.background ? "running" : exitCodeStatus(launch.exitCode),
    started_at: startedAt,
    completed_at: payload.background ? null : new Date().toISOString(),
    pi_status_dir: launch.statusDir,
    model: payload.model ?? null,
    pid: launch.pid ?? null,
    worktree: !!payload.worktree,
  });

  ctx.stdout.write(
    `${payload.background ? "Started" : "Finished"} ${job.internal_id} ` +
      `(parallel, ${payload.tasks.length} task${payload.tasks.length === 1 ? "" : "s"}` +
      `${payload.worktree ? ", worktree" : ""}, pi-run-id ${job.id}).\n`,
  );
  return launch.exitCode === null || launch.exitCode === 0 ? 0 : 1;
}

function exitCodeStatus(code) {
  if (code === 0) return "completed";
  if (code === null) return "running";
  return "failed";
}

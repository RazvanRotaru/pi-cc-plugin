// /pi:parallel — run several pi agents in parallel.

import { parseArgs } from "../args.mjs";
import { piExec } from "../pi-cli.mjs";
import { addJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { ensureGitignored } from "../gitignore.mjs";
import { prepareEphemeralAgents } from "../ephemeral-agents.mjs";
import { preflight } from "../preflight.mjs";

export default async function parallel(argv, ctx) {
  const { payload } = parseArgs("parallel", argv);
  await preflight({ env: ctx.env, cwd: ctx.cwd });
  const stateFile = stateFilePath(ctx.cwd);
  const gi = await ensureGitignored(ctx.cwd);
  if (gi.updated) ctx.stderr.write(`pi-cc-plugin: ${gi.reason}\n`);

  const uniqueAgents = [...new Set(payload.tasks.map((s) => s.agent))];
  const { nameMap, cleanup } = await prepareEphemeralAgents({
    cwd: ctx.cwd,
    agents: uniqueAgents,
    mcpTools: payload.mcp ?? [],
  });
  const dispatchPayload =
    nameMap.size === 0
      ? payload
      : {
          ...payload,
          tasks: payload.tasks.map((s) => ({
            ...s,
            agent: nameMap.get(s.agent) ?? s.agent,
          })),
        };

  const startedAt = new Date().toISOString();
  let launch;
  try {
    launch = await piExec({
      payload: dispatchPayload,
      background: dispatchPayload.background,
      cwd: dispatchPayload.cwd ?? ctx.cwd,
      env: ctx.env,
      stdout: ctx.stdout,
    });
  } finally {
    await cleanup();
  }

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

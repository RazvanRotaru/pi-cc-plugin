// /pi:chain — run a chain of pi agents.
//
// Hands the entire chain payload to pi as a single subagent call. Pi tracks
// per-step state internally; the broker records one job entry of kind="chain"
// and reads pi's status.json (which carries `steps[]`) for sub-progress.

import { parseArgs } from "../args.mjs";
import { piExec } from "../pi-cli.mjs";
import { addJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { ensureGitignored } from "../gitignore.mjs";
import { prepareEphemeralAgents } from "../ephemeral-agents.mjs";

export default async function chain(argv, ctx) {
  const { payload } = parseArgs("chain", argv);
  const stateFile = stateFilePath(ctx.cwd);
  const gi = await ensureGitignored(ctx.cwd);
  if (gi.updated) ctx.stderr.write(`pi-cc-plugin: ${gi.reason}\n`);

  const uniqueAgents = [...new Set(payload.steps.map((s) => s.agent))];
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
          steps: payload.steps.map((s) => ({
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
    kind: "chain",
    agents: payload.steps.map((s) => s.agent),
    task: payload.steps.map((s) => `${s.agent}["${s.task}"]`).join(" -> "),
    status: payload.background ? "running" : exitCodeStatus(launch.exitCode),
    started_at: startedAt,
    completed_at: payload.background ? null : new Date().toISOString(),
    pi_status_dir: launch.statusDir,
    model: payload.model ?? null,
    pid: launch.pid ?? null,
  });

  ctx.stdout.write(
    `${payload.background ? "Started" : "Finished"} ${job.internal_id} ` +
      `(chain, ${payload.steps.length} step${payload.steps.length === 1 ? "" : "s"}, ` +
      `pi-run-id ${job.id}).\n`,
  );
  return launch.exitCode === null || launch.exitCode === 0 ? 0 : 1;
}

function exitCodeStatus(code) {
  if (code === 0) return "completed";
  if (code === null) return "running";
  return "failed";
}

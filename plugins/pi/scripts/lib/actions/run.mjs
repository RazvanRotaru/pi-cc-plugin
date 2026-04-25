// /pi:run — delegate one task to one pi agent.

import { parseArgs } from "../args.mjs";
import { piExec } from "../pi-cli.mjs";
import { addJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { ensureGitignored } from "../gitignore.mjs";
import { prepareEphemeralAgents } from "../ephemeral-agents.mjs";
import { preflight } from "../preflight.mjs";

export default async function run(argv, ctx) {
  const { payload, flags } = parseArgs("run", argv);

  // Fail fast if pi or pi-subagents isn't installed — otherwise the
  // broker would dispatch into thin air and time out 60s+ later with
  // an opaque "no subagent-slash-result" message.
  await preflight({ env: ctx.env, cwd: ctx.cwd });

  const stateFile = stateFilePath(ctx.cwd);
  const gi = await ensureGitignored(ctx.cwd);
  if (gi.updated) {
    ctx.stderr.write(`pi-cc-plugin: ${gi.reason}\n`);
  }

  // If --mcp was passed, write an ephemeral agent file that includes the
  // MCP tools, swap the agent name in the payload, and clean up after.
  const { nameMap, cleanup } = await prepareEphemeralAgents({
    cwd: ctx.cwd,
    agents: [payload.agent],
    mcpTools: payload.mcp ?? [],
  });
  const dispatchPayload = applyAgentRename(payload, nameMap);

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

/**
 * Replace the payload's agent name with the ephemeral version when
 * `--mcp` was used. The state.json record keeps the ORIGINAL name so
 * the user sees a stable identifier in /pi:status.
 */
function applyAgentRename(payload, nameMap) {
  if (nameMap.size === 0) return payload;
  const renamed = { ...payload };
  if (payload.action === "run" && nameMap.has(payload.agent)) {
    renamed.agent = nameMap.get(payload.agent);
  }
  return renamed;
}

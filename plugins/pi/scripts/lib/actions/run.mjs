// /pi:agent — delegate one task to one pi agent.
//
// Foreground (default): dispatch, then poll pi-subagents' status.json
// until the run reaches a terminal state, then print the final output.
// Background (--bg): dispatch and return the run id immediately; the
// user picks up via /pi:status and /pi:result.

import { parseArgs } from "../args.mjs";
import { piExec } from "../pi-cli.mjs";
import { addJob, updateJob } from "../tracked-jobs.mjs";
import { stateFilePath } from "../state.mjs";
import { ensureGitignored } from "../gitignore.mjs";
import { prepareEphemeralAgents } from "../ephemeral-agents.mjs";
import { preflight } from "../preflight.mjs";
import {
  mapPiState,
  readPiResult,
  readPiStatus,
} from "../pi-status-reader.mjs";
import { displayAgentName } from "../render.mjs";

const DEFAULT_POLL_INTERVAL_MS = 1500;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export default async function run(argv, ctx) {
  const { payload } = parseArgs("run", argv);

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

  // Always record the job as "running" at first. Foreground mode patches
  // the terminal state in once polling sees pi-subagents reach a final
  // status; background mode leaves it for /pi:status to reconcile later.
  const job = await addJob(stateFile, {
    id: launch.runId,
    kind: "single",
    agents: [payload.agent],
    task: payload.task,
    status: "running",
    started_at: startedAt,
    completed_at: null,
    pi_status_dir: launch.statusDir,
    model: payload.model ?? null,
    pid: launch.pid ?? null,
    fork: !!payload.fork,
    worktree: !!payload.worktree,
  });

  if (payload.background) {
    ctx.stdout.write(
      `Started ${job.internal_id} (pi-run-id ${job.id}) — agent=${payload.agent}, model=${payload.model ?? "default"}${payload.worktree ? ", worktree" : ""}\n`,
    );
    ctx.stdout.write(`Use /pi:status ${job.internal_id} to inspect.\n`);
    return 0;
  }

  ctx.stdout.write(
    `Running ${job.internal_id} (pi-run-id ${job.id}) — agent=${payload.agent}, model=${payload.model ?? "default"}${payload.worktree ? ", worktree" : ""}\n`,
  );
  ctx.stdout.write(
    `(Ctrl+C to stop polling — subagent keeps running; pick up with /pi:status ${job.internal_id})\n`,
  );

  const pollIntervalMs = Number(
    ctx.env.PI_BROKER_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const finalStatus = await pollUntilTerminal({
    statusDir: launch.statusDir,
    pollIntervalMs,
    verbose: !!payload.verbose,
    stdout: ctx.stdout,
  });

  const completedAt = new Date().toISOString();
  await updateJob(stateFile, job.internal_id, {
    status: finalStatus.brokerState,
    completed_at: completedAt,
  });

  const finalOutput = await readPiResult(launch.statusDir);
  ctx.stdout.write(
    `\nFinished ${job.internal_id} — ${finalStatus.brokerState} (pi-run-id ${job.id}).\n`,
  );
  if (finalOutput) {
    ctx.stdout.write("\n--- output ---\n");
    ctx.stdout.write(finalOutput.endsWith("\n") ? finalOutput : `${finalOutput}\n`);
  } else {
    ctx.stdout.write("(no output captured — try /pi:result for the latest pi state)\n");
  }
  if (finalStatus.error) {
    ctx.stdout.write(`\nerror: ${finalStatus.error}\n`);
  }

  return finalStatus.brokerState === "completed" ? 0 : 1;
}

/**
 * Poll pi-subagents' status.json until it reaches a terminal state.
 * Emits step-transition lines to `stdout` when `verbose` is true.
 *
 * Returns { brokerState, error } once terminal. Does not time out — the
 * caller is expected to background the broker (Ctrl+B in Claude Code)
 * or cancel (Ctrl+C) if the run takes longer than they're willing to
 * wait. Either way, the dispatched subagent keeps running.
 */
async function pollUntilTerminal({ statusDir, pollIntervalMs, verbose, stdout }) {
  const seenStepStatuses = new Map();
  while (true) {
    const piStatus = await readPiStatus(statusDir);
    if (piStatus) {
      if (verbose) emitStepDeltas(piStatus, seenStepStatuses, stdout);
      const brokerState = mapPiState(piStatus.state);
      if (TERMINAL_STATES.has(brokerState)) {
        return { brokerState, error: piStatus.error ?? null };
      }
    }
    await sleep(pollIntervalMs);
  }
}

function emitStepDeltas(piStatus, seen, stdout) {
  if (!Array.isArray(piStatus.steps)) return;
  for (let i = 0; i < piStatus.steps.length; i++) {
    const step = piStatus.steps[i];
    const key = `${i}:${step.agent ?? "?"}`;
    const prev = seen.get(key);
    if (prev === step.status) continue;
    seen.set(key, step.status);
    const agentLabel = displayAgentName(step.agent ?? "?");
    const modelLabel = step.model ? ` (model=${step.model})` : "";
    stdout.write(`  · ${agentLabel}${modelLabel}: ${step.status}\n`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

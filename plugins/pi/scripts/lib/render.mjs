// render.mjs — small markdown renderers for command output.
//
// Output is consumed by Claude Code (which renders markdown) AND by humans
// reading raw stdout, so keep it readable in both modes.

import { mapPiState } from "./pi-status-reader.mjs";

const TERMINAL_BROKER = new Set(["completed", "cancelled", "failed"]);

/**
 * Render a single job record as a multi-line block.
 *
 * Reconciliation rule: state.json's job.status wins when it's terminal
 * (the broker recorded a final state on user intent — e.g. cancellation
 * — and pi-subagents' status.json may not have caught up). Otherwise we
 * trust pi-subagents' fresher state.json.
 */
export function renderJob(job, piStatus) {
  const piState = piStatus ? mapPiState(piStatus.state) : null;
  const reconciled = TERMINAL_BROKER.has(job.status)
    ? job.status
    : (piState ?? job.status);
  const lines = [];
  lines.push(`**${job.internal_id}** · ${job.kind} · ${reconciled}`);
  if (job.id) lines.push(`  pi-run-id: \`${job.id}\``);
  if (Array.isArray(job.agents) && job.agents.length) {
    lines.push(`  agents: ${job.agents.join(" → ")}`);
  }
  if (job.task) lines.push(`  task: ${truncate(job.task, 200)}`);
  if (job.started_at) lines.push(`  started: ${job.started_at}`);
  if (job.completed_at) lines.push(`  completed: ${job.completed_at}`);
  if (piStatus) {
    if (piState && piState !== reconciled) {
      lines.push(`  pi-status: ${piState} (broker says: ${reconciled})`);
    }
    if (Array.isArray(piStatus.steps) && piStatus.steps.length) {
      lines.push("  steps:");
      for (const step of piStatus.steps) {
        lines.push(`    - ${step.agent}: ${step.status}`);
      }
    }
    if (piStatus.error) lines.push(`  error: ${truncate(piStatus.error, 300)}`);
  } else if (job.pi_status_dir) {
    lines.push("  (pi status dir not readable — may have been cleaned up)");
  }
  return lines.join("\n");
}

/**
 * Render a header + a sequence of jobs.
 */
export function renderJobList(jobs, piStatuses) {
  if (jobs.length === 0) return "No pi jobs tracked yet. Try /pi:run.";
  const blocks = jobs.map((job, i) => renderJob(job, piStatuses[i]));
  return `# pi-cc-plugin: ${jobs.length} job${jobs.length === 1 ? "" : "s"}\n\n${blocks.join("\n\n")}`;
}

function truncate(s, n) {
  if (typeof s !== "string") return s;
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

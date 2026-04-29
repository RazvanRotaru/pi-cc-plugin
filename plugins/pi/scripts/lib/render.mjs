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
 *
 * `events` (optional) is the array from `readPiEvents`; we dump it raw,
 * one JSON object per line. The orchestrator interprets it — no
 * summarization or filtering here.
 */
export function renderJob(job, piStatus, events) {
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
        const tag = step.error ? `${step.status} (error)` : step.status;
        lines.push(`    - ${displayAgentName(step.agent)}: ${tag}`);
      }
    }
    if (piStatus.error) lines.push(`  error: ${truncate(piStatus.error, 300)}`);
    // Step-level errors aren't always echoed in piStatus.error — surface
    // any new ones explicitly so a user doesn't think a step "completed
    // successfully" when pi-subagents marked it complete-with-error.
    const stepErrors = (piStatus.steps ?? [])
      .filter((s) => s.error && s.error !== piStatus.error)
      .map((s) => `${s.agent}: ${truncate(s.error, 200)}`);
    if (stepErrors.length) {
      lines.push("  step-errors:");
      for (const e of stepErrors) lines.push(`    - ${e}`);
      // Translate common pi-side errors into broker-level guidance.
      const allErrors = stepErrors.join(" ");
      const hint = guidanceForError(allErrors);
      if (hint) lines.push(`  hint: ${hint}`);
    }
  } else if (job.pi_status_dir) {
    lines.push("  (pi status dir not readable — may have been cleaned up)");
  }
  if (Array.isArray(events) && events.length) {
    lines.push("  events:");
    for (const ev of events) {
      lines.push(`    ${JSON.stringify(ev)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a header + a sequence of jobs. `eventsList[i]` lines up with
 * `jobs[i]` / `piStatuses[i]` and may be null when events.jsonl is missing.
 */
export function renderJobList(jobs, piStatuses, eventsList) {
  if (jobs.length === 0) return "No pi jobs tracked yet. Try /pi:agent.";
  const blocks = jobs.map((job, i) =>
    renderJob(job, piStatuses[i], eventsList?.[i]),
  );
  return `# pi-cc-plugin: ${jobs.length} job${jobs.length === 1 ? "" : "s"}\n\n${blocks.join("\n\n")}`;
}

/**
 * Map common pi/pi-subagents error strings to a broker-level remediation
 * hint. Returns null if nothing matches.
 */
export function guidanceForError(errorText) {
  if (!errorText) return null;
  const m = /No API key found for ([\w-]+)/i.exec(errorText);
  if (m) {
    const provider = m[1];
    const envVar = providerEnvVar(provider);
    return (
      `pi has no auth for "${provider}". ` +
      (envVar ? `Set ${envVar}, or run \`pi\` and /login. ` : `Run \`pi\` and /login, or set the matching API_KEY env var. `) +
      `Re-run /pi:setup to verify.`
    );
  }
  if (/is not a valid model ID|model.*not found/i.test(errorText)) {
    return "Pi rejected the model id. Check `pi --list-models` (or `pi-prices`) for valid `provider/model` strings.";
  }
  if (/worktree isolation requires a clean git working tree/i.test(errorText)) {
    return "Commit or stash uncommitted changes; pi-subagents requires a clean tree before creating worktrees.";
  }
  if (/spawn pi ENOENT/i.test(errorText)) {
    return "Pi binary not on the subagent's PATH. Re-run /pi:setup; the broker prepends pi's bin dir for child processes.";
  }
  return null;
}

/**
 * Strip the broker's `_pi-cc-ephem-<stamp>-<original>` prefix for
 * display. The ephemeral name is internal — users dispatched against
 * the original agent name, so that's what /pi:status should show.
 */
export function displayAgentName(name) {
  if (typeof name !== "string") return name;
  const m = /^_pi-cc-ephem-[\da-z]+-[\da-z]+-(.+)$/.exec(name);
  return m ? m[1] : name;
}

function providerEnvVar(provider) {
  const map = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    "openai-codex": "(needs ChatGPT Plus/Pro OAuth — `pi` then /login)",
    openrouter: "OPENROUTER_API_KEY",
    google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    xai: "XAI_API_KEY",
    groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    huggingface: "HF_TOKEN",
  };
  return map[provider.toLowerCase()] ?? null;
}

function truncate(s, n) {
  if (typeof s !== "string") return s;
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

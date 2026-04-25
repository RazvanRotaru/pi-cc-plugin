// pi-status-reader.mjs — read pi-subagents' per-run status files.
//
// Pi-subagents writes durable state to:
//   /tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/
//     status.json
//     events.jsonl
//     output-0.log                        # per-step stdout (foreground form)
//     subagent-log-<runId>.md             # human-readable log
//
// The asyncDir is captured at dispatch time and stored in our state.json
// (job.pi_status_dir). We never guess the path.
//
// status.json's `state` and per-step `status` use vocabulary:
//   "running" | "complete" | "failed"
// (NOT "completed" — that distinction caught us during dogfood.)
//
// All reads are best-effort. Returning null signals "pi's artifacts aren't
// readable" and the caller renders that gracefully.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read status.json from a pi-subagents async dir.
 */
export async function readPiStatus(statusDir) {
  if (!statusDir) return null;
  try {
    const raw = await readFile(join(statusDir, "status.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the most useful "result" — the per-step stdout file. pi-subagents
 * writes one `output-<step>.log` per step (zero-indexed). For single-agent
 * runs there's only `output-0.log`.
 */
export async function readPiResult(statusDir) {
  if (!statusDir) return null;
  // Single-step: output-0.log. Multi-step: concatenate all output-<n>.log.
  try {
    const files = await readdir(statusDir);
    const outputs = files
      .filter((f) => /^output-\d+\.log$/.test(f))
      .sort((a, b) => extractStep(a) - extractStep(b));
    if (outputs.length === 0) return null;
    const parts = [];
    for (const f of outputs) {
      const body = await readFile(join(statusDir, f), "utf8");
      parts.push(outputs.length > 1 ? `## step ${extractStep(f)}\n\n${body}` : body);
    }
    return parts.join("\n\n");
  } catch {
    return null;
  }
}

/**
 * Read the markdown log (subagent-log-<runId>.md).
 */
export async function readPiLog(statusDir) {
  if (!statusDir) return null;
  try {
    const files = await readdir(statusDir);
    const log = files.find((f) => /^subagent-log-.+\.md$/.test(f));
    if (!log) return null;
    return await readFile(join(statusDir, log), "utf8");
  } catch {
    return null;
  }
}

/**
 * Map pi-subagents' state vocabulary to ours. Use this when reconciling
 * pi's status.json into our state.json job records.
 */
export function mapPiState(piState) {
  switch (piState) {
    case "complete":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "running":
    case "pending":
      return "running";
    default:
      return piState ?? "unknown";
  }
}

function extractStep(filename) {
  const m = /^output-(\d+)\.log$/.exec(filename);
  return m ? Number(m[1]) : 0;
}

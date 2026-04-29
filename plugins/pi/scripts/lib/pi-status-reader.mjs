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
 * Read events.jsonl from a pi-subagents async dir.
 *
 * Pi-subagents emits one JSON event per line (`subagent.run.started`,
 * `subagent.step.started`, `subagent.run.completed`, child pi tool_calls
 * tagged with `subagentSource: "child"`, etc.). Pass-through to the
 * orchestrator — Claude reads the raw events and decides what to surface.
 *
 * @param {string} statusDir — pi-subagents asyncDir
 * @param {{ since?: number }} [opts] — byte offset from a prior read
 * @returns {Promise<{ events: object[], cursor: number } | null>}
 *   `null` if statusDir missing or events.jsonl unreadable. `cursor` is
 *   the new byte offset to pass back as `since` next time.
 *
 * Cursor semantics:
 *   - no `since` → return the full log
 *   - `since` past EOF (file shrunk/recreated) → reset: cursor = file.length
 *   - tail with no trailing newline → don't consume the partial line
 *   - malformed JSON lines are skipped silently
 */
export async function readPiEvents(statusDir, { since } = {}) {
  if (!statusDir) return null;
  let buf;
  try {
    buf = await readFile(join(statusDir, "events.jsonl"));
  } catch {
    return null;
  }
  if (typeof since === "number" && buf.length < since) {
    return { events: [], cursor: buf.length };
  }
  const start = typeof since === "number" ? since : 0;
  if (buf.length <= start) {
    return { events: [], cursor: buf.length };
  }
  const tail = buf.subarray(start);
  // Stop at the last newline so we never half-parse a line pi-subagents
  // is mid-write on. Anything after the last \n is left for next call.
  const lastNl = tail.lastIndexOf(0x0a);
  if (lastNl === -1) return { events: [], cursor: start };
  const cursor = start + lastNl + 1;
  const events = [];
  for (const line of tail.subarray(0, lastNl).toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return { events, cursor };
}

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

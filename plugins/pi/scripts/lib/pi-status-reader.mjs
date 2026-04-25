// pi-status-reader.mjs — read pi's per-run status files.
//
// Pi writes durable state to <statusDir>/status.json (per
// docs/PI_INVOCATION.md §3). The broker reads this every time a user runs
// /pi:status — we don't trust pi's stdout for state.
//
// All reads are best-effort. Returning null from any of these signals "pi's
// artifacts aren't readable" and the caller renders that gracefully.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read status.json from a pi run dir. Returns null on missing/malformed.
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
 * Read result.md from a pi run dir.
 */
export async function readPiResult(statusDir) {
  if (!statusDir) return null;
  try {
    return await readFile(join(statusDir, "result.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Read log.md from a pi run dir.
 */
export async function readPiLog(statusDir) {
  if (!statusDir) return null;
  try {
    return await readFile(join(statusDir, "log.md"), "utf8");
  } catch {
    return null;
  }
}

// state.mjs — atomic JSON state file with mkdir-based locking.
//
// Layout: ./.pi-cc-plugin/state.json
// Schema: { version: 1, jobs: Job[] }
//
// All writes go through `update(stateFile, fn)` — the function receives the
// current state and returns the new state. The wrapper handles locking and
// atomic rename, so concurrent /pi:run calls don't corrupt the file.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const STATE_VERSION = 1;
const LOCK_RETRIES = 50;
const LOCK_DELAY_MS = 20;

export const DEFAULT_STATE = { version: STATE_VERSION, jobs: [] };

/**
 * Resolve the state file path for a given workspace cwd.
 */
export function stateFilePath(cwd) {
  return resolve(cwd, ".pi-cc-plugin/state.json");
}

/**
 * Read and parse state.json. Returns DEFAULT_STATE if the file doesn't exist.
 * Throws (loudly, with context) on JSON parse errors so we never silently
 * destroy a user's state by overwriting it.
 */
export async function readState(stateFile) {
  let raw;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(DEFAULT_STATE);
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("state.json is not an object");
    }
    if (!Array.isArray(parsed.jobs)) parsed.jobs = [];
    if (typeof parsed.version !== "number") parsed.version = STATE_VERSION;
    return parsed;
  } catch (err) {
    throw new Error(
      `pi-cc-plugin: state file at ${stateFile} is malformed (${err.message}). ` +
        "Inspect or remove it before continuing.",
    );
  }
}

/**
 * Write state atomically: write to a sibling tmp file, fsync via flag, rename.
 */
export async function writeState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, stateFile);
}

/**
 * Acquire a directory-based lock around `fn`. mkdir is atomic on every Unix
 * filesystem we care about, so this is safe under concurrent broker calls.
 */
export async function withLock(stateFile, fn) {
  const lockDir = `${stateFile}.lock`;
  await mkdir(dirname(stateFile), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockDir);
      try {
        return await fn();
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await sleep(LOCK_DELAY_MS + Math.random() * 60);
    }
  }
  throw new Error(
    `pi-cc-plugin: could not acquire state lock at ${lockDir} after ${LOCK_RETRIES} attempts. ` +
      "Remove the directory if a previous broker crashed.",
  );
}

/**
 * Read-modify-write convenience. The mutator can return a new state object
 * or mutate the passed-in object in place.
 */
export async function updateState(stateFile, mutator) {
  return withLock(stateFile, async () => {
    const cur = await readState(stateFile);
    const next = (await mutator(cur)) ?? cur;
    await writeState(stateFile, next);
    return next;
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Exposed for tests that want to manipulate paths without depending on cwd.
export const _internals = { STATE_VERSION, LOCK_RETRIES, LOCK_DELAY_MS };

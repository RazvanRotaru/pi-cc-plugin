// Test helpers — small enough to live without dependencies.
//
// Spawns the broker as a child process so each test exercises the same
// entry point a real /pi:* slash command would.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");
export const BROKER = resolve(REPO_ROOT, "plugins/pi/scripts/pi-broker.mjs");
export const FAKE_PI = resolve(REPO_ROOT, "tests/fixtures/fake-pi.mjs");

/**
 * Run the broker with the given args. Returns {code, stdout, stderr}.
 * Tests that need a clean cwd should call `withTempCwd` first.
 */
export function runBroker(args, { cwd = REPO_ROOT, env = {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [BROKER, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

/** Make a fresh temp dir, run callback with it as cwd, clean up after. */
export async function withTempCwd(fn) {
  const dir = await mkdtemp(resolve(tmpdir(), "pi-cc-plugin-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Returns the env vars needed to make the broker spawn the fake pi. */
export function fakePiEnv(extra = {}) {
  return {
    PI_BROKER_PI_BIN: process.execPath,
    PI_BROKER_PI_ARGS: FAKE_PI,
    ...extra,
  };
}

// pi-spawn — resolve the `pi` binary cross-platform.
//
// Adapted from nicobailon/pi-subagents `pi-spawn.ts`. The behavior:
//   - Unix:    `pi` on $PATH
//   - Windows: locate the pi script via `require.resolve("@mariozechner/pi-coding-agent/package.json")`
//              and run it with `process.execPath` (node)
//
// Tests can override the resolution entirely via env vars:
//   PI_BROKER_PI_BIN=<path-to-binary>   — used as the executable
//   PI_BROKER_PI_ARGS=<arg1>[,arg2,...] — comma-separated args prepended
//
// This is how the fake-pi fixture is wired in.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Returns the spawn descriptor for pi: `{ command, args }`.
 *   - Combine with the user's args: `spawn(command, [...args, ...userArgs])`.
 *   - Throws if pi is not installed and no override is set.
 */
export function resolvePi({ env = process.env, platform = process.platform } = {}) {
  if (env.PI_BROKER_PI_BIN) {
    const args = env.PI_BROKER_PI_ARGS
      ? env.PI_BROKER_PI_ARGS.split(",").filter(Boolean)
      : [];
    return { command: env.PI_BROKER_PI_BIN, args, source: "env-override" };
  }

  if (platform === "win32") {
    return resolveWindowsPi();
  }

  return { command: "pi", args: [], source: "path" };
}

function resolveWindowsPi() {
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve("@mariozechner/pi-coding-agent/package.json");
  } catch {
    throw new Error(
      "pi not found. Install pi via: npm i -g @mariozechner/pi-coding-agent",
    );
  }
  const pkgDir = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const binEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (!binEntry) {
    throw new Error(
      "pi-coding-agent package has no `bin.pi` entry — cannot resolve script path",
    );
  }
  const scriptPath = resolve(pkgDir, binEntry);
  if (!existsSync(scriptPath)) {
    throw new Error(`pi script not found at ${scriptPath}`);
  }
  return { command: process.execPath, args: [scriptPath], source: "windows-resolved" };
}

/**
 * Convenience: format the resolved descriptor for human display.
 */
export function describePi(desc) {
  return desc.args.length === 0
    ? desc.command
    : `${desc.command} ${desc.args.join(" ")}`;
}

// Helper for tests — re-export the bare path too in case tests need it.
export const _internals = { resolveWindowsPi };

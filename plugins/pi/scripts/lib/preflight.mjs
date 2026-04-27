// preflight.mjs — fast, cached health check before /pi:run dispatch.
//
// Without this, missing pi or missing pi-subagents shows up to the user
// as a 60s+ "timed out waiting for subagent-slash-result" — confusing,
// because the broker is just sitting in a handshake against nothing.
//
// The check is filesystem-only: no subprocesses. ~1ms per call. Result
// cached in-process so each /pi:run dispatch pays it once at most.
//
// Cache lifetime is per-broker-process, so each slash command run does
// pay the first call once. With dispatch-cost dominating overall
// latency, that's negligible.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePi } from "./pi-spawn.mjs";

let cached = null;

/**
 * Validate pi + pi-subagents are reachable. Throws a user-actionable
 * Error if not. Subsequent calls are cheap (cached).
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {string} opts.cwd
 */
export async function preflight({ env, cwd }) {
  if (cached === true) return;
  if (cached instanceof Error) throw cached;

  // Test fixtures and custom launchers signal "I know what I'm doing"
  // by setting PI_BROKER_PI_BIN. Skip the preflight in that case.
  if (env.PI_BROKER_PI_BIN || env.PI_BROKER_NO_PREFLIGHT === "1") {
    cached = true;
    return;
  }

  try {
    // 1. Pi resolvable AND, if package-resolved, the script actually exists.
    const desc = resolvePi({ env });
    if (desc.source === "package-resolved") {
      if (!existsSync(desc.args[0])) {
        throw withHint(
          `pi-cc-plugin: pi script not found at ${desc.args[0]} (resolution stale).`,
        );
      }
    } else if (desc.source === "path") {
      // Best-effort: try `which pi` to confirm.
      if (!whichOnPath("pi", env)) {
        throw withHint(
          "pi-cc-plugin: pi binary not on PATH and no installed package found.\n" +
            "  Looked in npm-global lib/node_modules, /usr/local/lib, nvm versions.\n" +
            "  Install pi: npm i -g @mariozechner/pi-coding-agent (Node >= 20).",
        );
      }
    }

    // 2. pi-subagents extension reachable somewhere pi will discover it.
    if (!findSubagentsExtension({ cwd, env })) {
      throw withHint(
        "pi-cc-plugin: pi-subagents extension not found.\n" +
          "  Looked in ~/.pi/agent/extensions/subagent/, .pi/extensions/subagent/, " +
          "and <npm-root>/pi-subagents/.\n" +
          "  Install: pi install npm:pi-subagents",
      );
    }

    cached = true;
  } catch (err) {
    cached = err;
    throw err;
  }
}

/**
 * Reset the in-process cache. Test-only.
 */
export function _resetPreflightCache() {
  cached = null;
}

function withHint(msg) {
  return new Error(`${msg}\n  Run \`/pi:setup\` for a full diagnosis.`);
}

function whichOnPath(name, env) {
  const path = env.PATH ?? "";
  if (!path) return false;
  for (const dir of path.split(":")) {
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

function findSubagentsExtension({ cwd, env }) {
  const home = env.HOME ?? homedir();
  const candidates = [];
  if (home) candidates.push(join(home, ".pi/agent/extensions/subagent"));
  if (cwd) candidates.push(join(cwd, ".pi/extensions/subagent"));
  for (const root of collectGlobalNpmRoots(env)) {
    candidates.push(join(root, "pi-subagents"));
  }
  return candidates.some((d) => existsSync(d));
}

function collectGlobalNpmRoots(env) {
  const roots = [];
  try {
    const out = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"], env })
      .toString()
      .trim();
    if (out) roots.push(out);
  } catch {
    // npm not on PATH — fall through.
  }
  const home = env.HOME ?? homedir();
  if (home) roots.push(join(home, ".npm-global/lib/node_modules"));
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");
  if (home) {
    const nvmDir = join(home, ".nvm/versions/node");
    if (existsSync(nvmDir)) {
      try {
        for (const v of execSync(`ls "${nvmDir}"`, { stdio: ["ignore", "pipe", "ignore"], env })
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean)) {
          roots.push(join(nvmDir, v, "lib/node_modules"));
        }
      } catch {
        // ignore
      }
    }
  }
  return [...new Set(roots)];
}

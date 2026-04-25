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

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PI_PKG_TAIL = "@mariozechner/pi-coding-agent";

/**
 * Returns the spawn descriptor for pi: `{ command, args }`.
 *   - Combine with the user's args: `spawn(command, [...args, ...userArgs])`.
 *   - Throws if pi is not installed and no override is set.
 *
 * Resolution order:
 *   1. PI_BROKER_PI_BIN env override (used by the test harness).
 *   2. pi as a `bin` script via npm-global locations (the broker runs in
 *      Claude Code's subprocess env, which often misses ~/.npm-global/bin
 *      from $PATH — so we look up the package directly).
 *   3. `pi` on $PATH as a last resort.
 */
export function resolvePi({ env = process.env, platform = process.platform } = {}) {
  if (env.PI_BROKER_PI_BIN) {
    const args = env.PI_BROKER_PI_ARGS
      ? env.PI_BROKER_PI_ARGS.split(",").filter(Boolean)
      : [];
    return { command: env.PI_BROKER_PI_BIN, args, source: "env-override" };
  }

  // Locate the package across common global install locations. Works on
  // Linux (~/.npm-global, /usr/local), macOS (Homebrew), and inside nvm.
  const pkgScript = findPiBinScript({ env, platform });
  if (pkgScript) {
    // Pi requires Node ≥20. The broker itself may run under an older Node
    // (Claude Code's host process inherits whatever's on the system), so
    // we don't blindly use process.execPath — we look for a 20+ node first.
    const node = findCompatibleNode({ env }) ?? process.execPath;
    // Pi's child processes need three things on PATH:
    //   1. The Node binary (for any `node`-shebang scripts pi spawns).
    //   2. `npm` matching that Node (pi's package manager spawns npm).
    //   3. `pi` itself — pi-subagents calls spawn("pi", ...) for the
    //      child subagent process and falls back to PATH.
    // Items 1+2 share the Node bin dir; item 3 lives under the pi
    // package's prefix (e.g. ~/.npm-global/bin), which can be DIFFERENT
    // from the Node bin dir if pi was installed under one prefix and
    // pi-subagents under another (common when nvm is layered over an
    // existing ~/.npm-global prefix).
    const nodeBinDir = node === process.execPath ? null : dirname(node);
    const piPrefixBinDir = derivePrefixBinFromScript(pkgScript);
    const binDirs = [nodeBinDir, piPrefixBinDir].filter(Boolean);
    return { command: node, args: [pkgScript], source: "package-resolved", binDirs };
  }

  // Last resort: rely on $PATH. May fail if Claude Code's subprocess env
  // doesn't include the npm-global bin dir.
  return { command: "pi", args: [], source: "path", binDirs: [] };
}

/**
 * Given the absolute path to pi's `dist/cli.js`, derive the npm prefix's
 * `bin/` directory. The npm install layout is always:
 *   <prefix>/lib/node_modules/<pkg>/dist/cli.js
 *   <prefix>/bin/<bin-symlink>
 * So we split on the LAST occurrence of "/node_modules/" in the path
 * (the global one — pi's own internal node_modules would be deeper),
 * trim the trailing "/lib" if present, and append "/bin".
 */
function derivePrefixBinFromScript(scriptPath) {
  const marker = `${sep()}node_modules${sep()}`;
  const idx = scriptPath.indexOf(marker);
  if (idx === -1) return null;
  let prefix = scriptPath.slice(0, idx);
  if (prefix.endsWith(`${sep()}lib`)) {
    prefix = prefix.slice(0, -4);
  }
  const bin = join(prefix, "bin");
  return existsSync(bin) ? bin : null;
}

function sep() {
  return process.platform === "win32" ? "\\" : "/";
}

/**
 * Build an env object suitable for spawning pi. Prepends each entry in
 * `desc.binDirs` to PATH (Node bin first, then pi's prefix bin if
 * different). Without this, pi's own child processes (npm, child pi for
 * subagents) won't find the matching binaries.
 */
export function piSpawnEnv(desc, baseEnv = process.env) {
  const dirs = desc.binDirs ?? [];
  if (dirs.length === 0) return { ...baseEnv };
  const sep = ":";
  let path = baseEnv.PATH ?? "";
  // Prepend in reverse so the first dir ends up leftmost.
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (!path.includes(dirs[i])) {
      path = `${dirs[i]}${path ? sep : ""}${path}`;
    }
  }
  return { ...baseEnv, PATH: path };
}

/**
 * Find a Node binary capable of running pi (≥20). Preference order:
 *   1. process.execPath if it's already ≥20.
 *   2. The highest nvm-installed Node ≥20.
 *   3. /usr/local/bin/node, /opt/homebrew/bin/node if newer.
 * Returns null if nothing suitable found — caller falls back to execPath
 * and lets pi report its own incompatibility error.
 */
function findCompatibleNode({ env }) {
  const candidates = [];
  candidates.push(process.execPath);
  const home = env.HOME ?? "";
  if (home) {
    const nvmDir = join(home, ".nvm/versions/node");
    if (existsSync(nvmDir)) {
      try {
        for (const v of execSync(`ls "${nvmDir}"`, { stdio: ["ignore", "pipe", "ignore"], env })
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean)) {
          const p = join(nvmDir, v, "bin/node");
          if (existsSync(p)) candidates.push(p);
        }
      } catch {
        // ignore
      }
    }
  }
  candidates.push("/usr/local/bin/node");
  if (env.PATH) {
    for (const dir of env.PATH.split(":")) {
      const p = join(dir, "node");
      if (existsSync(p)) candidates.push(p);
    }
  }

  let best = null;
  let bestMajor = -1;
  for (const node of [...new Set(candidates)]) {
    const major = nodeMajor(node, env);
    if (major !== null && major >= 20 && major > bestMajor) {
      best = node;
      bestMajor = major;
    }
  }
  return best;
}

function nodeMajor(nodePath, env) {
  try {
    const out = execSync(`"${nodePath}" --version`, {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    })
      .toString()
      .trim();
    const m = /^v(\d+)\./.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function findPiBinScript({ env, platform }) {
  const candidates = collectGlobalRoots({ env, platform });
  for (const root of candidates) {
    const pkgJsonPath = join(root, PI_PKG_TAIL, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      const binEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (!binEntry) continue;
      const scriptPath = resolve(dirname(pkgJsonPath), binEntry);
      if (existsSync(scriptPath)) return scriptPath;
    } catch {
      // Malformed package.json — skip.
    }
  }
  return null;
}

function collectGlobalRoots({ env, platform }) {
  const roots = [];
  // 1. `npm root -g` if npm is available — covers nvm, ~/.npm-global, system.
  // Pass the caller's env so tests with env:{} skip this step deterministically.
  try {
    const out = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"], env })
      .toString()
      .trim();
    if (out) roots.push(out);
  } catch {
    // npm not on PATH — fall through.
  }
  const home = env.HOME ?? "";
  if (home) roots.push(join(home, ".npm-global/lib/node_modules"));
  if (platform === "darwin") {
    roots.push("/usr/local/lib/node_modules");
    roots.push("/opt/homebrew/lib/node_modules");
  } else if (platform === "linux") {
    roots.push("/usr/local/lib/node_modules");
    roots.push("/usr/lib/node_modules");
  }
  // nvm: scan installed Node versions.
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
  // De-duplicate while preserving order.
  return [...new Set(roots)];
}

/**
 * Convenience: format the resolved descriptor for human display.
 */
export function describePi(desc) {
  return desc.args.length === 0
    ? desc.command
    : `${desc.command} ${desc.args.join(" ")}`;
}

// Helper for tests.
export const _internals = { findPiBinScript, collectGlobalRoots };

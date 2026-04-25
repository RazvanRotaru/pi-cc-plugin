// setup-checks.mjs — idempotent verification + scaffolding helpers.
//
// Each check returns a small status record:
//   { name, ok, message, fixable, fix?: () => Promise<void> }
//
// The /pi:setup action runs them in order, prints results, and prompts (or
// auto-applies with --yes) for fixable failures.

import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePi, describePi } from "./pi-spawn.mjs";
import { ensureGitignored } from "./gitignore.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/lib → ../../agents-seed
const SEEDS_DIR = resolve(here, "../../agents-seed");

const SPECIALISTS = [
  "architect",
  "test-writer",
  "test-reviewer",
  "implementer",
  "code-reviewer",
  "ci-triage",
];

export async function checkPiInstalled({ env }) {
  const desc = resolvePi({ env });
  const ok = await runProbe(desc.command, [...desc.args, "--version"], { env });
  return {
    name: "pi installed",
    ok,
    message: ok
      ? `pi resolved: ${describePi(desc)}`
      : "pi not on PATH. Install via: npm i -g @mariozechner/pi-coding-agent",
    fixable: false,
  };
}

/**
 * Check whether the pi-subagents extension is present.
 *
 * Pi has no `list-extensions` flag — extensions are auto-discovered from
 * `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local)
 * per `docs/extensions.md` in pi-coding-agent. We just look on disk.
 *
 * Test override: env.PI_BROKER_FAKE_EXTENSIONS_DIR points at a dir that
 * fixture tests can populate to simulate the installed/missing states.
 */
export async function checkPiSubagentsInstalled({ env, cwd }) {
  // Test override: a fixture dir whose contents stand in for ~/.pi/agent/extensions/.
  if (env.PI_BROKER_FAKE_EXTENSIONS_DIR) {
    return formatSubagentsResult(
      await dirContainsSubagents(env.PI_BROKER_FAKE_EXTENSIONS_DIR),
    );
  }
  const home = env.HOME ?? process.env.HOME;
  const candidates = [];
  if (home) candidates.push(join(home, ".pi/agent/extensions"));
  if (cwd) candidates.push(join(cwd, ".pi/extensions"));
  for (const dir of candidates) {
    if (await dirContainsSubagents(dir)) return formatSubagentsResult(true);
  }
  return formatSubagentsResult(false);
}

function formatSubagentsResult(installed) {
  return {
    name: "pi-subagents installed",
    ok: installed,
    message: installed
      ? "pi-subagents extension found"
      : "pi-subagents not installed. Install: pi install npm:pi-subagents " +
        "(or drop a copy at ~/.pi/agent/extensions/pi-subagents.ts)",
    fixable: false,
  };
}

async function dirContainsSubagents(dir) {
  try {
    const entries = await readdir(dir);
    return entries.some((name) => /pi[-_]?subagents/i.test(name));
  } catch {
    return false;
  }
}

export async function checkSpecialistSeeds({ cwd }) {
  const dest = resolve(cwd, ".pi/agents");
  const missing = [];
  for (const name of SPECIALISTS) {
    try {
      await access(join(dest, `${name}.md`));
    } catch {
      missing.push(name);
    }
  }
  if (missing.length === 0) {
    return {
      name: "specialist seeds",
      ok: true,
      message: `all ${SPECIALISTS.length} seeds present in .pi/agents/`,
      fixable: false,
    };
  }
  return {
    name: "specialist seeds",
    ok: false,
    message: `missing seeds: ${missing.join(", ")}`,
    fixable: true,
    fix: async () => {
      await mkdir(dest, { recursive: true });
      for (const name of missing) {
        await copyFile(join(SEEDS_DIR, `${name}.md`), join(dest, `${name}.md`));
      }
    },
  };
}

export async function checkGitignore({ cwd }) {
  const r = await ensureGitignored(cwd);
  return {
    name: ".gitignore",
    ok: true,
    message: r.updated ? "added .pi-cc-plugin/ to .gitignore" : r.reason,
    fixable: false,
  };
}

/**
 * MCP config registration is interactive — we print a JSON snippet for the
 * user to paste, since the path/format isn't verified yet (see
 * docs/PI_INVOCATION.md §6).
 */
export async function checkMcpRegistration() {
  return {
    name: "team-tracking-mcp registration",
    ok: false,
    message:
      "auto-registration not yet wired (path/format TBD). " +
      "Paste this into pi's MCP config:\n" +
      `${JSON.stringify(
        {
          mcpServers: {
            "team-tracking": {
              command: "node",
              args: ["/abs/path/to/team-tracking-mcp/dist/server.js"],
            },
          },
        },
        null,
        2,
      )}`,
    fixable: false,
  };
}

export const _internals = { SPECIALISTS, SEEDS_DIR };

async function runProbe(command, args, { env, timeoutMs = 5000 }) {
  return new Promise((resolveP) => {
    const child = spawn(command, args, { env, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveP(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolveP(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP(code === 0);
    });
  });
}

async function captureProbe(command, args, { env, timeoutMs = 5000 }) {
  return new Promise((resolveP) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveP(null);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolveP(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP(code === 0 ? out : null);
    });
  });
}

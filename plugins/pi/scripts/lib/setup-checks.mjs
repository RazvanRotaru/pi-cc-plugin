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

export async function checkPiSubagentsInstalled({ env }) {
  const desc = resolvePi({ env });
  const out = await captureProbe(desc.command, [...desc.args, "list-extensions", "--json"], { env });
  if (out === null) {
    return {
      name: "pi-subagents installed",
      ok: false,
      message: "pi list-extensions failed (pi missing or older than expected)",
      fixable: false,
    };
  }
  let installed = false;
  try {
    const list = JSON.parse(out);
    installed = Array.isArray(list) && list.some((e) => /pi-subagents/i.test(e.name ?? ""));
  } catch {
    installed = /pi-subagents/i.test(out);
  }
  return {
    name: "pi-subagents installed",
    ok: installed,
    message: installed
      ? "pi-subagents extension found"
      : "pi-subagents not installed. Install via: pi install npm:pi-subagents",
    fixable: false,
  };
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

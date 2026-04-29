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
import { piSpawnEnv, resolvePi, describePi } from "./pi-spawn.mjs";
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
  const ok = await runProbe(desc.command, [...desc.args, "--version"], {
    env: piSpawnEnv(desc, env),
  });
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
 * Pi tracks installed extensions in its settings (~/.pi/agent/settings.json
 * `packages[]` and project-local .pi/settings.json). Authoritative check
 * is `pi list`.
 *
 * Test override: env.PI_BROKER_FAKE_EXTENSIONS_DIR points at a dir whose
 * contents stand in for the install state. If a file matching pi-subagents
 * is present in that dir, we report installed; if the dir exists but is
 * empty, we report missing. This lets fixture tests drive both branches.
 */
export async function checkPiSubagentsInstalled({ env, cwd }) {
  if (env.PI_BROKER_FAKE_EXTENSIONS_DIR) {
    return formatSubagentsResult(
      await dirContainsSubagents(env.PI_BROKER_FAKE_EXTENSIONS_DIR),
    );
  }
  // Authoritative: `pi list` reads pi's settings.
  const desc = resolvePi({ env });
  const out = await captureProbe(desc.command, [...desc.args, "list"], {
    env: piSpawnEnv(desc, env),
  });
  if (out !== null && /pi-subagents/i.test(out)) {
    return formatSubagentsResult(true);
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
 * Best-effort check that pi has SOME provider auth configured. Pi reads
 * credentials from ~/.pi/agent/auth.json (preferred) OR per-provider env
 * vars (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, etc.) OR an OAuth login
 * (Claude Pro/Max, ChatGPT Plus, Gemini CLI). We can't probe the OAuth
 * paths from outside, but missing auth.json + missing env keys is a
 * strong signal nothing is configured.
 */
export async function checkPiAuth({ env }) {
  const home = env.HOME ?? process.env.HOME;
  const authJson = home ? join(home, ".pi/agent/auth.json") : null;
  const hasAuthFile = authJson ? await fileExists(authJson) : false;

  // Common provider env vars pi recognizes (subset; full list in pi's docs/providers.md).
  const ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "CEREBRAS_API_KEY",
    "AI_GATEWAY_API_KEY",
    "FIREWORKS_API_KEY",
    "HF_TOKEN",
  ];
  const hasEnvKey = ENV_KEYS.some((k) => env[k] && env[k].length > 8);

  if (hasAuthFile || hasEnvKey) {
    const sources = [];
    if (hasAuthFile) sources.push("~/.pi/agent/auth.json");
    if (hasEnvKey) sources.push("env vars");
    return {
      name: "pi provider auth",
      ok: true,
      message: `auth source: ${sources.join(" + ")}`,
      fixable: false,
    };
  }

  return {
    name: "pi provider auth",
    ok: false,
    message:
      "no provider configured.  Pick one:\n" +
      "    A. Subscription:    run `pi`, then /login (Claude Pro/Max, ChatGPT Plus, Gemini CLI, etc.)\n" +
      "    B. API key file:    run `pi`, then /login (saves to ~/.pi/agent/auth.json with 0600 perms)\n" +
      "    C. Env var:         export OPENROUTER_API_KEY=sk-or-... (or ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)\n" +
      "  /pi:agent will fail with `No API key found for <provider>` until one of these is set.",
    fixable: false,
  };
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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

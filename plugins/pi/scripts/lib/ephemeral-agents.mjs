// ephemeral-agents.mjs — write a per-dispatch agent file that grafts
// extra MCP tools onto an existing agent's frontmatter.
//
// Pi-subagents' subagent tool schema has no per-call `tools` or `mcp`
// field — MCP tools live exclusively in the agent's markdown
// frontmatter `tools:` line. To support invocation-time `--mcp foo/bar`,
// the broker writes a one-shot agent file at
//   .pi/agents/_pi-cc-<runHash>-<originalName>.md
// with the same frontmatter + body as the source, plus the requested
// `mcp:foo/bar` entries appended to its `tools:` line. Pi-subagents
// auto-discovers it (project scope, highest priority); the broker
// dispatches under the temp name and cleans up after asyncId capture.
//
// Source resolution: project-local `.pi/agents/<name>.md` only. If the
// user passes --mcp with a builtin agent name (scout, worker, etc.)
// without a project-local copy, we throw with a clear remediation
// (suggest copying via the pi-subagents agents manager, or scaffolding
// a project-local seed).

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TEMP_PREFIX = "_pi-cc-ephem";

// Frontmatter fields supported by pi-subagents' agentOverrides. We pass
// these through from settings.json into the ephemeral file so the user's
// project-scoped/user-scoped overrides keep applying.
const PASSTHROUGH_OVERRIDE_FIELDS = [
  "model",
  "fallbackModels",
  "thinking",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "skills",
];

/**
 * Plan the per-agent ephemeral file rewrites for a payload.
 *
 * @param {object} opts
 * @param {string} opts.cwd        — workspace root (for resolving .pi/agents/)
 * @param {string[]} opts.agents   — unique agent names to override
 * @param {string[]} opts.mcpTools — normalized "server/tool" entries (no "mcp:" prefix)
 * @returns {Promise<{nameMap: Map<string,string>, cleanup: () => Promise<void>}>}
 *   nameMap maps original agent name → ephemeral name. Use it to rewrite
 *   the payload before dispatch. cleanup deletes the temp files.
 */
export async function prepareEphemeralAgents({ cwd, agents, mcpTools }) {
  if (!mcpTools || mcpTools.length === 0) {
    return { nameMap: new Map(), cleanup: async () => {} };
  }
  const agentsDir = join(cwd, ".pi/agents");
  await mkdir(agentsDir, { recursive: true });

  const overrides = await loadAgentOverrides(cwd);
  const runStamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const nameMap = new Map();
  const writtenFiles = [];

  try {
    for (const original of agents) {
      const raw = await loadAgentSource(cwd, original);

      // Surface a clear error if neither project nor builtin source exists.
      if (raw === null) {
        throw new Error(
          `--mcp couldn't find a source for agent "${original}". ` +
            `Looked in .pi/agents/${original}.md and pi-subagents' builtin agents dir. ` +
            "Scaffold a project seed (`/pi:setup`), or pick a different agent.",
        );
      }

      const ephemName = `${TEMP_PREFIX}-${runStamp}-${original}`;
      const overrideForOriginal = overrides[original] ?? {};
      const newBody = rewriteAgentForMcp(raw, ephemName, mcpTools, overrideForOriginal);
      const destPath = join(agentsDir, `${ephemName}.md`);
      await writeFile(destPath, newBody, "utf8");
      writtenFiles.push(destPath);
      nameMap.set(original, ephemName);
    }
  } catch (err) {
    // Best-effort cleanup of any partial writes before re-raising.
    for (const f of writtenFiles) {
      await rm(f, { force: true });
    }
    throw err;
  }

  const cleanup = async () => {
    for (const f of writtenFiles) {
      await rm(f, { force: true });
    }
  };
  return { nameMap, cleanup };
}

/**
 * Take the raw markdown of an agent file, replace its `name:` field
 * (so pi-subagents discovers it under the new ephemeral name), append
 * `mcp:` entries to its `tools:` line, and overlay any settings.json
 * agentOverrides for the original name (model, fallbackModels, etc).
 *
 * Defensive: if the source has no `tools:` line, we add one. If it
 * already lists some of the requested mcp tools, we deduplicate.
 *
 * Exposed for unit tests.
 */
export function rewriteAgentForMcp(rawMarkdown, newName, mcpTools, overrideFields = {}) {
  const fmEnd = rawMarkdown.indexOf("\n---", 4);
  if (!rawMarkdown.startsWith("---\n") || fmEnd === -1) {
    throw new Error("agent file is missing a YAML frontmatter block");
  }
  const frontmatter = rawMarkdown.slice(4, fmEnd);
  const body = rawMarkdown.slice(fmEnd + 4);

  const lines = frontmatter.split("\n");
  const mcpEntries = mcpTools.map((t) => `mcp:${t}`);

  // Track which override keys we've consumed so we know which to append.
  const overrideKeys = new Set(
    PASSTHROUGH_OVERRIDE_FIELDS.filter((k) => overrideFields[k] !== undefined),
  );

  let nameSeen = false;
  let toolsSeen = false;
  const out = [];
  for (const line of lines) {
    if (/^name:\s*/.test(line)) {
      nameSeen = true;
      out.push(`name: ${newName}`);
      continue;
    }
    if (/^tools:\s*/.test(line)) {
      toolsSeen = true;
      const existing = line
        .replace(/^tools:\s*/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const merged = dedupePreserveOrder([...existing, ...mcpEntries]);
      out.push(`tools: ${merged.join(", ")}`);
      continue;
    }
    // If this is one of the override keys, replace its value.
    const m = /^([\w-]+):\s*/.exec(line);
    if (m && overrideKeys.has(m[1])) {
      out.push(`${m[1]}: ${formatYamlScalar(overrideFields[m[1]])}`);
      overrideKeys.delete(m[1]);
      continue;
    }
    out.push(line);
  }
  if (!nameSeen) out.unshift(`name: ${newName}`);
  if (!toolsSeen) out.push(`tools: ${mcpEntries.join(", ")}`);
  // Any override fields that weren't already in the frontmatter — append them.
  for (const k of overrideKeys) {
    out.push(`${k}: ${formatYamlScalar(overrideFields[k])}`);
  }

  return `---\n${out.join("\n")}\n---${body}`;
}

/**
 * Read pi-subagents agentOverrides from project + user settings.
 * Project (.pi/settings.json) wins per-key over user (~/.pi/agent/settings.json).
 */
async function loadAgentOverrides(cwd) {
  const userSettings = await readJsonSafe(join(homedir(), ".pi/agent/settings.json"));
  const projectSettings = await readJsonSafe(join(cwd, ".pi/settings.json"));
  const userOverrides = userSettings?.subagents?.agentOverrides ?? {};
  const projectOverrides = projectSettings?.subagents?.agentOverrides ?? {};
  const merged = {};
  for (const [name, fields] of Object.entries(userOverrides)) {
    merged[name] = { ...fields };
  }
  for (const [name, fields] of Object.entries(projectOverrides)) {
    merged[name] = { ...(merged[name] ?? {}), ...fields };
  }
  return merged;
}

/**
 * Read the agent's source markdown. Order:
 *   1. project-local: `<cwd>/.pi/agents/<name>.md`
 *   2. user-scope:    `~/.pi/agent/agents/<name>.md`
 *   3. pi-subagents builtin: walk npm globals to find
 *      `<npm-root>/pi-subagents/agents/<name>.md`
 * Returns null if not found anywhere.
 */
async function loadAgentSource(cwd, name) {
  const candidates = [
    join(cwd, ".pi/agents", `${name}.md`),
    join(homedir(), ".pi/agent/agents", `${name}.md`),
    ...findBuiltinAgentDirs().map((d) => join(d, `${name}.md`)),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Locate pi-subagents' builtin `agents/` directory across common npm
 * global install locations (mirrors the strategy in pi-spawn.mjs#findPiBinScript).
 */
function findBuiltinAgentDirs() {
  const roots = collectGlobalRoots();
  const dirs = [];
  for (const r of roots) {
    const d = join(r, "pi-subagents/agents");
    if (existsSync(d)) dirs.push(d);
  }
  return dirs;
}

function collectGlobalRoots() {
  const roots = [];
  try {
    const out = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (out) roots.push(out);
  } catch {
    // npm not on PATH
  }
  const home = homedir();
  if (home) roots.push(join(home, ".npm-global/lib/node_modules"));
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");
  if (home) {
    const nvmDir = join(home, ".nvm/versions/node");
    if (existsSync(nvmDir)) {
      try {
        for (const v of execSync(`ls "${nvmDir}"`, { stdio: ["ignore", "pipe", "ignore"] })
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

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function formatYamlScalar(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return String(v);
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// args.mjs — parser for /pi:* slash command arguments.
//
// Mirrors pi-subagents' slash-command grammar (so muscle memory transfers
// between Claude Code and a pi session):
//
//   AGENT_SPEC   := IDENT '[' TASK ']'       e.g.   worker[fix the bug]
//   INLINE_CFG   := '[' KEYVALS ']'          e.g.   [model=claude-opus-4-6,fork=true]
//   FLAG         := '--name' [VALUE]         e.g.   --bg, --model claude-opus-4-6
//
// The shell does the first level of splitting; we receive args as a string[]
// already. Quoted task strings (`"..."`) lose their quotes to the shell and
// arrive as one shell-token containing brackets — that's the AGENT_SPEC case.
// Bare task tokens (no brackets) arrive as multiple shell-tokens that we
// re-join with spaces.

const FLAG_RE = /^--([a-zA-Z][a-zA-Z0-9-]*)$/;
const AGENT_SPEC_RE = /^([a-zA-Z][a-zA-Z0-9_-]*)\[(.+)\]$/s;
const INLINE_CFG_RE = /^\[([^\]]+)\]$/;
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

const FLAGS_VALUED = new Set(["model", "cwd", "mcp"]);
const FLAGS_BOOLEAN = new Set(["bg", "wait", "fork", "worktree", "yes"]);
// Common guesses that map to canonical flag names so users don't get
// punished for idiomatic intuition (--foreground/--background are the
// natural way to say "run synchronously" / "run detached").
const FLAG_ALIASES = {
  background: "bg",
  foreground: "wait",
  sync: "wait",
  async: "bg",
  detach: "bg",
  detached: "bg",
};

/**
 * Parse the argv slice for a given action.
 *
 * @param {"run"|"status"|"result"|"cancel"|"setup"} action
 * @param {string[]} argv
 * @returns {{ payload: object, flags: object, raw: string[] }}
 *
 * Throws on invalid input. The error message is user-facing (printed to
 * stderr by the broker).
 */
export function parseArgs(action, argv) {
  const { positional, flags } = splitFlags(argv);

  switch (action) {
    case "run":
      return { payload: parseRun(positional, flags), flags, raw: argv };
    case "status":
    case "result":
    case "cancel":
      return {
        payload: parseSingleId(action, positional),
        flags,
        raw: argv,
      };
    case "setup":
      return { payload: { action: "setup" }, flags, raw: argv };
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

function splitFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const match = FLAG_RE.exec(tok);
    if (!match) {
      positional.push(tok);
      continue;
    }
    const name = FLAG_ALIASES[match[1]] ?? match[1];
    if (FLAGS_BOOLEAN.has(name)) {
      flags[name] = true;
    } else if (FLAGS_VALUED.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || FLAG_RE.test(next)) {
        throw new Error(`flag --${name} requires a value`);
      }
      flags[name] = next;
      i++;
    } else {
      const all = [...FLAGS_BOOLEAN, ...FLAGS_VALUED].sort();
      const suggestion = closestFlag(name, all);
      throw new Error(
        `unknown flag: --${name}${suggestion ? ` (did you mean --${suggestion}?)` : ""}\n` +
          `  valid flags: ${all.map((f) => `--${f}`).join(", ")}`,
      );
    }
  }
  // Resolve --bg/--wait into a single mode. Default: bg.
  if (flags.bg && flags.wait) {
    throw new Error("--bg and --wait are mutually exclusive");
  }
  flags.background = flags.wait ? false : true;
  return { positional, flags };
}

function parseRun(positional, flags) {
  if (positional.length === 0) {
    throw new Error("/pi:run expects an agent name (e.g. /pi:run worker \"fix bug\")");
  }

  // Form 1: agent[task]
  const head = positional[0];
  const specMatch = AGENT_SPEC_RE.exec(head);

  let agent;
  let task;
  let inlineConfig = {};
  let rest;

  if (specMatch) {
    agent = specMatch[1];
    task = specMatch[2].trim();
    rest = positional.slice(1);
  } else {
    if (!IDENT_RE.test(head)) {
      throw new Error(`agent name must match [A-Za-z_][\\w-]*, got: ${head}`);
    }
    agent = head;
    rest = positional.slice(1);
  }

  // Optional inline config: a single [k=v,...] token immediately after.
  if (rest.length > 0) {
    const cfg = INLINE_CFG_RE.exec(rest[0]);
    if (cfg && !AGENT_SPEC_RE.test(rest[0])) {
      inlineConfig = parseInlineConfig(cfg[1]);
      rest = rest.slice(1);
    }
  }

  // Remaining tokens form the task body (only if task wasn't already set).
  if (task === undefined) {
    if (rest.length === 0) {
      throw new Error(`/pi:run ${agent} expects a task description`);
    }
    task = rest.join(" ").trim();
  } else if (rest.length > 0) {
    // If the user passed both agent[task] AND extra free text, append it.
    task = `${task} ${rest.join(" ")}`.trim();
  }

  return {
    action: "run",
    agent,
    task,
    background: flags.background,
    fork: !!flags.fork,
    worktree: !!flags.worktree,
    model: flags.model ?? inlineConfig.model,
    cwd: flags.cwd ?? inlineConfig.cwd,
    mcp: parseMcpList(flags.mcp),
    config: inlineConfig,
  };
}

/**
 * --mcp accepts comma-separated entries. Each entry can be either
 *   "server/tool"   — short form
 *   "mcp:server/tool" — leading prefix is stripped
 * Returns a normalized array of "server/tool" strings (no "mcp:" prefix).
 * Returns null when the flag wasn't passed at all so callers can tell
 * "user didn't ask for MCP" from "user wants 0 mcp tools" (which we
 * treat the same — null).
 */
export function parseMcpList(raw) {
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^mcp:/, ""))
    .filter(Boolean);
}

function parseSingleId(action, positional) {
  if (action === "status" && positional.length === 0) {
    return { action, id: null };
  }
  if (positional.length === 0) {
    throw new Error(`/pi:${action} expects a job id`);
  }
  if (positional.length > 1) {
    throw new Error(`/pi:${action} takes one id (got ${positional.length})`);
  }
  return { action, id: positional[0] };
}

function parseInlineConfig(body) {
  const out = {};
  for (const pair of body.split(",")) {
    const [k, v] = pair.split("=");
    if (!k || v === undefined) {
      throw new Error(`malformed inline config entry: "${pair}"`);
    }
    out[k.trim()] = parseScalar(v.trim());
  }
  return out;
}

function parseScalar(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Pick the candidate flag closest to `typo` using a tiny Levenshtein.
 * Prefers prefix completions (e.g. "workt" → "worktree") over
 * arbitrarily close substitutions ("workt" → "fork"). Returns null if
 * no candidate is within edit distance 3.
 */
function closestFlag(typo, candidates) {
  // Prefer a prefix completion if any candidate starts with typo.
  const prefixHit = candidates.find((c) => c.length > typo.length && c.startsWith(typo));
  if (prefixHit) return prefixHit;

  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = editDistance(typo, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= 3 ? best : null;
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// args.mjs — parser for /pi:* slash command arguments.
//
// Mirrors pi-subagents' slash-command grammar (so muscle memory transfers
// between Claude Code and a pi session):
//
//   AGENT_SPEC   := IDENT '[' TASK ']'       e.g.   worker[fix the bug]
//   INLINE_CFG   := '[' KEYVALS ']'          e.g.   [model=claude-opus-4-6,fork=true]
//   CHAIN_SEP    := '->'                     between chain steps
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

const FLAGS_VALUED = new Set(["model", "cwd"]);
const FLAGS_BOOLEAN = new Set(["bg", "wait", "fork", "worktree", "yes"]);

/**
 * Parse the argv slice for a given action.
 *
 * @param {"run"|"chain"|"parallel"|"status"|"result"|"cancel"|"setup"} action
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
    case "chain":
      return { payload: parseChain(positional, flags), flags, raw: argv };
    case "parallel":
      return { payload: parseParallel(positional, flags), flags, raw: argv };
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
    const name = match[1];
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
      throw new Error(`unknown flag: --${name}`);
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
    model: flags.model ?? inlineConfig.model,
    cwd: flags.cwd ?? inlineConfig.cwd,
    config: inlineConfig,
  };
}

function parseChain(positional, flags) {
  if (positional.length === 0) {
    throw new Error("/pi:chain expects at least one step");
  }
  const steps = [];
  let current = [];
  for (const tok of positional) {
    if (tok === "->") {
      steps.push(parseChainStep(current));
      current = [];
    } else {
      current.push(tok);
    }
  }
  if (current.length > 0) steps.push(parseChainStep(current));
  if (steps.length === 0) throw new Error("/pi:chain produced zero steps");

  return {
    action: "chain",
    steps,
    background: flags.background,
    fork: !!flags.fork,
    model: flags.model,
    cwd: flags.cwd,
  };
}

function parseChainStep(tokens) {
  if (tokens.length === 0) throw new Error("empty chain step");
  const head = tokens[0];
  const specMatch = AGENT_SPEC_RE.exec(head);
  if (specMatch) {
    const extras = tokens.slice(1).join(" ").trim();
    const task = extras ? `${specMatch[2].trim()} ${extras}` : specMatch[2].trim();
    return { agent: specMatch[1], task };
  }
  if (!IDENT_RE.test(head)) {
    throw new Error(`chain step must start with an agent name, got: ${head}`);
  }
  if (tokens.length < 2) {
    throw new Error(`chain step "${head}" needs a task description`);
  }
  return { agent: head, task: tokens.slice(1).join(" ").trim() };
}

function parseParallel(positional, flags) {
  if (positional.length === 0) {
    throw new Error("/pi:parallel expects at least one agent[task] item");
  }
  const tasks = [];
  for (const tok of positional) {
    const specMatch = AGENT_SPEC_RE.exec(tok);
    if (!specMatch) {
      throw new Error(
        `/pi:parallel items must use agent["task"] form (got: ${tok}). ` +
          "Use /pi:run or /pi:chain for free-form task strings.",
      );
    }
    tasks.push({ agent: specMatch[1], task: specMatch[2].trim() });
  }
  return {
    action: "parallel",
    tasks,
    worktree: !!flags.worktree,
    background: flags.background,
    model: flags.model,
    cwd: flags.cwd,
  };
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

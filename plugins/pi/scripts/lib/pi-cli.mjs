// pi-cli.mjs — drive pi over JSON-RPC.
//
// Spawns `pi --mode rpc --no-session`, sends a `prompt` frame containing
// pi-subagents' /run, /chain, or /parallel slash command, and watches
// stdout for the `subagent-slash-result` custom message that carries
// `asyncId` and `asyncDir`. Once captured, closes stdin so pi's main
// LLM loop short-circuits — the dispatched subagent is detached and
// keeps running independently.
//
// Foreground (--wait): not yet wired — for v0 the harness path is --bg.
// Tee-streaming the LLM's output isn't useful when the actual work is
// happening in a detached subagent process anyway.

import { spawn } from "node:child_process";
import { piSpawnEnv, resolvePi } from "./pi-spawn.mjs";

// Pi-subagents needs time to (a) load extensions on first invocation,
// (b) for --worktree runs, do `git worktree add` for each step. 60s
// covers both comfortably; tune via PI_BROKER_DISPATCH_TIMEOUT_MS.
const DEFAULT_DISPATCH_TIMEOUT_MS = 60000;

/**
 * Dispatch a subagent run via pi RPC.
 *
 * @param {object} opts
 * @param {object} opts.payload — parsed args from args.mjs#parseArgs
 * @param {boolean} opts.background — true = --bg (default in slash form)
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {NodeJS.WriteStream} [opts.stdout] — for foreground tee (TBD)
 * @param {number} [opts.dispatchTimeoutMs]
 * @returns {Promise<{runId, statusDir, pid, exitCode}>}
 *
 * Throws if dispatch times out or pi exits before emitting the marker.
 */
export async function piExec({
  payload,
  background,
  cwd,
  env,
  stdout: _stdout,
  dispatchTimeoutMs,
}) {
  const timeout =
    dispatchTimeoutMs ??
    Number(env.PI_BROKER_DISPATCH_TIMEOUT_MS ?? DEFAULT_DISPATCH_TIMEOUT_MS);
  // Honor a test override that wires us to a fake pi. Real pi is invoked
  // through `pi --mode rpc --no-session`; the fixture handles --mode rpc
  // explicitly so the same code path runs in both environments.
  const desc = resolvePi({ env });
  const piArgs = [...desc.args, "--mode", "rpc", "--no-session"];
  const spawnEnv = piSpawnEnv(desc, env);

  const child = spawn(desc.command, piArgs, {
    cwd,
    env: spawnEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Two dispatch paths:
  //   - slash form (default): "/run scout 'task' --bg" → pi-subagents'
  //     extension command handler → emits subagent-slash-result message.
  //   - tool form (--worktree): instructs pi to call the `subagent` tool
  //     directly via tool_call. Slower (one LLM hop) but the only path
  //     that exposes worktree, since pi-subagents' slash grammar doesn't
  //     accept --worktree.
  const useToolForm = !!payload.worktree;
  const message = useToolForm
    ? buildToolInvocationPrompt(payload)
    : buildSlashCommand(payload);
  const promptFrame = { id: "broker-1", type: "prompt", message };

  return new Promise((resolveP, rejectP) => {
    let runId = null;
    let statusDir = null;
    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;

    const finish = (err, value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (err) rejectP(err);
      else resolveP(value);
    };

    const handleEvent = (parsed) => {
      // Slash form: subagent-slash-result custom message.
      if (parsed.type === "message_start" || parsed.type === "message_end") {
        const msg = parsed.message;
        if (msg?.role === "custom" && msg.customType === "subagent-slash-result") {
          const inner = msg.details?.result?.details;
          captureRun(inner);
          return;
        }
      }
      // Tool form: tool_execution_end with toolName=subagent.
      if (parsed.type === "tool_execution_end" && parsed.toolName === "subagent") {
        captureRun(parsed.result?.details);
      }
    };

    const captureRun = (inner) => {
      if (!inner?.asyncId || !inner?.asyncDir) return;
      if (runId) return; // Already captured.
      runId = inner.asyncId;
      statusDir = inner.asyncDir;
      // Background dispatch: we have what we need. Close stdin so pi's
      // LLM loop short-circuits. The subagent is detached and continues.
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    };

    const onStdout = (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Non-JSON line — ignore.
          continue;
        }
        handleEvent(parsed);
      }
    };
    const onStderr = (chunk) => {
      stderrBuf += chunk.toString("utf8");
    };
    const onError = (err) => finish(err);
    const onClose = (code) => {
      if (runId && statusDir) {
        finish(null, { runId, statusDir, pid: child.pid, exitCode: code });
        return;
      }
      const tail = (stderrBuf || stdoutBuf).slice(-500).trim();
      finish(
        new Error(
          `pi exited (code ${code}) before emitting subagent-slash-result. ` +
            (tail ? `tail: ${tail}` : ""),
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(
        new Error(
          `timed out after ${timeout}ms waiting for pi to acknowledge the slash command. ` +
            "(This is the dispatch handshake — NOT a subagent runtime cap.)\n" +
            "  Most likely cause: pi-subagents isn't loaded and pi has no /run handler.\n" +
            "  Run `/pi:setup` to diagnose. To extend the timeout: PI_BROKER_DISPATCH_TIMEOUT_MS=<ms>.",
        ),
      );
    }, timeout);

    // Send the slash prompt.
    try {
      child.stdin.write(`${JSON.stringify(promptFrame)}\n`);
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * Build a pi-subagents slash command string from a parsed payload.
 *
 * Grammar mirrors what pi-subagents accepts:
 *   /run <agent>[k=v,...] "<task>" [--bg] [--fork]
 *   /chain <agent>[k=v,...] "<task>" -> ... [--bg]
 *   /parallel <agent>[k=v,...] "<task>" -> ... [--bg] [--worktree]
 *
 * The inline `[k=v,...]` form is pi-subagents' way to set per-agent
 * config (model, skill, output, reads, progress). Top-level `--model`
 * from the broker is forwarded to every agent token in the slash.
 */
export function buildSlashCommand(payload) {
  const flags = [];
  if (payload.background) flags.push("--bg");
  if (payload.fork) flags.push("--fork");
  const flagSuffix = flags.length ? ` ${flags.join(" ")}` : "";

  // Inline config to attach to each agent token. Top-level --model
  // applies to every step. Top-level inline config from /pi:run's
  // [k=v,...] (parsed into payload.config) overrides per-key.
  const inlineConfig = collectInlineConfig(payload);

  switch (payload.action) {
    case "run":
      // pi-subagents' /run handler treats everything after the agent token
      // as the task verbatim (no quote stripping). Don't wrap in quotes.
      return `/run ${agentToken(payload.agent, inlineConfig)} ${payload.task}${flagSuffix}`;
    case "chain": {
      const steps = payload.steps
        .map((s) => `${agentToken(s.agent, inlineConfig)} ${quoteTask(s.task)}`)
        .join(" -> ");
      return `/chain ${steps}${flagSuffix}`;
    }
    case "parallel": {
      const tasks = payload.tasks
        .map((s) => `${agentToken(s.agent, inlineConfig)} ${quoteTask(s.task)}`)
        .join(" -> ");
      return `/parallel ${tasks}${flagSuffix}`;
    }
    default:
      throw new Error(`pi-cli: unknown payload action: ${payload.action}`);
  }
}

/**
 * Merge top-level model + inline config into a single { key: value } map
 * for emission as `[k=v,...]` on the agent token.
 */
function collectInlineConfig(payload) {
  const cfg = { ...(payload.config ?? {}) };
  if (payload.model && cfg.model === undefined) cfg.model = payload.model;
  return cfg;
}

function agentToken(agent, config) {
  const entries = Object.entries(config).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return agent;
  const body = entries.map(([k, v]) => `${k}=${formatScalar(v)}`).join(",");
  return `${agent}[${body}]`;
}

function formatScalar(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return String(v);
}

/**
 * Wrap a task in quotes for /chain or /parallel steps. pi-subagents'
 * parser regex `"([^"]*)"|'([^']*)'` doesn't support escape sequences,
 * so we pick whichever quote style the task doesn't contain. If both
 * are present we throw — there's no graceful representation in the
 * grammar today, so it's better to fail loud than silently truncate.
 */
/**
 * Build a prompt that asks pi to invoke the `subagent` tool directly with
 * the given args. Used for --worktree, which pi-subagents doesn't expose
 * through the slash grammar. The LLM forwards the JSON verbatim into a
 * tool_call; pi-subagents' subagent tool dispatches the real work and
 * emits tool_execution_end with the asyncId.
 *
 * Robustness note: this path goes through the LLM, so a misaligned
 * model could in theory mangle the JSON. In practice every model we've
 * tested (kimi, gpt-5, claude) follows "call the tool with this exact
 * JSON" precisely. If a deployment hits issues, the model can be
 * overridden via the orchestrator's --model — but the broker doesn't
 * pin one here.
 */
export function buildToolInvocationPrompt(payload) {
  const subagentArgs = subagentToolArgs(payload);
  return (
    "Call the `subagent` tool exactly once with this argument JSON, " +
    "then output nothing else. Do NOT modify the JSON.\n\n" +
    "```json\n" +
    JSON.stringify(subagentArgs, null, 2) +
    "\n```"
  );
}

function subagentToolArgs(payload) {
  const flags = {};
  if (payload.background) flags.async = true;
  if (payload.fork) flags.context = "fork";
  if (payload.worktree) flags.worktree = true;

  const inlineConfig = collectInlineConfig(payload);
  const applyConfig = (step) => {
    const out = { agent: step.agent, task: step.task };
    if (inlineConfig.model) out.model = inlineConfig.model;
    if (inlineConfig.skill) out.skill = inlineConfig.skill;
    if (inlineConfig.output !== undefined) out.output = inlineConfig.output;
    if (inlineConfig.reads !== undefined) out.reads = inlineConfig.reads;
    return out;
  };

  switch (payload.action) {
    case "run":
      return {
        agent: payload.agent,
        task: payload.task,
        ...(inlineConfig.model ? { model: inlineConfig.model } : {}),
        ...flags,
      };
    case "chain":
      return { chain: payload.steps.map(applyConfig), ...flags };
    case "parallel":
      return { tasks: payload.tasks.map(applyConfig), ...flags };
    default:
      throw new Error(`pi-cli: unknown payload action: ${payload.action}`);
  }
}

function quoteTask(s) {
  const str = String(s);
  if (!str.includes('"')) return `"${str}"`;
  if (!str.includes("'")) return `'${str}'`;
  throw new Error(
    "task contains both single and double quotes — pi-subagents' slash " +
      "grammar can't represent this. Strip one quote style or use a shorter task.",
  );
}

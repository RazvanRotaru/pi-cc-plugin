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

const DEFAULT_DISPATCH_TIMEOUT_MS = 15000;

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
  dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
}) {
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

  const slash = buildSlashCommand(payload);
  const promptFrame = { id: "broker-1", type: "prompt", message: slash };

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
      // The interesting marker arrives as a `message_start` (or _end) with
      // role=custom, customType=subagent-slash-result.
      if (parsed.type !== "message_start" && parsed.type !== "message_end") return;
      const msg = parsed.message;
      if (msg?.role !== "custom") return;
      if (msg.customType !== "subagent-slash-result") return;
      const inner = msg.details?.result?.details;
      if (!inner?.asyncId || !inner?.asyncDir) return;
      if (runId) return; // Already captured.
      runId = inner.asyncId;
      statusDir = inner.asyncDir;
      // Background dispatch: we have what we need. Close stdin so pi's
      // LLM loop short-circuits without running the prompt itself.
      // The subagent is detached and continues regardless.
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
          `timed out after ${dispatchTimeoutMs}ms waiting for subagent-slash-result`,
        ),
      );
    }, dispatchTimeoutMs);

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
 *   /run <agent> "<task>" [--bg] [--fork]
 *   /chain <agent> "<task>" -> <agent> "<task>" ... [--bg]
 *   /parallel <agent> "<task>" -> <agent> "<task>" ... [--bg] [--worktree]
 */
export function buildSlashCommand(payload) {
  const flags = [];
  if (payload.background) flags.push("--bg");
  if (payload.fork) flags.push("--fork");
  if (payload.worktree) flags.push("--worktree");
  const flagSuffix = flags.length ? ` ${flags.join(" ")}` : "";

  switch (payload.action) {
    case "run":
      return `/run ${payload.agent} ${quote(payload.task)}${flagSuffix}`;
    case "chain": {
      const steps = payload.steps.map((s) => `${s.agent} ${quote(s.task)}`).join(" -> ");
      return `/chain ${steps}${flagSuffix}`;
    }
    case "parallel": {
      const tasks = payload.tasks.map((s) => `${s.agent} ${quote(s.task)}`).join(" -> ");
      return `/parallel ${tasks}${flagSuffix}`;
    }
    default:
      throw new Error(`pi-cli: unknown payload action: ${payload.action}`);
  }
}

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

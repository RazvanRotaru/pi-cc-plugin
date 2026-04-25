// pi-cli.mjs — spawns pi and parses its launch markers.
//
// Background mode: spawn detached, read run-id + status-dir markers from
// stdout, unref, return immediately.
//
// Foreground (--wait) mode: spawn with stdio piped, tee stdout to ours,
// still capture markers, await exit.
//
// Markers (per docs/PI_INVOCATION.md §4 — fixture-default until verified):
//   run-id: <uuid>
//   status-dir: <abs-path>
//
// Real pi may emit these on stderr or via different keys. Adjust this file
// (and the parser below) when the real-pi contract is verified.

import { spawn } from "node:child_process";
import { piSpawnEnv, resolvePi } from "./pi-spawn.mjs";

const RUN_ID_RE = /^run-id:\s*(\S+)\s*$/;
const STATUS_DIR_RE = /^status-dir:\s*(\S.*?)\s*$/;
const DEFAULT_MARKER_TIMEOUT_MS = 5000;

/**
 * Spawn pi to execute one `subagent` payload.
 *
 * @param {object} opts
 * @param {object} opts.payload    — the JSON payload (e.g. {action:"run",...})
 * @param {boolean} opts.background — true: detach + return on markers; false: wait for exit
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {NodeJS.WriteStream} [opts.stdout]
 * @param {number} [opts.markerTimeoutMs]
 * @returns {Promise<{runId: string, statusDir: string, pid: number, exitCode: number|null}>}
 */
export async function piExec({
  payload,
  background,
  cwd,
  env,
  stdout,
  markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
}) {
  const desc = resolvePi({ env });
  const fullArgs = [...desc.args, "exec", JSON.stringify(payload)];
  const spawnEnv = piSpawnEnv(desc, env);

  const child = spawn(desc.command, fullArgs, {
    cwd,
    env: spawnEnv,
    detached: background,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const markers = collectMarkers(child, { tee: !background ? stdout : null, timeoutMs: markerTimeoutMs });

  if (background) {
    const result = await markers;
    child.unref();
    return { ...result, pid: child.pid, exitCode: null };
  }

  const [result, exitCode] = await Promise.all([
    markers,
    new Promise((res, rej) => {
      child.on("error", rej);
      child.on("close", (code) => res(code));
    }),
  ]);
  return { ...result, pid: child.pid, exitCode };
}

/**
 * Read stdout/stderr line by line until both run-id and status-dir markers
 * are seen, or timeout. Optionally tees stdout lines to `tee`.
 */
function collectMarkers(child, { tee, timeoutMs }) {
  return new Promise((resolveP, rejectP) => {
    let runId = null;
    let statusDir = null;
    let timer = null;
    let stdoutBuf = "";
    let stderrBuf = "";

    const finish = (err) => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (err) rejectP(err);
      else resolveP({ runId, statusDir });
    };

    const checkLine = (line) => {
      const idMatch = RUN_ID_RE.exec(line);
      if (idMatch) {
        runId = idMatch[1];
        return true;
      }
      const dirMatch = STATUS_DIR_RE.exec(line);
      if (dirMatch) {
        statusDir = dirMatch[1];
        return true;
      }
      return false;
    };

    const consumeBuf = (buf, source) => {
      let next = buf;
      while (true) {
        const nl = next.indexOf("\n");
        if (nl === -1) return next;
        const line = next.slice(0, nl);
        next = next.slice(nl + 1);
        const matched = checkLine(line);
        if (!matched && source === "stdout" && tee) {
          tee.write(`${line}\n`);
        }
        if (runId && statusDir) {
          // Forward the rest of stdoutBuf if we're teeing.
          if (source === "stdout" && tee && next.length) tee.write(next);
          stdoutBuf = source === "stdout" ? "" : stdoutBuf;
          finish();
          return next;
        }
      }
    };

    const onStdout = (chunk) => {
      stdoutBuf = consumeBuf(stdoutBuf + chunk.toString("utf8"), "stdout");
    };
    const onStderr = (chunk) => {
      stderrBuf = consumeBuf(stderrBuf + chunk.toString("utf8"), "stderr");
    };
    const onError = (err) => finish(err);
    const onClose = (code) => {
      // pi exited before emitting markers. If both seen via partial buf,
      // still resolve; otherwise fail with stderr tail.
      if (runId && statusDir) return finish();
      const tail = (stderrBuf || stdoutBuf).slice(-500).trim();
      finish(
        new Error(
          `pi exited (code ${code}) before emitting run-id+status-dir markers. ` +
            (tail ? `tail: ${tail}` : ""),
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);

    timer = setTimeout(() => {
      finish(
        new Error(
          `timed out after ${timeoutMs}ms waiting for pi run-id/status-dir markers`,
        ),
      );
    }, timeoutMs);
  });
}

#!/usr/bin/env node
// fake-pi — stand-in for the real `pi` CLI.
//
// Implements only the parts of the pi contract documented in
// docs/PI_INVOCATION.md that the broker actually calls. Same pattern
// codex-plugin-cc uses with its fake-codex fixture.
//
// Recognized invocations:
//   fake-pi --version
//   fake-pi list                              (settings.packages — for setup-checks)
//   fake-pi list-extensions [--json]          (legacy alias kept for compat)
//   fake-pi --mode rpc --no-session           (the main path; reads JSONL prompts on stdin)
//
// Behavior of `--mode rpc`:
//   For each line on stdin parsed as JSON with type=prompt + a /run|/chain|/parallel
//   slash command, emit an RPC `subagent-slash-result` custom message carrying
//   asyncId + asyncDir, then create the async dir with status.json,
//   output-0.log, and subagent-log-<runId>.md per the verified contract.
//
// Env knobs (override per test):
//   FAKE_PI_SCENARIO=happy|crash|timeout|stale-dir|bad-json|fail
//   FAKE_PI_RUN_ID=<id>                       — override the runId
//   FAKE_PI_TMPDIR=<path>                     — base for the async dir
//   FAKE_PI_DELAY_MS=<n>                      — sleep before completing (background only)
//   FAKE_PI_EXIT_CODE=<n>                     — pi's outer exit code
//   FAKE_PI_NO_MARKERS=1                      — exit before emitting subagent-slash-result
//   FAKE_PI_INSTALLED=1|0                     — toggle pi-subagents in `pi list` output
//   FAKE_PI_HANG_ON_TERM=<ms>                 — ignore SIGTERM for N ms (M5 cancel test)

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("fake-pi 0.1.0\n");
  process.exit(0);
}

if (argv[0] === "list" || argv[0] === "list-extensions") {
  const installed = process.env.FAKE_PI_INSTALLED !== "0";
  if (argv[0] === "list-extensions" && argv.includes("--json")) {
    const data = installed ? [{ name: "pi-subagents", version: "0.0.0" }] : [];
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else if (argv[0] === "list") {
    if (installed) {
      process.stdout.write("User packages:\n  npm:pi-subagents\n");
    } else {
      process.stdout.write("No packages installed.\n");
    }
  } else {
    if (installed) process.stdout.write("pi-subagents@0.0.0\n");
  }
  process.exit(0);
}

if (argv[0] === "--mode" && argv[1] === "rpc") {
  await runRpcMode();
  process.exit(Number(process.env.FAKE_PI_EXIT_CODE ?? 0));
}

// Default: ack so accidental invocations don't fail tests in confusing ways.
process.stdout.write(`${JSON.stringify({ ok: true, fake_pi: true, argv })}\n`);
process.exit(0);

async function runRpcMode() {
  const scenario = process.env.FAKE_PI_SCENARIO ?? "happy";

  if (scenario === "crash" || process.env.FAKE_PI_NO_MARKERS === "1") {
    process.stderr.write("fake-pi: crash before subagent-slash-result\n");
    process.exit(3);
  }

  // Optionally ignore SIGTERM (M5 cancel-escalation test).
  const hang = Number(process.env.FAKE_PI_HANG_ON_TERM ?? 0);
  if (hang > 0) {
    process.on("SIGTERM", () => {
      setTimeout(() => process.exit(143), hang);
    });
  }

  // Read JSONL prompts on stdin until EOF.
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      handleFrame(line, scenario);
    }
  });

  return new Promise((resolveP) => {
    process.stdin.on("end", resolveP);
  });
}

function handleFrame(line, scenario) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (parsed.type !== "prompt") return;

  const slash = parseSlashCommand(parsed.message ?? "");
  if (!slash) return;

  const runId = process.env.FAKE_PI_RUN_ID ?? randomId();
  const tmp = process.env.FAKE_PI_TMPDIR ?? tmpdir();
  const asyncDir = join(tmp, "pi-subagents-uid-1000/async-subagent-runs", runId);

  if (scenario !== "stale-dir") {
    mkdirSync(asyncDir, { recursive: true });
    writeStatus(asyncDir, {
      runId,
      mode: slash.mode,
      state: "running",
      lastActivityAt: Date.now(),
      startedAt: Date.now(),
      pid: process.pid,
      cwd: process.cwd(),
      currentStep: 0,
      steps: stepsFromSlash(slash, "running"),
    });
    if (scenario === "bad-json") {
      writeFileSync(join(asyncDir, "status.json"), "{not-json", "utf8");
    }
  }

  // Emit the message_start carrying the slash result.
  emitFrame({
    type: "message_start",
    message: {
      role: "custom",
      customType: "subagent-slash-result",
      content: `Async: ${slash.mode}`,
      details: {
        result: {
          content: [{ type: "text", text: `Async: ${slash.mode}` }],
          details: {
            mode: slash.mode,
            results: [],
            asyncId: runId,
            asyncDir,
          },
        },
      },
      timestamp: Date.now(),
    },
  });
  emitFrame({ type: "message_end", message: { role: "custom", customType: "subagent-slash-result" } });
  emitFrame({ id: parsed.id, type: "response", command: "prompt", success: true });

  const delay = Number(process.env.FAKE_PI_DELAY_MS ?? 0);

  const finalize = () => {
    if (scenario === "stale-dir" || scenario === "bad-json") return;
    writeFileSync(
      join(asyncDir, "output-0.log"),
      buildOutput(slash),
      "utf8",
    );
    writeFileSync(
      join(asyncDir, `subagent-log-${runId}.md`),
      `# fake-pi log for ${runId}\n\n${buildOutput(slash)}\n`,
      "utf8",
    );
    writeStatus(asyncDir, {
      runId,
      mode: slash.mode,
      state: scenario === "fail" ? "failed" : "complete",
      startedAt: Date.now(),
      endedAt: Date.now(),
      pid: process.pid,
      cwd: process.cwd(),
      currentStep: 0,
      steps: stepsFromSlash(slash, scenario === "fail" ? "failed" : "complete"),
      error: scenario === "fail" ? "fake failure" : null,
    });
  };

  if (scenario === "timeout") {
    // Stay in "running" forever — broker should give up via its own timer
    // or the test should cancel.
    return;
  }

  if (delay > 0) {
    setTimeout(finalize, delay);
  } else {
    finalize();
  }
}

function parseSlashCommand(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;
  const cmdMatch = /^\/(\w+)/.exec(trimmed);
  if (!cmdMatch) return null;
  const cmd = cmdMatch[1];
  const tail = trimmed.slice(cmdMatch[0].length).trim();
  // Strip trailing flags so we can extract agents+tasks.
  const flagSplit = tail.split(/\s+--/);
  const body = flagSplit[0];
  switch (cmd) {
    case "run": {
      // <agent> "<task>"
      const m = /^(\S+)\s+"([\s\S]*)"\s*$/.exec(body);
      if (!m) return null;
      return { mode: "single", steps: [{ agent: m[1], task: unescape(m[2]) }] };
    }
    case "chain":
    case "parallel": {
      // <agent> "<task>" -> <agent> "<task>" -> ...
      const parts = body.split(" -> ").map((p) => p.trim()).filter(Boolean);
      const steps = [];
      for (const p of parts) {
        const m = /^(\S+)\s+"([\s\S]*)"\s*$/.exec(p);
        if (!m) return null;
        steps.push({ agent: m[1], task: unescape(m[2]) });
      }
      if (steps.length === 0) return null;
      return { mode: cmd, steps };
    }
    default:
      return null;
  }
}

function unescape(s) {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function stepsFromSlash(slash, status) {
  return slash.steps.map((s) => ({
    agent: s.agent,
    task: s.task,
    status,
    skills: [],
    model: "fake-pi/test",
  }));
}

function buildOutput(slash) {
  const parts = [];
  parts.push(`Task: ${slash.steps[0]?.task ?? ""}`);
  parts.push("---");
  parts.push("Lorem ipsum simulated output.");
  return parts.join("\n");
}

function writeStatus(dir, data) {
  writeFileSync(join(dir, "status.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function emitFrame(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function randomId() {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

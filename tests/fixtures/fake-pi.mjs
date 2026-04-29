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

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);

// Detached helper invocation: write the deferred finalize after a delay.
// Used by the FAKE_PI_DELAY_MS path so the parent fake-pi can exit fast
// (mimicking real pi's "orchestrator exits, subagent continues" model).
if (argv[0] === "__finalize") {
  await runFinalizeMode(argv.slice(1));
  process.exit(0);
}

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

  // Two prompt shapes from the broker:
  //   1. "/run agent task" / "/chain ..." / "/parallel ..."  — slash form
  //   2. "Call the `subagent` tool exactly once ... ```json {...} ```" — tool form
  const slash =
    parseSlashCommand(parsed.message ?? "") ?? parseToolInvocation(parsed.message ?? "");
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

  if (slash.via === "tool") {
    // Mimic real pi: emit a tool_execution_end carrying the asyncId/asyncDir.
    emitFrame({ id: parsed.id, type: "response", command: "prompt", success: true });
    emitFrame({
      type: "tool_execution_end",
      toolCallId: "fake.subagent:0",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: `Async: ${slash.mode}` }],
        details: {
          mode: slash.mode,
          results: [],
          asyncId: runId,
          asyncDir,
        },
      },
      isError: false,
    });
  } else {
    // Slash form: emit message_start/end with subagent-slash-result custom type.
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
    emitFrame({
      type: "message_end",
      message: { role: "custom", customType: "subagent-slash-result" },
    });
    emitFrame({ id: parsed.id, type: "response", command: "prompt", success: true });
  }

  const delay = Number(process.env.FAKE_PI_DELAY_MS ?? 0);

  if (scenario === "timeout") {
    // Stay in "running" forever — broker should give up via its own timer
    // or the test should cancel.
    return;
  }

  if (delay > 0) {
    // Mimic real pi: the orchestrator process exits quickly while the
    // subagent runs detached. Spawn an unref'd child that performs the
    // finalize after `delay` ms so this process can return to its
    // stdin-end handler immediately.
    scheduleDetachedFinalize({
      asyncDir,
      runId,
      slash,
      scenario,
      delayMs: delay,
    });
  } else {
    runFinalize({ asyncDir, runId, slash, scenario });
  }
}

function runFinalize({ asyncDir, runId, slash, scenario }) {
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
  // Mimic pi-subagents' events.jsonl tail. Real pi emits many more
  // events (one per child tool call, etc.); the broker just dumps them
  // through, so a tiny synthetic stream is enough to exercise the path.
  const ts = Date.now();
  const firstAgent = (slash.steps?.[0]?.agent) ?? "worker";
  const evLines = [
    { type: "subagent.run.started", ts, runId },
    { type: "subagent.step.started", ts, runId, stepIndex: 0, agent: firstAgent },
    {
      type: "subagent.run.completed",
      ts,
      runId,
      success: scenario !== "fail",
    },
  ];
  writeFileSync(
    join(asyncDir, "events.jsonl"),
    `${evLines.map((e) => JSON.stringify(e)).join("\n")}\n`,
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
}

async function runFinalizeMode(args) {
  const [asyncDir, runId, scenario, delayStr, slashJson] = args;
  const delayMs = Number(delayStr);
  const slash = JSON.parse(slashJson);
  await new Promise((r) => setTimeout(r, delayMs));
  runFinalize({ asyncDir, runId, slash, scenario });
}

function scheduleDetachedFinalize({ asyncDir, runId, slash, scenario, delayMs }) {
  const fakePiPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [fakePiPath, "__finalize", asyncDir, runId, scenario, String(delayMs), JSON.stringify(slash)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

function parseSlashCommand(message) {
  // Mirrors pi-subagents' real parser shape:
  //   /run <agent>[cfg] task...        (task is rest-of-line, no quotes)
  //   /chain <agent>[cfg] "task" -> <agent>[cfg] "task"   (or 'task')
  //   /parallel <agent>[cfg] "task" -> <agent>[cfg] "task"
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;
  const cmdMatch = /^\/(\w+)/.exec(trimmed);
  if (!cmdMatch) return null;
  const cmd = cmdMatch[1];
  const tail = trimmed.slice(cmdMatch[0].length).trim();
  // Strip trailing --bg/--fork/--worktree flags.
  const body = tail.replace(/\s+--(?:bg|fork|worktree)(?=\s|$)/g, "").trim();
  switch (cmd) {
    case "run": {
      // First whitespace-separated token = agent (with optional [cfg]).
      const firstSpace = body.indexOf(" ");
      if (firstSpace === -1) return null;
      const agentTok = body.slice(0, firstSpace);
      const task = body.slice(firstSpace + 1).trim();
      const { agent } = stripAgentConfig(agentTok);
      return { mode: "single", steps: [{ agent, task }] };
    }
    case "chain":
    case "parallel": {
      const parts = body.split(" -> ").map((p) => p.trim()).filter(Boolean);
      const steps = [];
      for (const p of parts) {
        // <agent>[cfg] "task"  or  <agent>[cfg] 'task'
        const m = /^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')\s*$/.exec(p);
        if (!m) return null;
        const { agent } = stripAgentConfig(m[1]);
        steps.push({ agent, task: m[2] ?? m[3] });
      }
      if (steps.length === 0) return null;
      return { mode: cmd, steps };
    }
    default:
      return null;
  }
}

/**
 * Recognize the broker's tool-invocation prompt shape:
 *   "Call the `subagent` tool exactly once with this argument JSON ...
 *    ```json
 *    {...}
 *    ```"
 * Returns a slash-shaped {mode, steps, via:"tool"} object (or null).
 */
function parseToolInvocation(message) {
  if (!/Call the `subagent` tool/i.test(message)) return null;
  const m = /```json\s*([\s\S]+?)\s*```/.exec(message);
  if (!m) return null;
  let args;
  try {
    args = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (Array.isArray(args.tasks)) {
    return {
      mode: "parallel",
      steps: args.tasks.map((t) => ({ agent: t.agent, task: t.task })),
      via: "tool",
    };
  }
  if (Array.isArray(args.chain)) {
    return {
      mode: "chain",
      steps: args.chain.map((s) => ({ agent: s.agent, task: s.task })),
      via: "tool",
    };
  }
  if (args.agent && args.task) {
    return {
      mode: "single",
      steps: [{ agent: args.agent, task: args.task }],
      via: "tool",
    };
  }
  return null;
}

function stripAgentConfig(tok) {
  const i = tok.indexOf("[");
  return i === -1 ? { agent: tok } : { agent: tok.slice(0, i) };
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

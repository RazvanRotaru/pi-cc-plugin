#!/usr/bin/env node
// fake-pi — stand-in for the real `pi` CLI used by the broker tests.
//
// Implements only the parts of the pi contract documented in
// docs/PI_INVOCATION.md that the broker actually calls. This is the same
// pattern codex-plugin-cc uses with its fake-codex fixture.
//
// Recognized invocations:
//   fake-pi --version
//   fake-pi list-extensions [--json]
//   fake-pi exec '<json-payload>'
//
// Behavior of `exec`:
//   - Print `run-id: <uuid>`     and `status-dir: <path>` to stdout.
//   - Create the status dir + status.json + result.md.
//   - Sleep FAKE_PI_DELAY_MS (default 0), then update status.json to
//     "completed" and exit FAKE_PI_EXIT_CODE (default 0).
//
// Env knobs (override per test):
//   FAKE_PI_SCENARIO=happy|crash|timeout|stale-dir|bad-json
//   FAKE_PI_RUN_ID=<id>
//   FAKE_PI_TMPDIR=<path>
//   FAKE_PI_DELAY_MS=<n>
//   FAKE_PI_EXIT_CODE=<n>
//   FAKE_PI_NO_MARKERS=1            — exit before emitting markers (test the timeout path)
//   FAKE_PI_PARTIAL_MARKERS=run-id  — emit only run-id (broker should error)
//   FAKE_PI_INSTALLED=1|0           — list-extensions toggles whether pi-subagents is "installed"
//   FAKE_PI_HANG_ON_TERM=<ms>       — ignore SIGTERM for N ms (used by M5 cancel-escalation tests)

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("fake-pi 0.1.0\n");
  process.exit(0);
}

if (argv[0] === "list-extensions") {
  const installed = process.env.FAKE_PI_INSTALLED !== "0";
  const data = installed ? [{ name: "pi-subagents", version: "0.0.0" }] : [];
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else {
    for (const ext of data) process.stdout.write(`${ext.name}@${ext.version}\n`);
  }
  process.exit(0);
}

if (argv[0] === "exec") {
  await runExec(argv[1] ?? "{}");
  process.exit(Number(process.env.FAKE_PI_EXIT_CODE ?? 0));
}

// Default: ack so accidental invocations don't fail tests in confusing ways.
process.stdout.write(`${JSON.stringify({ ok: true, fake_pi: true, argv })}\n`);
process.exit(0);

async function runExec(jsonPayload) {
  const scenario = process.env.FAKE_PI_SCENARIO ?? "happy";
  let payload;
  try {
    payload = JSON.parse(jsonPayload);
  } catch (err) {
    process.stderr.write(`fake-pi: bad JSON: ${err.message}\n`);
    process.exit(2);
  }

  if (scenario === "crash" || process.env.FAKE_PI_NO_MARKERS === "1") {
    process.stderr.write("fake-pi: crash before markers\n");
    process.exit(3);
  }

  const runId = process.env.FAKE_PI_RUN_ID ?? randomId();
  const tmp = process.env.FAKE_PI_TMPDIR ?? tmpdir();
  const slug = payload.agent ?? payload.action ?? "run";
  const statusDir = join(tmp, "pi-subagents-user/async-subagent-runs", `${runId}-${slug}`);

  if (scenario === "stale-dir") {
    // Don't create the status dir at all — tests will see "pi artifacts gone".
  } else {
    mkdirSync(statusDir, { recursive: true });
    writeStatus(statusDir, {
      id: runId,
      agent: payload.agent ?? null,
      kind: payload.action ?? "run",
      status: "running",
      started_at: nowIso(),
      completed_at: null,
      exit_code: null,
      error: null,
      steps: stepsFromPayload(payload),
    });
    if (scenario === "bad-json") {
      writeFileSync(join(statusDir, "status.json"), "{not-json", "utf8");
    }
  }

  // Emit markers (unless test asks for partial).
  const partial = process.env.FAKE_PI_PARTIAL_MARKERS;
  if (partial !== "status-dir-only") process.stdout.write(`run-id: ${runId}\n`);
  if (partial !== "run-id-only" && scenario !== "stale-dir") {
    process.stdout.write(`status-dir: ${statusDir}\n`);
  } else if (scenario === "stale-dir") {
    process.stdout.write(`status-dir: ${statusDir}\n`);
  }

  const delay = Number(process.env.FAKE_PI_DELAY_MS ?? 0);

  // Optionally ignore SIGTERM (M5 cancel-escalation test).
  const hang = Number(process.env.FAKE_PI_HANG_ON_TERM ?? 0);
  if (hang > 0) {
    process.on("SIGTERM", () => {
      // ignore for `hang` ms
      setTimeout(() => process.exit(143), hang);
    });
  }

  if (scenario === "timeout") {
    // Sleep way past anyone's patience, but writeStatus stays "running".
    await sleep(60_000);
    return;
  }

  if (delay > 0) await sleep(delay);

  if (scenario !== "stale-dir" && scenario !== "bad-json") {
    writeFileSync(join(statusDir, "result.md"), buildResultMd(payload, runId), "utf8");
    writeStatus(statusDir, {
      id: runId,
      agent: payload.agent ?? null,
      kind: payload.action ?? "run",
      status: scenario === "fail" ? "failed" : "completed",
      started_at: nowIso(),
      completed_at: nowIso(),
      exit_code: Number(process.env.FAKE_PI_EXIT_CODE ?? 0),
      error: scenario === "fail" ? "fake failure" : null,
      steps: completedSteps(payload),
    });
  }
}

function writeStatus(dir, data) {
  writeFileSync(join(dir, "status.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function stepsFromPayload(p) {
  if (p.action === "chain") return p.steps?.map((s) => ({ ...s, status: "pending" })) ?? [];
  if (p.action === "parallel") return p.tasks?.map((s) => ({ ...s, status: "pending" })) ?? [];
  return [];
}

function completedSteps(p) {
  if (p.action === "chain") return p.steps?.map((s) => ({ ...s, status: "completed" })) ?? [];
  if (p.action === "parallel") return p.tasks?.map((s) => ({ ...s, status: "completed" })) ?? [];
  return [];
}

function buildResultMd(payload, runId) {
  return [
    `# fake-pi result for ${runId}`,
    "",
    `**action:** ${payload.action}`,
    payload.agent ? `**agent:** ${payload.agent}` : null,
    payload.task ? `**task:** ${payload.task}` : null,
    "",
    "Lorem ipsum simulated output.",
  ]
    .filter(Boolean)
    .join("\n");
}

function randomId() {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

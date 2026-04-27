import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../plugins/pi/scripts/lib/args.mjs";

test("run: bare agent + free-text task", () => {
  const { payload, flags } = parseArgs("run", ["worker", "fix", "the", "auth", "bug"]);
  assert.equal(payload.action, "run");
  assert.equal(payload.agent, "worker");
  assert.equal(payload.task, "fix the auth bug");
  assert.equal(payload.background, true);
  assert.equal(flags.bg, undefined);
});

test("run: --wait flips background to false", () => {
  const { payload } = parseArgs("run", ["worker", "do thing", "--wait"]);
  assert.equal(payload.background, false);
});

test("run: agent[task] form", () => {
  const { payload } = parseArgs("run", ["worker[fix the auth bug]"]);
  assert.equal(payload.agent, "worker");
  assert.equal(payload.task, "fix the auth bug");
});

test("run: --bg + --wait conflict", () => {
  assert.throws(() => parseArgs("run", ["worker", "x", "--bg", "--wait"]), /mutually/);
});

test("run: --model passed through", () => {
  const { payload } = parseArgs("run", [
    "worker",
    "task",
    "--model",
    "anthropic/claude-sonnet-4-6",
  ]);
  assert.equal(payload.model, "anthropic/claude-sonnet-4-6");
});

test("run: --cwd + --fork", () => {
  const { payload } = parseArgs("run", ["worker", "task", "--cwd", "/tmp/x", "--fork"]);
  assert.equal(payload.cwd, "/tmp/x");
  assert.equal(payload.fork, true);
});

test("run: inline config sets model", () => {
  const { payload } = parseArgs("run", ["worker", "[model=openai/gpt-5]", "do thing"]);
  assert.equal(payload.model, "openai/gpt-5");
  assert.equal(payload.task, "do thing");
});

test("run: inline config with bool/number coerces", () => {
  const { payload } = parseArgs("run", [
    "worker",
    "[fork=true,retries=3]",
    "x",
  ]);
  assert.equal(payload.config.fork, true);
  assert.equal(payload.config.retries, 3);
});

test("run: explicit --model wins over inline config", () => {
  const { payload } = parseArgs("run", [
    "worker",
    "[model=openai/gpt-5]",
    "x",
    "--model",
    "anthropic/claude-opus-4-7",
  ]);
  assert.equal(payload.model, "anthropic/claude-opus-4-7");
});

test("run: missing task is an error", () => {
  assert.throws(() => parseArgs("run", ["worker"]), /task description/);
});

test("run: empty input is an error", () => {
  assert.throws(() => parseArgs("run", []), /agent name/);
});

test("run: invalid agent name is an error", () => {
  assert.throws(() => parseArgs("run", ["1bad-agent", "task"]), /agent name/);
});

test("run: unknown flag is an error", () => {
  assert.throws(() => parseArgs("run", ["worker", "task", "--woot"]), /unknown flag/);
});

test("run: --model without value", () => {
  assert.throws(() => parseArgs("run", ["worker", "task", "--model"]), /requires a value/);
});

test("run: --worktree flag is captured on the payload", () => {
  const { payload } = parseArgs("run", ["worker", "task", "--worktree"]);
  assert.equal(payload.worktree, true);
});

test("run: --worktree absent defaults to false", () => {
  const { payload } = parseArgs("run", ["worker", "task"]);
  assert.equal(payload.worktree, false);
});

test("status: no id → list mode", () => {
  const { payload } = parseArgs("status", []);
  assert.equal(payload.action, "status");
  assert.equal(payload.id, null);
});

test("status: with id", () => {
  const { payload } = parseArgs("status", ["job-001"]);
  assert.equal(payload.id, "job-001");
});

test("result: requires id", () => {
  assert.throws(() => parseArgs("result", []), /expects a job id/);
});

test("cancel: requires single id", () => {
  assert.throws(() => parseArgs("cancel", ["a", "b"]), /takes one id/);
});

test("setup: takes no positional args", () => {
  const { payload, flags } = parseArgs("setup", ["--yes"]);
  assert.equal(payload.action, "setup");
  assert.equal(flags.yes, true);
});

test("agent[task] preserves brackets in extras after spec", () => {
  // edge case: user types worker[fix bug] additional notes
  const { payload } = parseArgs("run", ["worker[fix bug]", "with", "high", "priority"]);
  assert.equal(payload.agent, "worker");
  assert.equal(payload.task, "fix bug with high priority");
});

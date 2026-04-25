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

test("run: agent[task] form", () => {
  const { payload } = parseArgs("run", ["worker[fix the auth bug]"]);
  assert.equal(payload.agent, "worker");
  assert.equal(payload.task, "fix the auth bug");
});

test("run: --wait flips background to false", () => {
  const { payload } = parseArgs("run", ["worker", "do thing", "--wait"]);
  assert.equal(payload.background, false);
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

test("chain: 3 steps with quoted tasks", () => {
  const { payload } = parseArgs("chain", [
    "scout[find affected modules]",
    "->",
    "planner[draft a plan]",
    "->",
    "worker[execute the plan]",
  ]);
  assert.equal(payload.action, "chain");
  assert.equal(payload.steps.length, 3);
  assert.deepEqual(payload.steps[0], { agent: "scout", task: "find affected modules" });
  assert.deepEqual(payload.steps[2], { agent: "worker", task: "execute the plan" });
});

test("chain: bare-form steps", () => {
  const { payload } = parseArgs("chain", [
    "scout",
    "look",
    "around",
    "->",
    "worker",
    "do",
    "the",
    "thing",
  ]);
  assert.equal(payload.steps.length, 2);
  assert.deepEqual(payload.steps[0], { agent: "scout", task: "look around" });
  assert.deepEqual(payload.steps[1], { agent: "worker", task: "do the thing" });
});

test("chain: empty steps is an error", () => {
  assert.throws(() => parseArgs("chain", []), /at least one step/);
});

test("chain: trailing flags don't pollute steps", () => {
  const { payload, flags } = parseArgs("chain", [
    "scout[a]",
    "->",
    "worker[b]",
    "--bg",
    "--model",
    "openai/gpt-5",
  ]);
  assert.equal(payload.steps.length, 2);
  assert.equal(flags.model, "openai/gpt-5");
  assert.equal(flags.bg, true);
});

test("parallel: requires bracketed form", () => {
  assert.throws(() => parseArgs("parallel", ["worker", "task1"]), /agent\["task"\] form/);
});

test("parallel: multiple bracketed items", () => {
  const { payload } = parseArgs("parallel", [
    "test-writer[module A]",
    "test-writer[module B]",
    "--worktree",
  ]);
  assert.equal(payload.action, "parallel");
  assert.equal(payload.tasks.length, 2);
  assert.equal(payload.worktree, true);
  assert.equal(payload.tasks[1].task, "module B");
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

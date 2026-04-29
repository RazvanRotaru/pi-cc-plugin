import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSlashCommand,
  buildToolInvocationPrompt,
} from "../plugins/pi/scripts/lib/pi-cli.mjs";

// Regression: pi-subagents only emits the asyncId/asyncDir markers the
// broker captures when /run is invoked with --bg (or the subagent tool
// is called with async:true). In sync mode it returns the result inline
// and the broker waits for markers that never come. The fake-pi fixture
// hides this — it always emits the markers regardless — so end-to-end
// tests pass even when the wire format is wrong.

test("buildSlashCommand always emits --bg, regardless of user-foreground vs user-background", () => {
  const foreground = buildSlashCommand({
    action: "run",
    agent: "worker",
    task: "say hi",
    background: false,
  });
  assert.match(foreground, /\s--bg\b/, "foreground dispatch must still pass --bg to pi-subagents");

  const background = buildSlashCommand({
    action: "run",
    agent: "worker",
    task: "say hi",
    background: true,
  });
  assert.match(background, /\s--bg\b/, "background dispatch must pass --bg to pi-subagents");
});

test("buildSlashCommand keeps --fork independent of --bg", () => {
  const slash = buildSlashCommand({
    action: "run",
    agent: "worker",
    task: "do thing",
    background: false,
    fork: true,
  });
  assert.match(slash, /\s--bg\b/);
  assert.match(slash, /\s--fork\b/);
});

test("buildSlashCommand task body is not quoted (pi-subagents reads everything after the agent token verbatim)", () => {
  const slash = buildSlashCommand({
    action: "run",
    agent: "worker",
    task: "fix the auth bug",
    background: false,
  });
  assert.match(slash, /^\/run worker fix the auth bug --bg$/);
});

test("buildSlashCommand emits inline config when model is set", () => {
  const slash = buildSlashCommand({
    action: "run",
    agent: "worker",
    task: "say hi",
    background: false,
    model: "openrouter/google/gemini-3-pro-preview",
  });
  assert.match(slash, /worker\[model=openrouter\/google\/gemini-3-pro-preview\]/);
  assert.match(slash, /\s--bg\b/);
});

test("buildToolInvocationPrompt always sets async:true, regardless of user-foreground vs user-background", () => {
  const foreground = buildToolInvocationPrompt({
    action: "run",
    agent: "worker",
    task: "say hi",
    background: false,
    worktree: true,
  });
  const fgArgs = JSON.parse(foreground.match(/```json\n([\s\S]+?)\n```/)[1]);
  assert.equal(fgArgs.async, true, "foreground tool dispatch must still set async:true");
  assert.equal(fgArgs.worktree, true);

  const background = buildToolInvocationPrompt({
    action: "run",
    agent: "worker",
    task: "say hi",
    background: true,
    worktree: true,
  });
  const bgArgs = JSON.parse(background.match(/```json\n([\s\S]+?)\n```/)[1]);
  assert.equal(bgArgs.async, true, "background tool dispatch must set async:true");
});

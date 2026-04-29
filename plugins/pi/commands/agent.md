---
description: Delegate a task to one pi agent. Waits for completion by default; pass --bg to detach.
argument-hint: "<agent> <task…> [--bg|--wait] [--model <m>] [--fork] [--worktree] [--mcp <list>] [--cwd <p>]"
allowed-tools: ["Agent"]
---

Invoke the `pi:pi-agent` subagent via the `Agent` tool (`subagent_type: "pi:pi-agent"`), forwarding the raw user request as the prompt.

`pi:pi-agent` is a subagent, not a skill — do not call `Skill(pi:pi-agent)` (no such skill) or `Skill(pi:agent)` (that re-enters this command and would hang the session).

The final user-visible response must be the pi broker's output verbatim.

Always run the Agent in the foreground. The pi broker handles its own `--bg` / `--wait` semantics internally — the Bash call inside the subagent returns promptly when pi backgrounds the job, so a background Agent layer would only add noise.

Raw user request:
$ARGUMENTS

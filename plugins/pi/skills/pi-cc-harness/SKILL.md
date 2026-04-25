---
name: pi-cc-harness
description: Harness-specific guidance — when to dispatch via Claude Code's Agent tool vs /pi:run, how to monitor a dispatched specialist, and how to interpret /pi:status.
---

# `pi-cc-plugin` for the orchestrator

This skill assumes you're running the GAN-style task-team pipeline
(`harness-orchestrate` skill). Read `pi-cc-usage` first if you haven't.

## The dispatch decision

For every specialist invocation:

1. Read the specialist's frontmatter from `.pi/agents/<role>.md`.
2. If `model` is one Claude Code can run natively (currently the
   `anthropic/claude-*` family), dispatch via the **Agent tool**.
3. Otherwise, dispatch via **`/pi:run`** (this plugin).

Don't try to short-circuit the decision based on what's "easier". Pi-side
specialists need to be dispatched by pi so pi can supply the model
adapter, the MCP context, and the worktree. Claude-side specialists need
the Agent tool so the orchestrator can stream events directly.

## Threading task context

Every specialist call — pi-side or Claude-side — must carry enough
context for the specialist to act independently: which task they're
acting on, where the relevant files are, what the prior step produced.

For `/pi:run` dispatches, embed the context in the task brief:

```
/pi:run implementer Implement the function from .work/AUTOPILOT-123/architect-brief.md. Tests live at tests/auth.test.mjs. Make them green. --bg
```

The specialist sees the entire prompt as their `task` argument. Pi reads
agent frontmatter from `.pi/agents/implementer.md` for its model,
thinking level, tools, etc.

## Polling

You have two state sources and they answer different questions:

| Question | Source |
|---|---|
| Is pi still running? Per-step progress? | `/pi:status <id>` |
| What did the specialist actually produce? | `/pi:result <id>` |

Polling cadence depends on the specialist. Architect/test-writer specialists
are usually 1-3 minutes; implementer can be 10+. Don't poll faster than
every ~30s — pi's status doesn't update that often anyway.

`/pi:status` auto-reconciles `state.json` against pi's status. So if you
poll and see `completed`, that's authoritative even if you didn't run any
explicit cancel/result command in between.

## When `/pi:cancel` is the right move

- Specialist is hung past its expected window. Cancel, escalate to user
  for triage.
- Wrong specialist was dispatched (orchestrator picked the wrong role).
  Cancel, dispatch the right one.

When NOT to cancel:

- Just because the run is "taking longer than I expected." Read the
  `output-N.log` first via `/pi:result` — the specialist may be working
  productively.
- The user said "stop everything." That's a `/exit` — let pi runs
  complete on their own; they're already detached.

## Surfacing errors

`/pi:status` displays per-step errors inline as `step (error)` and
under a `step-errors:` block. Pi-subagents sometimes marks runs as
`complete` even when a step's API call failed (e.g. wrong model name,
provider returning HTTP 400). Always check for that flag before treating
a "completed" run as a real success.

## Composes with

- **`harness-orchestrate`** (in `~/workspace/skills`) — the top-level
  orchestrator skill. Owns the GAN pipeline state machine. This skill is
  the *integration* layer between that pipeline and pi.
- **`pi-cc-usage`** — the per-command reference. Read first.

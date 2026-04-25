---
name: pi-cc-harness
description: Harness-specific guidance — when to dispatch via Claude Code's Agent tool vs /pi:run, how to thread a ticket ref + lock token through pi specialists, how to interpret /pi:status and recover from a stale lock.
---

# `pi-cc-plugin` for the orchestrator

This skill assumes you're running the GAN-style task-team pipeline
(`harness-orchestrate` skill) and have `team-tracking-mcp` registered with
both Claude Code AND pi. Read `pi-cc-usage` first if you haven't.

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

## Threading the ticket ref

Every specialist call — pi-side or Claude-side — must carry:

- The ticket ref (`{ project, id }`).
- The lock token returned by `acquire_ticket`.

For `/pi:run` dispatches, embed both in the task brief:

```
/pi:run implementer "Implement ticket AUTOPILOT-123. Lock token: lt_a7b9. Read the ticket via team-tracking/get_ticket and call commit_checkpoint + release_ticket when done. Brief lives at .work/AUTOPILOT-123/architect-brief.md." --bg
```

The specialist's frontmatter (seeded by `/pi:setup`) already lists the
team-tracking MCP tools — `get_ticket`, `append_log`, `commit_checkpoint`,
`release_ticket`. The brief tells it *which* ticket to act on.

## After dispatch

Record the pi run id alongside the ticket via `team-tracking/append_log`:

```
team-tracking/append_log({
  ref: { project: "Autopilot", id: "AUTO-123" },
  entry: "dispatched to pi: job-014 (pi-run-id 9b3f...)"
})
```

This makes the connection traceable from either side.

## Polling

You have two state sources and they answer different questions:

| Question | Source |
|---|---|
| Is pi still running? Per-step progress? | `/pi:status <id>` |
| What has the specialist *reported* about its work? | `team-tracking/get_ticket` |
| What was the final transcript? | `/pi:result <id>` |

Always check the ticket *first*. The board is the record. `/pi:status` is
useful for "did the process die?" but not for "what is the work doing?".

Polling cadence depends on the specialist. Architect/test-writer specialists
are usually 1-3 minutes; implementer can be 10+. Don't poll faster than
every ~30s — the board doesn't update that often anyway.

## Recovering from a stale lock

If a pi run dies without calling `release_ticket`, the lock eventually
expires (TTL on the team-tracking-mcp side). When you see a stale lock:

1. Read `recovered_checkpoint` from the ticket.
2. Decide: retry the same role from checkpoint, or escalate?
3. If retry: `/pi:run <role> "Resume ticket <ref> from checkpoint at .work/<ref>/checkpoint.md. Lock token: <new lt>." --bg`.

Don't reuse the dead run's pi-run-id. Each retry is a new pi run.

## When `/pi:cancel` is the right move

- Specialist is hung past its expected window. Cancel, escalate to user
  for triage.
- Wrong specialist was dispatched (orchestrator picked the wrong role).
  Cancel, dispatch the right one.

When NOT to cancel:

- Just because the run is "taking longer than I expected." Check the
  ticket log first — the specialist may be working productively.
- The user said "stop everything." That's a `/exit` — let pi runs
  complete on their own; they're already detached.

## Composes with

- **`harness-orchestrate`** (in `~/workspace/skills`) — the top-level
  orchestrator skill. Owns the GAN pipeline state machine. This skill is
  the *integration* layer between that pipeline and pi.
- **`team-tracking-mcp`** — provides the board, locks, and checkpoints.
  The harness skill assumes you've configured it on both Claude Code AND
  pi (via `/pi:setup`'s MCP registration step).
- **`pi-cc-usage`** — the per-command reference. Read first.

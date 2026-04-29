---
name: pi-cc-usage
description: How to use pi-cc-plugin slash commands (/pi:agent, /pi:status, /pi:result, /pi:cancel, /pi:setup) to delegate tasks from Claude Code to pi-subagents.
---

# Using `pi-cc-plugin`

`pi-cc-plugin` lets a Claude Code session delegate work to a [pi-subagent](https://github.com/nicobailon/pi-subagents)
running under any model `pi` supports — Claude, GPT, Gemini, or open-source.
The pi subagent is a real subprocess; by default the broker waits for
it to finish and prints its output. Pass `--bg` to detach (or in
Claude Code, Ctrl+B Ctrl+B a running `/pi:agent` to background it).

## When to reach for which command

| Goal | Command |
|---|---|
| Hand one task to one specialist | `/pi:agent` |
| Run N tasks in parallel | call `/pi:agent` N times in one assistant turn — Claude Code runs tool calls concurrently |
| Pipe specialist N → N+1 | call `/pi:agent`, read its output via `/pi:result`, embed that context into the next `/pi:agent` brief |
| Check what's running | `/pi:status` |
| Read the final markdown output of a finished run | `/pi:result <id>` |
| Stop a runaway run | `/pi:cancel <id>` |
| One-time wiring: verify pi + pi-subagents, scaffold `.pi/agents/` | `/pi:setup` |

The plugin used to ship `/pi:chain` and `/pi:parallel`; both have been
removed. Sequential pipelines hand the orchestrator no chance to validate
intermediate output, and parallel fan-out is already provided by Claude
Code's native tool-call concurrency.

## Foreground by default

`/pi:agent` waits for the subagent to finish and prints its output, just
like a normal tool call. For long jobs you'd rather not block on, pass
`--bg`: the broker returns the run id immediately and you pick up the
result later via `/pi:status` and `/pi:result`. In Claude Code you can
also Ctrl+B Ctrl+B a foreground `/pi:agent` to background it on the fly.

`--verbose` streams step transitions while the broker is waiting (one
line per state change). Useful when you want to see what the subagent
is doing without inflating the parent context with raw model output.

## Argument grammar

The grammar mirrors pi-subagents' slash syntax — muscle memory transfers:

```
agent[task]                      # bracketed agent+task
[key=value,key=value]            # inline config (model, fork, etc.)
--wait (default) | --bg          # mutually exclusive
--verbose                        # stream step transitions while waiting
--model <id>                     # override the agent's default model
--fork                           # run in a forked session
--worktree                       # run in an isolated git worktree
--mcp <server/tool,…>            # attach MCP tools for this dispatch
--cwd <path>                     # run pi in a different working dir
```

## Examples

```
/pi:agent worker fix the auth bug in src/login.ts
/pi:agent worker fix the auth bug --model openrouter/google/gemini-3-pro-preview
/pi:agent scout "audit src/auth" --worktree --verbose
/pi:agent worker "rewrite the auth module" --bg     # detached; pick up later
/pi:status                       # list everything (auto-reconciles with pi)
/pi:status job-002               # inspect one
/pi:result job-002               # final output
/pi:cancel job-002               # SIGTERM, escalates to SIGKILL
```

To fan out, issue multiple `/pi:agent --bg` calls in one assistant turn —
Claude Code runs tool calls in parallel and each gets its own job id.

## Identifiers

Each job gets two ids:

- `internal_id` — short, e.g. `job-001`. Convenience.
- pi run id — the long uuid pi gives back. Canonical.

`/pi:status`, `/pi:result`, `/pi:cancel` all accept either. They also
accept any unambiguous prefix of the pi run id, so `cafef0` matches
`cafef00d-…` if it's the only such job.

## State

- Per-workspace state file: `./.pi-cc-plugin/state.json`. The plugin
  gitignores it on first write.
- Pi-subagents writes per-run artifacts to
  `<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/`.
  The plugin reads `status.json`, `output-N.log`, and
  `subagent-log-<runId>.md` from there.
- Auto-reconciliation: every read (`/pi:status`, `/pi:result`,
  `/pi:cancel`) syncs `state.json` against pi's status. Stale `running`
  entries get back-filled to `completed` automatically.
- If pi's run dir is cleaned up by the OS, `/pi:status` says so explicitly
  rather than guessing.

## Failure modes you'll see

- `pi-broker: pi exited (code N) before emitting subagent-slash-result`
  — pi crashed at startup. Most often: `/pi:setup` hasn't been run, or
  pi-subagents isn't installed. Run `/pi:setup` to triage.
- `pi-broker: timed out after 15000ms waiting for subagent-slash-result`
  — pi started but never dispatched the subagent. Investigate the pi
  process; it may be stuck on auth or rate-limited.
- `no job found matching "<id>"` — typo, or that job was never recorded.
  Run `/pi:status` to see what's tracked.
- `ambiguous job id "<prefix>"` — too short a prefix; use a longer one or
  the internal_id.
- `step (error)` in the status output — pi-subagents marks runs
  `complete` even when a step's API call failed (e.g. invalid model).
  Check the `step-errors:` block for details.

## Composes with

- **`pi-cc-harness`** — sibling skill in this plugin. Walks the orchestrator
  through the GAN pipeline using `/pi:agent` for non-Claude specialists.
- **`harness-orchestrate`** — the orchestrator skill itself, from
  `~/workspace/skills`. Decides *when* to dispatch and to *which* model.

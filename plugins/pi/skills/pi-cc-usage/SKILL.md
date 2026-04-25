---
name: pi-cc-usage
description: How to use pi-cc-plugin slash commands (/pi:run, /pi:chain, /pi:parallel, /pi:status, /pi:result, /pi:cancel, /pi:setup) to delegate tasks from Claude Code to pi-subagents.
---

# Using `pi-cc-plugin`

`pi-cc-plugin` lets a Claude Code session delegate work to a [pi-subagent](https://github.com/nicobailon/pi-subagents)
running under any model `pi` supports — Claude, GPT, Gemini, or open-source.
The pi subagent is a real subprocess; the orchestrator never blocks on it
unless you explicitly pass `--wait`.

This skill explains *the commands*. For the GAN-style harness flow that
uses these commands, load `pi-cc-harness` separately (it composes with
`harness-orchestrate` and `team-tracking-mcp`).

## When to reach for which command

| Goal | Command |
|---|---|
| Hand one task to one specialist, fire-and-forget | `/pi:run` |
| Pipe N specialists in sequence (output of N → input of N+1) | `/pi:chain` |
| Run N independent tasks at once, optionally with worktree isolation | `/pi:parallel` |
| Check what's running | `/pi:status` |
| Read the final markdown output of a finished run | `/pi:result <id>` |
| Stop a runaway run | `/pi:cancel <id>` |
| One-time wiring: verify pi + pi-subagents, scaffold `.pi/agents/` | `/pi:setup` |

## Background by default

Every dispatch command (`/pi:run`, `/pi:chain`, `/pi:parallel`) backgrounds
by default. The broker waits only long enough to capture pi's run id, then
returns control. Use `--wait` if you want the orchestrator's stdout to
stream pi's output and block until pi exits.

## Argument grammar

The grammar mirrors pi-subagents' slash syntax — muscle memory transfers:

```
agent[task]                      # one bracketed step
->                               # chain separator (used by /pi:chain)
[key=value,key=value]            # inline config (model, fork, etc.)
--bg | --wait                    # mutually exclusive
--model <id>                     # override the agent's default model
--fork                           # run in a forked session
--worktree                       # parallel only — isolate filesystems
--cwd <path>                     # run pi in a different working dir
```

## Examples

```
/pi:run worker "fix the auth bug in src/login.ts"
/pi:run worker "fix the auth bug" --model openai/gpt-5 --bg
/pi:chain scout["map the affected files"] -> planner["draft a refactor plan"] -> worker["execute the plan"]
/pi:parallel test-writer["module A"] test-writer["module B"] --worktree
/pi:status                       # list everything
/pi:status job-002               # inspect one
/pi:result job-002               # final markdown
/pi:cancel job-002               # SIGTERM, escalates to SIGKILL
```

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
- Pi's per-run artifacts live under `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>-<slug>/`.
  The plugin reads `status.json`, `result.md`, and `log.md` from there.
- If pi's run dir is cleaned up by the OS, `/pi:status` says so explicitly
  rather than guessing.

## Failure modes you'll see

- `pi-broker: pi exited (code N) before emitting run-id+status-dir markers`
  — pi crashed at startup. Most often: `/pi:setup` hasn't been run, or
  pi-subagents isn't installed. Run `/pi:setup` to triage.
- `pi-broker: timed out after 5000ms waiting for pi run-id/status-dir markers`
  — pi started but never emitted markers. Investigate the pi process; it
  may be stuck on auth or waiting for input.
- `no job found matching "<id>"` — typo, or that job was never recorded.
  Run `/pi:status` to see what's tracked.
- `ambiguous job id "<prefix>"` — too short a prefix; use a longer one or
  the internal_id.

## Composes with

- **`pi-cc-harness`** — sibling skill in this plugin. Walks the orchestrator
  through the GAN pipeline using `/pi:run` for non-Claude specialists.
- **`team-tracking-mcp`** — separate plugin. Provides the board (tickets,
  locks, checkpoints) the specialists report progress to. The broker
  itself doesn't talk to the board; specialists do, via MCP tools listed
  in their seed agent file.
- **`harness-orchestrate`** — the orchestrator skill itself, from
  `~/workspace/skills`. Decides *when* to dispatch and to *which* model.

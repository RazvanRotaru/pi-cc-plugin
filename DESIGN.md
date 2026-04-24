# pi-cc-plugin — Design

Claude Code plugin that delegates work to [`pi-subagents`](https://github.com/nicobailon/pi-subagents) (nicobailon fork), the same way [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) delegates to Codex. Lets a Claude Code orchestrator run specialists under any model pi supports (Claude, GPT, Gemini, open-source), with real async / parallel / worktree isolation out of the box.

Sister project to `team-tracking-mcp`. This plugin handles *execution*; team-tracking-mcp handles *state*. They compose: pi-spawned specialists write progress to the board via team-tracking-mcp's tools.

## Goals

- Claude Code can delegate to pi via slash commands, identically to how codex-plugin-cc delegates to Codex.
- Background runs by default. The orchestrator session never blocks on a long specialist.
- Harness specialists (test-writer, implementer, reviewer, etc.) can run under non-Claude models without the orchestrator caring.
- Pi subagents can spawn their own subagents (pi supports this natively) — we don't try to prevent or manage that.
- State lives in team-tracking-mcp. Pi's run artifacts are ephemeral (raw logs, transcripts); the board is the record.

## Non-goals

- Replicating pi's TUI inside Claude Code. Pi's widgets, `/agents` manager, clarify TUI stay in pi — users who want that use pi directly.
- Steering / mid-run message injection. Nicobailon's pi-subagents doesn't expose a steering API in the version we're targeting; we omit `/pi:steer`. If it lands upstream later, we add it.
- Pi-intercom bidirectional bridge. Interesting but out of scope for v1; the orchestrator polls status, it doesn't get interrupted by the subagent.
- A separate MCP server. This plugin is pure slash-command delegation. State flows through `team-tracking-mcp` (separate plugin) when present.

## How it relates to other moving parts

```
Claude Code session (orchestrator)
│
├─ slash commands: /pi:run, /pi:chain, /pi:parallel, /pi:status, /pi:result, /pi:cancel, /pi:setup
│                       │
│                       ▼
│                  scripts/pi-broker.mjs
│                       │   (spawns pi via pi-spawn.ts resolution)
│                       ▼
│                  pi CLI ─── subagent tool ─── spawned pi subagent process
│                                                     │
│                                                     │ MCP tool calls
│                                                     ▼
│                                               team-tracking-mcp
│                                                     │
└───── list_board / get_ticket via MCP ───────────────┘
```

The orchestrator has two dispatch paths and picks based on the specialist's model:

- `model ∈ {anthropic/claude-*}` that Claude Code can run natively → **Claude Code Agent tool**
- any other model → **`/pi:run`** (this plugin)

The choice is per-specialist, declared in the specialist's frontmatter. The orchestrator skill (in `~/workspace/skills`) is updated separately to branch on this — out of scope for this plugin.

## Command surface

| Command | Purpose |
|---|---|
| `/pi:setup` | One-time: verify pi + pi-subagents, register `team-tracking-mcp` in pi's MCP config, scaffold default specialist agents into `.pi/agents/`. |
| `/pi:run <agent> <task…>` | Delegate one task to one pi agent. `--bg` (default `--bg` for harness use), `--model <m>`, `--fork`, `--cwd <p>`. |
| `/pi:chain <agent>["task"] -> <agent>["task"] …` | Delegate a chain. Same flags. |
| `/pi:parallel <agent>["task"] <agent>["task"] …` | Parallel tasks. `--worktree` for isolation. |
| `/pi:status [id]` | List active runs; or inspect one run (pi's status file + our job metadata). |
| `/pi:result <id>` | Final output of a completed run. |
| `/pi:cancel <id>` | Abort a running job. |

All commands are thin wrappers over `scripts/pi-broker.mjs <action> <args…>`. The broker does the work; slash-command markdown files just forward arguments.

The command argument grammar mirrors pi-subagents' slash syntax (`<agent>["task"]`, `->` for chain steps, `[key=value,…]` inline config), so a Claude Code user's muscle memory transfers directly to a pi session and vice versa.

## Broker + state model

One broker script (`scripts/pi-broker.mjs`) that every command invokes. Responsibilities:

1. Parse the slash command's argument string into a pi `subagent` call.
2. Spawn pi with that call.
3. Write job metadata to `./.pi-cc-plugin/state.json`.
4. For foreground runs (`--wait`): stream pi's stdout back through the slash command output.
5. For background runs: return immediately with the run id; pi writes durable status to its own dir.
6. For `/pi:status` and `/pi:result`: read pi's status dir for the run id, combine with our metadata, render for the orchestrator.

### Job state file

```json
{
  "jobs": [
    {
      "id": "pi-a53ebe46",                       // pi's run id
      "internal_id": "job-001",                   // our short id, for convenience
      "kind": "single | chain | parallel",
      "agents": ["worker"],
      "task": "refactor auth module",
      "status": "running | completed | failed | cancelled",
      "started_at": "2026-04-24T10:00:00Z",
      "completed_at": null,
      "pi_status_dir": "/tmp/pi-subagents-user/async-subagent-runs/a53ebe46-...",
      "ticket_ref": { "project": "Autopilot", "id": "AUTO-123" }   // optional, for harness integration
    }
  ]
}
```

`.pi-cc-plugin/` is added to `.gitignore` on first write (same helper as team-tracking-mcp's init).

### Finding the pi CLI

We reuse nicobailon's `pi-spawn.ts` logic (or vendor a copy) to resolve the pi binary cross-platform:
- Unix: `pi` on `PATH`
- Windows: locate the `pi` script via `require.resolve("@mariozechner/pi-coding-agent/package.json")` and run it with `process.execPath`

The broker has its own `scripts/lib/pi-spawn.mjs` implementing this, adapted from the reference.

## Pi invocation details

The broker builds JSON for the `subagent` tool and asks pi to execute it. Pi has a non-interactive mode where a single tool call is passed on the command line (we'll use the `pi` CLI's scripted invocation format — `pi "subagent(...)"`). Exact flag: TBD against the pi CLI docs during M1.

For foreground runs (`--wait`):
- Broker spawns pi with stdio piped.
- Streams pi's stdout to Claude Code.
- Returns when pi exits.

For background runs (default for harness dispatch):
- Broker spawns pi detached.
- Reads pi's emitted run id from stderr/stdout (first line or known marker).
- Writes our metadata with the id.
- Returns immediately.

Pi writes durable status files to `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>-…/` — `status.json`, `events.jsonl`, markdown logs. `/pi:status` and `/pi:result` read these directly; we never parse pi's stdout for status.

## Setup flow

`/pi:setup` is idempotent and runs the following checks in order. Every step is a no-op if already done.

1. **pi installed?** `pi --version`. If missing, print install instructions and stop.
2. **pi-subagents installed?** Check `pi list-extensions` (or whatever pi's introspection API is — TBD M1). If missing, offer: `pi install npm:pi-subagents`.
3. **Logged in?** The broker doesn't need pi auth, but pi does. Print whatever login status pi reports.
4. **team-tracking-mcp registered?** Read pi's MCP config (location TBD — pi has per-user config). If `team-tracking-mcp` isn't registered, offer to add an entry pointing at the local MCP server binary.
5. **Default specialist agents present?** For each of `architect`, `test-writer`, `test-reviewer`, `implementer`, `code-reviewer`, `ci-triage`, check `.pi/agents/<name>.md`. If missing, offer to scaffold from templates bundled in the plugin (`plugins/pi/agents-seed/<name>.md`).
6. **`.gitignore` touched?** Ensure `.pi-cc-plugin/` is ignored if `.git/` exists.

Setup prints a summary at the end. No side effects without confirmation.

## Specialist scaffolding

The plugin ships seed agent files at `plugins/pi/agents-seed/<role>.md`. `/pi:setup` copies them into the workspace's `.pi/agents/` on user approval. Users customize from there; our seed never overwrites existing files.

Each seed declares the role's default model, thinking level, tools (including the `team-tracking-mcp` MCP tools), skills, and `maxSubagentDepth`. Example (`architect.md`):

```markdown
---
description: Architect — shape contracts, consult on design choices
model: anthropic/claude-opus-4-6
thinking: high
tools: read, bash, grep, find, mcp:team-tracking/get_ticket, mcp:team-tracking/list_board, mcp:team-tracking/report_progress, mcp:team-tracking/append_log, mcp:team-tracking/acquire_ticket, mcp:team-tracking/commit_checkpoint, mcp:team-tracking/release_ticket
skills: architecture-review
maxSubagentDepth: 2
defaultReads: false
output: false
---
You are the Architect specialist in a GAN-style orchestrator/specialist pipeline…
(body copied from harness-task-team/specialists-baseline/architect.md)
```

The seed tool list pins every MCP tool the specialist needs from team-tracking-mcp. Without this, pi sandboxes MCP access to nothing, and specialists can't report progress.

## Harness integration contract

The orchestrator (main Claude Code session with `harness-orchestrate` loaded) dispatches to pi as follows:

1. Specialist selection: orchestrator reads the specialist file. If `model` is Claude-runnable, dispatch via Agent tool. Else, dispatch via this plugin.
2. Pre-dispatch: orchestrator calls `acquire_ticket(ref, owner)` on team-tracking-mcp.
3. Dispatch: `/pi:run <role> "<task spec reference>" --bg`. Task text tells the specialist the ticket ref and the lock token.
4. Track: orchestrator records the returned pi run id in team-tracking-mcp via `append_log`.
5. Poll: orchestrator calls `get_ticket` + `/pi:status <id>` periodically. Progress arrives via team-tracking-mcp (pulse fields, checkpoints), not via pi.
6. Complete: when `/pi:status` reports done, orchestrator calls `/pi:result <id>` for the final transcript (optional, mostly for HITL review), and the specialist has already called `release_ticket`.
7. Crash recovery: if pi run dies without `release_ticket`, the ticket's lock eventually goes stale (TTL). Orchestrator picks up the stale lock, retrieves `recovered_checkpoint`, and dispatches a fresh pi run.

The orchestrator skill is updated out-of-band (in `~/workspace/skills`) to branch on model type. This plugin only provides the slash-command surface and the scaffolding.

## Failure modes

- **Pi not installed** — `/pi:setup` detects and prints install instructions; every other command errors fast with `EPI_NOT_FOUND`.
- **Pi hangs** — pi is a subprocess; standard timeout + kill behaviors apply. Broker has a configurable timeout; on timeout it marks our metadata `status: "timeout"` but does not touch team-tracking-mcp (the ticket's lock TTL handles recovery).
- **Pi exits with non-zero** — broker captures exit code, writes `status: "failed"` with stderr tail in our state file. User sees this via `/pi:status <id>`.
- **Pi run dir disappears** — `<tmpdir>` got cleaned up by OS. `/pi:status <id>` degrades gracefully: reports "status: unknown, pi artifacts gone".
- **MCP server missing** — specialists fail inside pi when they try to call team-tracking tools. Pi run ends with error. Orchestrator sees via `/pi:result` + the ticket's unchanged lock state.

## Security

- Broker runs in the user's shell with the user's credentials. No privilege escalation.
- Pi writes its own status files under `<tmpdir>/pi-subagents-<scope>/`, owned by the user. We don't parse or trust anything else.
- Our state file (`.pi-cc-plugin/state.json`) is gitignored. Nothing sensitive lives there (no API keys — pi manages those).

## Open items

- **Pi CLI invocation syntax.** The exact shell form for calling `subagent(...)` non-interactively needs verification during M1. If pi requires an interactive session for scripted calls, we may need to use pi's JSON-RPC / programmatic API instead — or vendor the relevant pi runtime pieces. Prefer shell-spawn first; fallback to programmatic if needed.
- **Pi MCP config location and format.** Needs verification during M1 so `/pi:setup` can modify it idempotently. Until confirmed, `/pi:setup`'s MCP registration step is interactive (prints the JSON snippet for the user to paste).
- **Default `maxSubagentDepth` for seed agents.** Starts at 2 (specialist can spawn one layer of helpers). Revisit if users report issues.
- **Parallel dispatch in harness.** The harness currently runs one specialist per stage; `/pi:parallel` is available but not used by the default harness flow. Left in for users who want to fan out (e.g., parallel test-writers on independent subtasks).

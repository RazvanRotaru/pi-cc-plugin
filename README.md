# pi-cc-plugin

> Run subagents on **any** model from inside Claude Code.

`pi-cc-plugin` is a Claude Code plugin that delegates work to
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) (nicobailon's
fork of [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)).
Pi already speaks Claude, OpenAI, Google, OpenRouter, DeepSeek, Groq,
xAI, Mistral, Cerebras, Hugging Face, Bedrock, and friends — this plugin
gives Claude Code a clean slash-command surface to dispatch into that
model zoo, while keeping the orchestrator session itself snappy and
non-blocking.

```text
┌─ Claude Code (orchestrator, Claude) ──────────────────────────────┐
│                                                                    │
│  /pi:agent worker "fix the auth bug" --model openrouter/...        │
│       │                                                            │
│       ▼                                                            │
│   pi-broker  ──►  pi --mode rpc  ──►  pi-subagents  ──►  child pi  │
│       │                                    │                │      │
│       ▼                                    ▼                ▼      │
│   .pi-cc-plugin/state.json    /tmp/.../async-subagent-runs/<id>/   │
│   (job ledger)                  status.json + events.jsonl + log   │
│                                                                    │
│       ▲                                    │                       │
│       └────  /pi:status reads both ◄───────┘                       │
│              (events stream forwarded raw to the orchestrator)     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- **Foreground by default.** `/pi:agent` waits for the subagent to finish
  and prints its output, just like any normal tool call. Add `--bg` for
  long jobs you want to fire and forget — and pick up later via
  `/pi:status` and `/pi:result`.
- **Live progress with `--verbose`.** Stream step transitions to the
  terminal as they happen. Off by default to keep the orchestrator's
  context tight.
- **Heterogeneous models.** Use `--model openrouter/google/gemini-3-pro-preview`,
  `--model anthropic/claude-opus-4-7`, anything pi knows about.
- **Worktree isolation.** `--worktree` runs the subagent in its own
  `git worktree` for safe edits when several dispatches share a repo.
- **MCP tools per agent or per dispatch.** Static via the agent file,
  dynamic via `--mcp foo/bar`.
- **Auto-reconcile.** `state.json` syncs against pi's view on every
  read — finished jobs always show as completed.
- **Raw event stream in `/pi:status`.** Pi-subagents' `events.jsonl`
  is forwarded verbatim — step transitions, child tool calls, errors —
  so the orchestrator sees what's actually happening, not just `running`.

---

## Quick start

### 1. Install pi (Node ≥ 20)

```bash
# Need Node 20+ in the shell. nvm is the easiest path:
nvm install --lts && nvm use --lts

# Pi itself:
npm i -g @mariozechner/pi-coding-agent

# pi-subagents (the extension that gives pi the `subagent` tool):
pi install npm:pi-subagents
```

### 2. Configure a provider

OpenRouter is the lowest-friction path (one key → all models):

```bash
export OPENROUTER_API_KEY=sk-or-...
echo 'export OPENROUTER_API_KEY=sk-or-...' >> ~/.bashrc
```

Or, for OAuth providers (Claude Pro/Max, ChatGPT Plus, Gemini CLI):

```bash
pi    # then /login → pick a provider
```

See [Provider matrix](#provider-matrix) below for direct API-key env vars.

### 3. Install this plugin

```text
/plugin marketplace add /path/to/pi-cc-plugin
/plugin install pi@pi-cc-plugin
/reload-plugins
```

### 4. Wire up your project

```text
/pi:setup --yes
```

That checks pi/pi-subagents are installed, validates auth, copies six
default specialist seeds into `.pi/agents/`, and gitignores
`.pi-cc-plugin/`.

### 5. First run

```text
/pi:agent scout "how many .mjs files are in this repo?"
```

The broker waits for scout to finish and prints its output. For long
jobs you'd rather background, add `--bg`:

```text
/pi:agent worker "rewrite the auth module" --bg
```

Output (within ~1s):

```text
Started job-001 (pi-run-id 0f214ec0-…) — agent=worker
Use /pi:status job-001 to inspect.
```

Then `/pi:status job-001` shows live progress; `/pi:result job-001`
prints the final output once worker is done.

---

## Slash command reference

| Command | What it does |
|---|---|
| `/pi:setup [--yes]` | Verify pi + pi-subagents + provider auth, scaffold `.pi/agents/`, gitignore `.pi-cc-plugin/`. Idempotent. |
| `/pi:agent <agent> <task…> [flags]` | Dispatch one task to one pi agent. Need to fan out? Call `/pi:agent` multiple times in one assistant turn — Claude Code runs tool calls in parallel. |
| `/pi:status [id]` | Without id: list every tracked job. With id: inspect one. Auto-reconciles `state.json` against pi **and forwards the raw event stream** (`subagent.run.started`, `subagent.step.started`, child tool calls, `subagent.run.completed`, …) so the orchestrator sees more than just `running`. |
| `/pi:result <id>` | Print the final markdown output. |
| `/pi:cancel <id>` | SIGTERM pi-subagents' parent + every detached worker carrying the runId; SIGKILL after 5s. |

### Flags

| Flag | Where | Effect |
|---|---|---|
| `--wait` (default) | run | Wait for the subagent to finish; print its output when done. Redundant — same as omitting both flags. |
| `--bg` | run | Detach. Returns the run id immediately; pick up via `/pi:status` and `/pi:result`. Use this for long runs or when you want to keep the orchestrator session free. In Claude Code you can also Ctrl+B Ctrl+B a running `/pi:agent` to background it manually. |
| `--verbose` | run | While waiting in foreground, stream step-transition lines (`· agent: running` → `· agent: complete`) to stdout. Off by default to keep the parent agent's context small. |
| `--model <id>` | run | Override the agent's default model (e.g. `openrouter/google/gemini-3-pro-preview`). Always use `provider/model` form to avoid registry resolution surprises. |
| `--fork` | run | Run the subagent in a forked context (pi-subagents `context: "fork"`). |
| `--worktree` | run | Run the subagent in an isolated git worktree. Requires a clean working tree. Dispatches via the tool-call path (adds ~3-5s of latency). |
| `--mcp <list>` | run | Attach MCP tools to this dispatch (comma-separated `server/tool`). See [MCP tools](#mcp-tools). |
| `--cwd <path>` | run | Run pi in a different working directory. |
| `--yes` | setup | Auto-apply scaffold/gitignore fixes. |

### Identifiers

Every job has two IDs:

- **`internal_id`** — short, stable: `job-001`, `job-002`. For humans.
- **pi run id** — the long uuid pi gives back. Canonical.

`/pi:status`, `/pi:result`, `/pi:cancel` accept either, plus any
unambiguous prefix of the pi run id.

### What `/pi:status` shows you

Two files on disk back every status query, and both get reflected in the output:

```text
                    ┌──────────────── /pi:status job-001 ────────────────┐
                    │                                                     │
       state.json   │   .pi-cc-plugin/state.json   ← broker ledger        │
       per-job ─────┤        (id, agent, task, started, completed)        │
                    │                                                     │
                    │   /tmp/pi-subagents-uid-<uid>/async-subagent-runs/  │
       pi-subagents │     <runId>/                                        │
       per-run ─────┤        ├─ status.json     ← per-step state          │
                    │        └─ events.jsonl    ← raw event stream        │
                    │                                                     │
                    └─────────────────────────────────────────────────────┘
```

Sample output (single-job inspect):

```text
**job-001** · single · running
  pi-run-id: `8f3a2c1b-9e7d-4a6b-8c1d-2e3f4a5b6c7d`
  agents: worker
  task: summarize the auth module
  started: 2026-04-29T19:00:12.503Z
  steps:
    - worker: running
  events:
    {"type":"subagent.run.started","ts":1777834812,"runId":"8f3a..."}
    {"type":"subagent.step.started","ts":1777834813,"runId":"8f3a...","stepIndex":0,"agent":"worker"}
    {"type":"tool_call","name":"read","args":{"path":"src/auth.ts"},"subagentSource":"child","subagentAgent":"worker"}
    {"type":"tool_call","name":"grep","args":{"pattern":"export"},"subagentSource":"child","subagentAgent":"worker"}
```

The events block is **raw pass-through** — no summarization, no
filtering. The orchestrator (Claude) parses it and decides what to
surface to you. Common event types pi-subagents emits:

| Type | Source | Carries |
|---|---|---|
| `subagent.run.started` / `.completed` | pi-subagents | `runId`, `success` |
| `subagent.step.started` | pi-subagents | `stepIndex`, `agent` |
| `subagent.parallel.started` / `.completed` | pi-subagents | step group + agent list |
| `subagent.control` | pi-subagents | steering / cancel notices |
| `tool_call`, `message_*`, `usage`, … | child pi (re-emitted) | tagged `subagentSource: "child"` |
| `subagent.child.stdout` / `.stderr` | child pi (raw lines) | unstructured fallback |

---

## Agent configuration

Agents live in `.pi/agents/<name>.md` (project) or
`~/.pi/agent/agents/<name>.md` (user). Project wins. Pi-subagents also
ships a built-in set (`scout`, `worker`, `planner`, `reviewer`,
`context-builder`, `researcher`, `delegate`, `oracle`,
`oracle-executor`) that any user/project agent can override by name.

### Frontmatter shape

```yaml
---
name: scout                                    # required, must match filename
description: Fast codebase recon              # required
model: openrouter/moonshotai/kimi-k2.6        # any pi-known model
fallbackModels: anthropic/claude-haiku-4-5    # optional ordered fallbacks
thinking: medium                               # off | minimal | low | medium | high | xhigh
tools: read, bash, grep, find                  # builtin tool allowlist + mcp:* entries
skills: clean-code                             # comma-separated, injected into prompt
maxSubagentDepth: 1                            # how many layers of nested delegation
inheritProjectContext: true                    # keep AGENTS.md/CLAUDE.md in the prompt
inheritSkills: false                           # surface pi's full skills catalog?
systemPromptMode: replace                      # replace | append (vs pi's base prompt)
output: context.md                             # default file the agent writes
defaultReads: brief.md                         # files the agent reads on start
---

You are a scout. Your job is …
```

### Attaching MCP tools (the most common ask)

Pi-subagents reads `mcp:server/tool` entries from the same `tools:` line
and forwards them to the child pi via `MCP_DIRECT_TOOLS`. So **the
canonical place to wire MCP tools is the agent's `tools:` line:**

```yaml
---
name: implementer
description: Write production code that makes the test suite green
model: openrouter/anthropic/claude-sonnet-4-7
tools: read, write, edit, bash, grep, find,
  mcp:filesystem/read_file, mcp:filesystem/write_file,
  mcp:test-runner/run_suite, mcp:linter/check
skills: clean-code
---
```

Any `/pi:agent implementer …` then has those MCP tools available without
extra flags.

If you want a **per-dispatch** MCP override (one-off experimentation,
or attaching tools to a builtin like `scout` without committing changes
to your seed), use the `--mcp` flag. The broker writes a temporary
agent file with the extra tools, dispatches under that name, and cleans
up after asyncId capture:

```text
/pi:agent scout "find auth bugs" --mcp memory/store,memory/read --bg
```

Source resolution order for `--mcp`: project seed (`.pi/agents/`) →
user seed (`~/.pi/agent/agents/`) → pi-subagents builtin. Settings
overrides (`.pi/settings.json#subagents.agentOverrides`) are merged
into the temp file, so model/thinking/skills overrides keep applying.

### Scaffolding

`/pi:setup --yes` copies six seeds into `.pi/agents/`:

| Seed | Role |
|---|---|
| `architect` | Shape contracts, surface integration points, write a brief |
| `test-writer` | Author the failing test suite that pins desired behavior |
| `test-reviewer` | Adversarial review of the test suite |
| `implementer` | Make the suite green |
| `code-reviewer` | Adversarial review of the implementer's diff |
| `ci-triage` | Bisect a CI failure; classify flake/regression/infra |

Edit them freely — the plugin never overwrites once they exist.

---

## Recipes

### Cheap recon → expensive deep dive

Two `/pi:agent` calls. The orchestrator (Claude) reads scout's result,
decides whether to keep going, then dispatches the deeper agent with
that context embedded in the brief:

```text
/pi:agent scout "map the affected modules"
# (foreground: scout's output is printed; orchestrator reads it)
/pi:agent oracle "Given scout's summary above, critique the plan and surface risks"
```

This replaces the old `/pi:chain` form. Sequential agents almost always
benefit from the orchestrator validating the previous step's output
before deciding what to do next.

### Fan out with isolation

Multiple `/pi:agent --bg` calls from the same assistant turn — Claude
Code runs tool calls in parallel, and `--bg` lets all three start
without any one of them blocking the others:

```text
/pi:agent scout "audit frontend" --worktree --bg
/pi:agent scout "audit backend"  --worktree --bg
/pi:agent scout "audit infra"    --worktree --bg
```

Each scout gets its own worktree under `/tmp/pi-worktree-<runId>-<n>`,
torn down at run end. Requires a clean git working tree. Pick the
results up later via `/pi:result job-001`, `/pi:result job-002`, etc.

### Lightweight test harness

```text
/pi:agent test-writer "pin the contract for src/auth.ts"
# orchestrator reads the test-writer brief from stdout, then:
/pi:agent implementer "make the suite at tests/auth.test.mjs green"
# review the diff, then:
/pi:agent code-reviewer "adversarial review of the implementer diff"
```

Foreground by default keeps the orchestrator in the loop between steps.

### Attach MCP tools just for this dispatch

```text
/pi:agent worker "implement the planned migration using the test-runner MCP" --mcp test-runner/run_suite,test-runner/diff
```

---

## How it works

### Dispatch (`/pi:agent`)

```text
┌─ Claude Code session ────────────────────────────────────────────┐
│                                                                   │
│  /pi:agent worker "task"                                          │
│       │                                                           │
│       ▼                                                           │
│  plugins/pi/scripts/pi-broker.mjs run worker "task" [--bg|--wait] │
│       │                                                           │
│       ▼                                                           │
│  args.mjs (parse) → pi-cli.mjs (spawn pi --mode rpc) ──┐          │
│                                                         │          │
│  ┌──────────────────────────────────────────────────────┴───┐      │
│  │ pi (Node ≥20) loads pi-subagents extension              │      │
│  │   handles /run slash command                            │      │
│  │   OR direct subagent tool_call (--worktree path)        │      │
│  │   spawns child pi → writes status.json + events.jsonl   │      │
│  │   emits subagent-slash-result {asyncId, asyncDir}       │      │
│  └──────────────────────────────────────────────────────┬───┘      │
│                                                         │          │
│       ◀─ broker captures asyncId, closes stdin ──────── ┘          │
│       │                                                           │
│       ▼                                                           │
│  state.json patch (job-NNN ↔ runId ↔ asyncDir)                    │
│       │                                                           │
│       ├──── --wait ────► poll status.json until terminal,         │
│       │                  print final output, return               │
│       └──── --bg   ────► return immediately with job id           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Status / result (`/pi:status`, `/pi:result`)

```text
┌─ Claude Code session ─────────────────────────────────────────┐
│                                                                │
│  /pi:status [job-id]                                           │
│       │                                                        │
│       ▼                                                        │
│  pi-broker.mjs status [id]                                     │
│       │                                                        │
│       │   reconcile.mjs                                        │
│       │      ├── read .pi-cc-plugin/state.json                 │
│       │      └── read /tmp/.../async-subagent-runs/<id>/       │
│       │           ├── status.json    → state, steps, errors    │
│       │           └── events.jsonl   → raw event stream        │
│       ▼                                                        │
│  render.mjs → markdown block per job                           │
│       │      header · pi-run-id · steps · errors · events:     │
│       ▼                                                        │
│  Claude reads, decides what to surface                         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### State on disk

| Path | Purpose | Owner |
|---|---|---|
| `./.pi-cc-plugin/state.json` | Broker's job ledger: `internal_id`, `pi-run-id`, `agents`, `task`, `status`, `pi_status_dir` | `pi-cc-plugin` |
| `/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/status.json` | Per-run state: `state`, per-step `status` / `model` / `error`, timing | `pi-subagents` |
| `/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/events.jsonl` | One JSON event per line: `subagent.*` lifecycle events + child pi tool calls (re-emitted with `subagentSource: "child"`) | `pi-subagents` |
| `/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/output-N.log` | Per-step stdout (concatenated for `/pi:result`) | `pi-subagents` |
| `/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/subagent-log-<runId>.md` | Human-readable transcript | `pi-subagents` |
| `~/.pi/agent/auth.json` | Provider credentials (`0600`) | pi |
| `~/.pi/agent/extensions/`, `<npm-global>/pi-subagents/` | Extension code | pi |

The plugin never writes pi's state; it only reads. The broker's
`state.json` auto-reconciles with pi's `status.json` on every
`/pi:status` and `/pi:result`. `events.jsonl` is read in full each
call (`readPiEvents` accepts an optional byte cursor for incremental
tails — currently unused since `/pi:status` is happy to dump the full
stream and let the orchestrator interpret).

### Provider matrix

Pi recognizes these env vars in addition to OAuth and `auth.json`:

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| **OpenRouter** | **`OPENROUTER_API_KEY`** |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Groq | `GROQ_API_KEY` |
| xAI | `XAI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| AWS Bedrock | (uses standard AWS creds) |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| Hugging Face | `HF_TOKEN` |

Full list lives in pi's
[`docs/providers.md`](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/providers.md).

### Listing model prices

This plugin ships a companion `/pi-prices` slash command (and a
`pi-prices` shell binary at `~/.local/bin/`) that dumps pi's bundled
pricing table — no network calls:

```bash
pi-prices                    # all models
pi-prices openrouter         # filter by substring
pi-prices --json             # machine-readable
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pi-broker: pi requires Node >= 20` | System node is 18 (Claude Code's subprocess env) and no nvm Node 20+ found | `nvm install --lts && nvm use --lts`, restart Claude Code |
| `pi-broker: pi exited (code N) before emitting subagent-slash-result` | pi crashed at startup; usually missing extension or auth | Run `/pi:setup --yes`; check `pi list \| grep pi-subagents`; verify auth |
| `pi-broker: timed out after Nms waiting for subagent-slash-result` | Pi is loading slowly (first run) or stuck on auth/rate-limit | Bump `PI_BROKER_DISPATCH_TIMEOUT_MS=120000`, or attach a debugger to pi |
| `step (error)` in `/pi:status` despite `state: complete` | Pi-subagents marks the run complete even when a step's API call fails (e.g. invalid model id, missing auth) | Read `step-errors:` block; the broker auto-suggests a hint |
| `Unknown agent: <name>` | Project seed missing a `name:` line, or wrong path | Project seeds must be at `.pi/agents/<name>.md` with `name: <name>` in frontmatter |
| `worktree isolation requires a clean git working tree` | Local tree dirty | `git stash` or commit, retry |
| `--mcp couldn't find a source for agent "<name>"` | No project, user, or builtin source for that agent | Scaffold one (`/pi:setup`) or pick a different agent |

---

## Configuration knobs (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PI_BROKER_PI_BIN` | (auto-resolved) | Override pi launcher (script or binary) |
| `PI_BROKER_PI_ARGS` | (none) | Comma-separated args prepended after `PI_BROKER_PI_BIN` |
| `PI_BROKER_DISPATCH_TIMEOUT_MS` | `60000` | How long to wait for pi to ack the slash command |
| `PI_BROKER_POLL_INTERVAL_MS` | `1500` | Foreground poll interval against pi-subagents' status.json |
| `PI_BROKER_SIGTERM_GRACE_MS` | `5000` | Cancel grace before SIGKILL |
| `PI_BROKER_NO_NODE_VERSION_CHECK` | `0` | Skip the Node-≥20 fail-fast (for fixtures) |
| `PI_BROKER_DEBUG` | `0` | Print stack traces on broker errors |

These are subprocess vars — set them where you launch Claude Code.

---

## Development

```bash
npm install
npm test                            # 129+ offline tests against the fake-pi fixture
npm run lint                        # biome
PI_SMOKE=1 npm run test:smoke       # only when a real pi is installed
```

Tests use a **fake-pi fixture** (`tests/fixtures/fake-pi.mjs`) that
mimics pi's RPC protocol — JSONL prompts on stdin, `subagent-slash-result`
custom messages, status.json shape, the works. No real pi needed for
the offline suite. Real-pi smoke tests live in `docs/DOGFOOD.md` and
are runnable manually.

Code layout:

```text
plugins/pi/
  scripts/
    pi-broker.mjs                  # entry point invoked by every slash command
    lib/
      args.mjs                     # parse the slash grammar
      pi-spawn.mjs                 # locate pi (npm-global, nvm, /usr/local) + pick Node ≥20
      pi-cli.mjs                   # JSON-RPC client; slash and tool_call dispatch paths
      pi-status-reader.mjs         # read pi's status.json / output-N.log
      reconcile.mjs                # sync state.json from pi on every read
      ephemeral-agents.mjs         # write per-dispatch agent files for --mcp
      process-tree.mjs             # find + kill detached subagent workers
      tracked-jobs.mjs             # state.json CRUD
      state.mjs                    # atomic JSON I/O with mkdir-based locking
      gitignore.mjs                # ensure .pi-cc-plugin/ is ignored
      render.mjs                   # markdown for /pi:status and /pi:result
      setup-checks.mjs             # /pi:setup checks
      actions/{run,status,result,cancel,setup}.mjs
  agents-seed/                     # six default specialists
  commands/                        # one .md per slash command
  skills/{pi-cc-usage,pi-cc-harness}/SKILL.md
docs/
  PI_INVOCATION.md                 # verified contract with real pi
  DOGFOOD.md                       # manual QA script
```

Run `/pi:setup --yes` against a freshly-cloned repo to confirm everything
works end-to-end before dogfooding model dispatches.

---

## Status

**Stable** — broker dispatch (`/pi:agent`) with foreground polling and
optional `--verbose` step streaming, `--bg` for detached runs, status,
result, cancel, worktree (via tool_call path), `--mcp`, auto-reconcile,
**raw `events.jsonl` forwarding through `/pi:status`** so the
orchestrator gets per-step transitions and child tool calls (not just
`running`).

**Removed** — `/pi:chain` and `/pi:parallel`. Use multiple `/pi:agent`
calls from the orchestrator instead: parallel falls out naturally
(Claude Code runs tool calls concurrently), and sequencing benefits
from the orchestrator validating each step before deciding the next.

**Out of scope (v1)** — `/pi:steer` (pi-subagents has no steering API),
pi-intercom bridge, integrated MCP server (state lives elsewhere).

---

## Related

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) —
  the underlying multi-provider CLI.
- [pi-subagents](https://github.com/nicobailon/pi-subagents) — extension
  that provides the `subagent` tool + the `/run` slash command inside
  pi. (pi-subagents also exposes `/chain` and `/parallel`; this plugin
  no longer surfaces them — see Status above.)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) — the host.

License: MIT.

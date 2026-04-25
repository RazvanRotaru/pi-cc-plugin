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
┌─ Claude Code (orchestrator, Claude) ─────────────────────────┐
│                                                               │
│  /pi:run worker  "fix the auth bug"  --model openrouter/...   │
│       │                                                       │
│       ▼                                                       │
│   pi-broker → pi --mode rpc → pi-subagents → child pi process │
│       │                                            │          │
│       ▼                                            ▼          │
│   .pi-cc-plugin/state.json          (any model pi supports)   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

- **Async by default.** Dispatches return in <1s with a job id; the
  subagent runs detached. No blocking the main session on a long task.
- **Heterogeneous models.** Use `--model openrouter/google/gemini-3-pro-preview`,
  `--model anthropic/claude-opus-4-7`, anything pi knows about.
- **Worktree isolation.** `--worktree` runs each parallel task in its
  own `git worktree` for safe concurrent edits.
- **MCP tools per agent or per dispatch.** Static via the agent file,
  dynamic via `--mcp foo/bar`.
- **Auto-reconcile.** `state.json` syncs against pi's view on every
  read — finished jobs always show as completed.

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
/pi:run scout "how many .mjs files are in this repo?" --bg
```

Output (within ~1s):

```text
Started job-001 (pi-run-id 0f214ec0-…) — agent=scout
Use /pi:status job-001 to inspect.
```

Then `/pi:status job-001` shows live progress; `/pi:result job-001`
prints the final output once scout is done.

---

## Slash command reference

| Command | What it does |
|---|---|
| `/pi:setup [--yes]` | Verify pi + pi-subagents + provider auth, scaffold `.pi/agents/`, gitignore `.pi-cc-plugin/`. Idempotent. |
| `/pi:run <agent> <task…> [flags]` | Dispatch one task to one pi agent. |
| `/pi:chain <agent>["task"] -> <agent>["task"] … [flags]` | Run agents sequentially; each step's output feeds the next. |
| `/pi:parallel <agent>["task"] … [flags]` | Run agents concurrently. Add `--worktree` for filesystem isolation. |
| `/pi:status [id]` | Without id: list every tracked job. With id: inspect one. Auto-reconciles `state.json` against pi. |
| `/pi:result <id>` | Print the final markdown output (concatenated per-step for chain/parallel). |
| `/pi:cancel <id>` | SIGTERM pi-subagents' parent + every detached worker carrying the runId; SIGKILL after 5s. |

### Flags

| Flag | Where | Effect |
|---|---|---|
| `--bg` (default) | run/chain/parallel | Detach. Returns the run id immediately. |
| `--wait` | run/chain/parallel | (reserved — currently the broker only does `--bg`) |
| `--model <id>` | any | Override the agent's default model (e.g. `openrouter/google/gemini-3-pro-preview`). Always use `provider/model` form to avoid registry resolution surprises. |
| `--fork` | run/chain/parallel | Run the subagent in a forked context (pi-subagents `context: "fork"`). |
| `--worktree` | parallel | Create an isolated git worktree per task. Requires a clean working tree. |
| `--mcp <list>` | run/chain/parallel | Attach MCP tools to this dispatch (comma-separated `server/tool`). See [MCP tools](#mcp-tools). |
| `--cwd <path>` | run/chain/parallel | Run pi in a different working directory. |
| `--yes` | setup | Auto-apply scaffold/gitignore fixes. |

### Identifiers

Every job has two IDs:

- **`internal_id`** — short, stable: `job-001`, `job-002`. For humans.
- **pi run id** — the long uuid pi gives back. Canonical.

`/pi:status`, `/pi:result`, `/pi:cancel` accept either, plus any
unambiguous prefix of the pi run id.

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

Any `/pi:run implementer …` then has those MCP tools available without
extra flags.

If you want a **per-dispatch** MCP override (one-off experimentation,
or attaching tools to a builtin like `scout` without committing changes
to your seed), use the `--mcp` flag. The broker writes a temporary
agent file with the extra tools, dispatches under that name, and cleans
up after asyncId capture:

```text
/pi:run scout "find auth bugs" --mcp memory/store,memory/read --bg
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

```text
/pi:chain scout["map the affected modules"] -> oracle["critique the plan and surface risks"] --bg
```

(`oracle` is one of pi-subagents' builtins, defaulting to `gpt-5.5`.
Use `--model openrouter/openai/gpt-5.5` if you don't have ChatGPT Plus
auth.)

### Fan out with isolation

```text
/pi:parallel scout["audit frontend"] scout["audit backend"] scout["audit infra"] --worktree --bg
```

Each scout gets its own worktree under `/tmp/pi-worktree-<runId>-<n>`,
torn down at run end. Requires a clean git working tree.

### Lightweight test harness

```text
/pi:chain test-writer["pin the contract for src/auth.ts"] -> test-reviewer["find gaps"] -> implementer["make the suite green"] -> code-reviewer["adversarial review"] --bg
```

Each step's output (written to `{chain_dir}/<configured-output>`) is
consumed by the next step.

### Attach MCP tools just for this dispatch

```text
/pi:run worker "implement the planned migration using the test-runner MCP" --mcp test-runner/run_suite,test-runner/diff --bg
```

---

## How it works

```text
┌─ Claude Code session ────────────────────────────────────────┐
│                                                               │
│  /pi:* slash command                                          │
│       │                                                       │
│       ▼                                                       │
│  plugins/pi/scripts/pi-broker.mjs <action> <args…>            │
│       │                                                       │
│       ▼                                                       │
│  args.mjs (parse) → pi-cli.mjs (spawn pi --mode rpc) ──┐      │
│                                                         │      │
│  ┌──────────────────────────────────────────────────────┴───┐  │
│  │ pi (Node ≥20) loads pi-subagents extension              │  │
│  │   handles slash command (/run|/chain|/parallel)         │  │
│  │   OR direct subagent tool_call (--worktree path)        │  │
│  │   emits subagent-slash-result with asyncId+asyncDir     │  │
│  └──────────────────────────────────────────────────────┬───┘  │
│                                                         │      │
│       ◀─ broker captures asyncId, closes stdin ──────── ┘      │
│       │                                                       │
│       ▼                                                       │
│  state.json patch + /tmp/pi-subagents-uid-<uid>/...           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### State on disk

| Path | Purpose | Owner |
|---|---|---|
| `./.pi-cc-plugin/state.json` | Broker's job ledger (internal_id, runId, kind, agents, status) | `pi-cc-plugin` |
| `/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/` | Pi-subagents' run state — `status.json`, `events.jsonl`, `output-N.log`, `subagent-log-<runId>.md` | `pi-subagents` |
| `~/.pi/agent/auth.json` | Provider credentials (`0600`) | pi |
| `~/.pi/agent/extensions/`, `<npm-global>/pi-subagents/` | Extension code | pi |

The plugin never touches pi's state; it only reads. The broker's
`state.json` auto-reconciles with pi's `status.json` on every
`/pi:status` and `/pi:result`.

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
      actions/{run,chain,parallel,status,result,cancel,setup}.mjs
  agents-seed/                     # six default specialists
  commands/                        # one .md per slash command
  skills/{pi-cc-usage,pi-cc-harness}/SKILL.md
docs/
  DESIGN.md                        # architecture + decisions
  IMPLEMENTATION_PLAN.md           # milestones (M1–M10)
  PI_INVOCATION.md                 # verified contract with real pi
  DOGFOOD.md                       # manual QA script
```

Run `/pi:setup --yes` against a freshly-cloned repo to confirm everything
works end-to-end before dogfooding model dispatches.

---

## Status

**Stable** — broker dispatch, status, result, cancel, chain, parallel,
worktree (via tool_call path), `--mcp`, auto-reconcile.

**Reserved** — `--wait` foreground mode (only `--bg` is wired today).

**Out of scope (v1)** — `/pi:steer` (pi-subagents has no steering API),
pi-intercom bridge, integrated MCP server (state lives elsewhere).

---

## Related

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) —
  the underlying multi-provider CLI.
- [pi-subagents](https://github.com/nicobailon/pi-subagents) — extension
  that provides the `subagent` tool + `/run`, `/chain`, `/parallel`
  slash commands inside pi.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) — the host.

License: MIT.

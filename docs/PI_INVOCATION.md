# Pi invocation contract

How `pi-cc-plugin` calls the [`pi`](https://github.com/mariozechner/pi-coding-agent)
CLI with [`pi-subagents`](https://github.com/nicobailon/pi-subagents) installed.

> **Status: VERIFIED & SHIPPING.** All §1–§8 items confirmed against live
> pi (`@mariozechner/pi-coding-agent@0.70.2`+, `pi-subagents`@latest) and
> exercised by the broker in production. The original "TBD-VERIFY" items
> from this doc's pre-implementation draft have been resolved; this file
> is now reference for the protocol shape, not a checklist. The
> `pi --mode rpc` adapter rewrite mentioned below has shipped.

## 1. Binary resolution (`scripts/lib/pi-spawn.mjs`)

**VERIFIED 2026-04-25.** `package.json` of `@mariozechner/pi-coding-agent`
declares `bin.pi = "dist/cli.js"`. Resolution rules in our broker:

| Platform | Resolution |
|---|---|
| Unix (linux, darwin) | `pi` on `PATH` |
| Windows | `require.resolve("@mariozechner/pi-coding-agent/package.json")` → run `bin.pi` script with `process.execPath` |

Confirmed against the installed package layout
(`dist/cli.js` is `#!/usr/bin/env node`, calls `main(process.argv.slice(2))`).

## 2. Non-interactive `subagent` call

**VERIFIED 2026-04-25 — and the broker assumption was wrong.**

Pi has **no** `pi exec '<json>'` form. The actual non-interactive options
are:

| Mode | Invocation | Output |
|---|---|---|
| Print | `pi "<prompt>"` (or piped stdin) | Final assistant text on stdout |
| JSON event stream | `pi --mode json "<prompt>"` | One JSON event per line on stdout |
| RPC | `pi --mode rpc --no-session` | JSON-RPC over stdio (commands in, events out) |

For us, **`--mode rpc`** is the right path. The broker should:

1. Spawn `pi --mode rpc --no-session [--model <m>] [--cwd <p>]`.
2. Send a JSON-RPC `prompt` command on stdin telling pi to call the
   `subagent` tool with our payload.
3. Read JSON events from stdout (`tool_execution_start`,
   `tool_execution_end`, etc.) to capture the subagent's run id.

Framing: strict JSONL with `\n` only (per `docs/rpc.md`). Do **not** use
Node's `readline` — it splits on `U+2028`/`U+2029` which can appear
inside JSON strings. The broker has its own line splitter.

> **Broker status (resolved):** `scripts/lib/pi-cli.mjs` now spawns
> `pi --mode rpc --no-session`, sends a `prompt` frame containing
> pi-subagents' `/run` slash command (or a `subagent` tool_call for the
> `--worktree` path), and watches stdout for the
> `subagent-slash-result` custom message. See the "Dispatch" diagram in
> the README for the full flow.

### Subagent payload shape (VERIFIED 2026-04-25 from nicobailon/pi-subagents source)

Pi-subagents registers a single `subagent` tool with three modes (per
`index.ts` header comment):

| Mode | Required fields | Optional |
|---|---|---|
| Single | `agent`, `task` | `async`, `model`, `fork`, `cwd`, `output`, `reads`, `skill`, `progress` |
| Parallel | `tasks[]` (each `{agent, task, ...}`) | `async`, `worktree` |
| Chain | `chain[]` (each `{agent, task, ...}` — `{previous}` is templated) | `async`, `fork` |

`async` defaults to `false` (configurable via
`~/.pi/agent/extensions/subagent/config.json#asyncByDefault`). `--bg` in
the slash form maps to `async: true`.

Pi-subagents also registers slash commands `/run`, `/chain`, `/parallel`,
`/agents` (the manager TUI), and `/subagents-status` (read-only overlay
of active runs). These are *inside* pi — to drive them from outside we
either send the slash command as an RPC `prompt` or call the `subagent`
tool directly via RPC `tool_call`.

Status / cancel under pi-subagents:
- Status: `subagent({ action: "status", id })` — see `run-status.ts`.
- Cancel: send the appropriate event (`SLASH_SUBAGENT_CANCEL_EVENT` per
  `slash-bridge.ts`) or use the slash overlay's keybindings.

### Where pi-subagents writes state — VERIFIED 2026-04-25 via live run

Two locations exist and they serve different purposes:

| Path | Purpose |
|---|---|
| `/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/` | **Async run state** — `status.json`, `events.jsonl`, `output-0.log`, `subagent-log-<runId>.md`. Persists across runs; the broker reads from here. |
| `~/.pi/agent/sessions/<parent-session-id>/<runId>/run-<n>/` | Per-run scratch dir tied to the parent pi RPC session. Empty in `--no-session` mode. |
| `~/.pi/agent/sessions/<parent>/subagent-artifacts/<runId>_<agent>_*` | Per-agent input/meta/output artifacts (for the agent manager TUI). |

The `<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/` path
is the canonical answer for `--bg` runs and what the broker reads.
The fake-pi fixture mirrors this layout exactly (numeric uid suffix).

### status.json shape — VERIFIED 2026-04-25 via live run

```json
{
  "runId": "6317987c-...",
  "mode": "single",
  "state": "running" | "complete" | "failed",
  "lastActivityAt": 1777105811475,
  "startedAt": 1777105811474,
  "lastUpdate": 1777105812467,
  "pid": 1084636,
  "cwd": "/abs/path",
  "currentStep": 0,
  "steps": [
    {
      "agent": "scout",
      "status": "complete" | "running" | "failed",
      "skills": [],
      "model": "openrouter/moonshotai/kimi-k2.6",
      "attemptedModels": [...],
      "modelAttempts": [{...}],
      "startedAt": 1777105811475,
      "endedAt": 1777105812466,
      "durationMs": 991,
      "exitCode": 0,
      "error": null
    }
  ],
  "artifactsDir": "/tmp/pi-subagents-uid-<uid>/artifacts",
  "sessionDir": "/tmp/pi-subagent-session-<rand>/<short>/async-<runId>",
  "outputFile": ".../async-subagent-runs/<runId>/output-0.log"
}
```

Note: `state` uses `"complete"` (not `"completed"`) and `"failed"`.
Steps' `status` follows the same vocabulary. The broker normalizes via
`mapPiState` in `pi-status-reader.mjs` — both spellings map to the
broker's `"completed"` token.

### Capturing the run id — VERIFIED 2026-04-25 via live run

When `prompt: "/run <agent> \"<task>\" --bg"` is sent over RPC, pi-subagents
emits a custom message before `agent_start`:

```json
{
  "type": "message_start",
  "message": {
    "role": "custom",
    "customType": "subagent-slash-result",
    "details": {
      "result": {
        "details": {
          "mode": "single",
          "results": [],
          "asyncId": "<run-uuid>",
          "asyncDir": "/tmp/pi-subagents-uid-<uid>/async-subagent-runs/<run-uuid>"
        }
      }
    }
  }
}
```

The broker watches stdout for this `customType: "subagent-slash-result"`
message and pulls `details.asyncId` + `details.asyncDir`. That's the
canonical handle.

### Caveat: the LLM agent loop ALSO runs

After the slash dispatches the subagent, pi's main agent loop processes
the same prompt as a regular user message. It often duplicates work
(e.g., runs `find` itself even though scout was dispatched). To avoid
this duplicate work, the broker should close stdin immediately after
capturing the run id — the detached subagent continues, the wasted LLM
turn is cut short.

### Model resolution gotcha

Bare model IDs like `moonshotai/kimi-k2.6` resolve via pi's registry
search and may pick the wrong provider (e.g., `huggingface` if the user
has no HF key). Always use the fully-qualified `provider/model` form
in agent overrides, e.g. `openrouter/moonshotai/kimi-k2.6`.

### Where pi-subagents agents live — VERIFIED 2026-04-25

| Scope | Path | Priority |
|---|---|---|
| Builtin (ships with extension) | `~/.pi/agent/extensions/subagent/agents/` | Lowest |
| User | `~/.pi/agent/agents/{name}.md` | Medium |
| Project | `.pi/agents/{name}.md` (searches up) | Highest |

Our `/pi:setup` scaffolds into `.pi/agents/` — correct, project scope.

Builtin agents the extension ships: `scout`, `planner`, `worker`,
`reviewer`, `context-builder`, `researcher`, `delegate`, `oracle`,
`oracle-executor`. Our seeds (architect, test-writer, etc.) override
nothing — they sit alongside the builtins.

## 3. Where pi writes durable state

**VERIFIED 2026-04-29.** Pi-subagents writes per-run artifacts to
`<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/`:

| File | Written by | Read by broker via |
|---|---|---|
| `status.json` | pi-subagents lifecycle | `readPiStatus` |
| `events.jsonl` | pi-subagents lifecycle + child pi (re-emitted) | `readPiEvents` |
| `output-N.log` | child pi stdout (per step) | `readPiResult` |
| `subagent-log-<runId>.md` | pi-subagents (human-readable) | `readPiLog` |

`events.jsonl` is the richest signal: one JSON object per line covering
`subagent.run.started` / `.completed`, `subagent.step.started`,
`subagent.parallel.*`, `subagent.control`, plus every event the child
pi emits in `--mode json` (tool calls, message chunks, usage, errors)
re-tagged with `subagentSource: "child"`. The broker forwards it raw
to `/pi:status` so the orchestrator can interpret without any
broker-side summarization.

Pi itself writes session data under `~/.pi/agent/` (configDir from
`package.json#piConfig.configDir`). The broker doesn't read this — pi
manages it.

## 4. Run-id emission on launch

**VERIFIED & SHIPPING.** Run identification comes from JSON events on
pi's RPC stdout, not stdout markers. Two cases:

| Dispatch path | Event the broker watches for | Fields it pulls |
|---|---|---|
| Slash form (default `/run …`) | `message_start` / `message_end` with `role: "custom"`, `customType: "subagent-slash-result"` | `details.result.details.asyncId`, `.asyncDir` |
| Tool_call form (`--worktree`) | `tool_execution_end` with `toolName: "subagent"` | `result.details.asyncId`, `.asyncDir` |

See `scripts/lib/pi-cli.mjs#captureRun` for the implementation. Once
captured, the broker closes stdin so pi's parent agent loop
short-circuits — the detached subagent continues independently.

## 5. Cancel semantics

**VERIFIED & SHIPPING.** Under `--bg`, the parent pi process exits
right after emitting `subagent-slash-result` (the broker closes
stdin). The actual subagent work runs in a detached child pi tree,
not in the dispatching pi. So cancel is a process-tree problem, not
an RPC one.

`scripts/lib/process-tree.mjs` walks the running process list looking
for any process whose argv mentions the runId, then SIGTERMs them
(grace `PI_BROKER_SIGTERM_GRACE_MS`, default 5s) and escalates to
SIGKILL if they don't exit. The broker also marks the job
`cancelled` in `state.json` immediately so subsequent `/pi:status`
reads reconcile correctly even if pi-subagents' `status.json` freezes
mid-update.

## 6. Pi MCP config

**VERIFIED 2026-04-25** that pi reads MCP servers from settings under
`~/.pi/agent/`. Exact filename TBD (the docs reference `auth.json`,
`models.json`, `extensions/`; the MCP equivalent isn't named in the
shipped docs). The broker's `/pi:setup` step still prints the JSON for
manual paste rather than writing it; that's a safe default.

## 7. Pi-subagents install detection — VERIFIED 2026-04-25

Pi has no `list-extensions` flag. Two install modes exist and they
conflict if both are run:

| Mode | Command | Lands at | Loaded as |
|---|---|---|---|
| pi-managed npm package | `pi install npm:pi-subagents` | `<global-npm-root>/pi-subagents` | extension via pi's `packages[]` |
| Standalone git clone | `npx pi-subagents` | `~/.pi/agent/extensions/subagent` | extension via auto-discovery |

Both register the same `subagent` tool, so running both produces:
`Error: Tool "subagent" conflicts with ...`. Pick one. The pi-managed
form is preferable because `pi update` keeps it current.

The README documents `pi install npm:pi-subagents` as the recommended
path, but its installer message also recommends `npx pi-subagents` as a
follow-up — that's misleading; do NOT run both.

Detection: `pi list` is authoritative for the npm-managed install
(reads pi's `packages[]` from settings). FS check at
`~/.pi/agent/extensions/subagent` covers the standalone install.
`setup-checks.mjs#checkPiSubagentsInstalled` uses `pi list` today.

## 7b. PATH propagation — VERIFIED 2026-04-25

Pi-coding-agent at startup re-checks installed packages and may spawn
its own `npm` child (e.g. on first run after install). That child needs
to find the same npm whose `npm root -g` reported the install location
— if the PATH puts a different Node's npm first, pi tries to install to
that npm's global root and fails with EACCES (the common case: Claude
Code's subprocess inherits system Node 18's npm pointing at
`/usr/local/lib/node_modules`).

The broker fixes this in `pi-spawn.mjs#piSpawnEnv` by prepending the
selected Node's bin dir to PATH. Callers (`pi-cli.mjs`, `setup-checks.mjs`)
must use this when spawning pi.

## 8. Auth — provider API keys

**VERIFIED 2026-04-25.** Pi reads provider credentials from two sources,
in this priority order:

1. **`~/.pi/agent/auth.json`** (created with `0600`):
   ```json
   {
     "anthropic": { "type": "api_key", "key": "sk-ant-..." },
     "openai":    { "type": "api_key", "key": "sk-..." },
     "openrouter":{ "type": "api_key", "key": "sk-or-..." }
   }
   ```
   The `key` field also accepts `"!shell-command"` (executes and uses
   stdout) and `"$ENV_VAR_NAME"` (reads env var by name).
2. **Environment variables**, by provider:

| Provider | Env var | `auth.json` key |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| **OpenRouter** | **`OPENROUTER_API_KEY`** | **`openrouter`** |
| xAI | `XAI_API_KEY` | `xai` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |

OAuth-based subscription providers (Claude Pro/Max, ChatGPT Plus, GitHub
Copilot, Gemini CLI) are configured via `/login` in interactive pi.

Operationally for `pi-cc-plugin`: the broker doesn't need pi auth — pi
manages it. Tell users to run `pi` once and `/login`, or set the env var
their model uses.

## 9. Verification checklist — DONE

Original pre-implementation checklist, all resolved:

- [x] §2 `pi --mode rpc --no-session` works from a clean install.
- [x] §2 JSON-RPC dispatch shape (slash + tool_call paths) verified.
- [x] §3 per-run state dir confirmed at
      `<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/`.
- [x] §4 run-id captured from the `subagent-slash-result` custom
      message (slash form) or `tool_execution_end` (tool form).
- [x] §5 cancel = process-tree walk by runId (not an RPC command).
- [x] §6 pi's MCP wiring is per-agent via the `tools:` line
      (`mcp:server/tool` entries) — no separate config file needed.
- [x] §7 broker uses `pi list` to detect the npm-managed install.

The fake-pi fixture mirrors the verified RPC + on-disk shape, so the
offline CI suite drives the broker through the same surface real pi
exposes (modulo tiny synthetic event streams; see
`tests/fixtures/fake-pi.mjs#runFinalize`).

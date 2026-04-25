# Pi invocation contract

How `pi-cc-plugin` calls the [`pi`](https://github.com/mariozechner/pi-coding-agent)
CLI with [`pi-subagents`](https://github.com/nicobailon/pi-subagents) installed.

> **Status: PARTIALLY VERIFIED 2026-04-25.** Verified against
> `@mariozechner/pi-coding-agent@0.70.2` source + bundled docs (no live run —
> sandbox is on Node 18, pi requires Node ≥20). Items still marked
> **TBD-VERIFY** need confirmation against a live pi run before the first
> dogfood release. The broker's current adapter assumed a `pi exec '<json>'`
> form that does **not** exist in real pi — see §2 for the correction.

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

> **Broker status:** the current `scripts/lib/pi-cli.mjs` was built against
> the old (wrong) assumption. It works fine against the fake-pi fixture
> (which mimics that contract), so all 91 tests pass — but it will not
> work against real pi without an adapter rewrite. That refactor is the
> first thing M10 dogfooding will surface; tracking as a follow-up.

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
is the canonical answer for `--bg` runs and what the broker should
read. The fake-pi fixture's
`<tmpdir>/pi-subagents-user/async-subagent-runs/...` is close but the
suffix is `uid-<uid>` (numeric uid), not `user`. Adjust during the M4
broker rewrite.

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
Steps' `status` follows the same vocabulary. The fake-pi fixture
emits `"completed"` and needs adjustment.

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

**TBD-VERIFY.** The broker's fake-pi fixture writes:

```
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<run-id>-<slug>/
  status.json        # current state of the run
  events.jsonl       # one JSON event per line
  log.md             # human-readable transcript
  result.md          # final output (only after completion)
```

Pi itself writes session data under `~/.pi/agent/` (configDir from
`package.json#piConfig.configDir`). The pi-subagents extension may write
its run dirs there or under `<tmpdir>/...`. Confirm during dogfood.

## 4. Run-id emission on launch

**SUPERSEDED.** Under `--mode rpc`, run identification comes from JSON
events on stdout, not stdout markers. The relevant events are
`tool_execution_start` (which carries `toolCallId`) and the eventual
`tool_execution_end`. Map the subagent's run id by reading the
`tool_execution_end.result` payload. This requires reshaping
`scripts/lib/pi-cli.mjs#collectMarkers` from line-prefix parsing to
JSON-event parsing.

The fake-pi fixture's `run-id:` / `status-dir:` markers are a
test-fixture convention only — they don't exist on real pi.

## 5. Cancel semantics

**TBD-VERIFY.** Under `--mode rpc`, pi exposes a `cancel` JSON-RPC command
(see `docs/rpc.md`). The broker's cancel flow becomes:

1. Send `{"type":"cancel"}` on stdin to the running pi process.
2. Wait for the corresponding `response`.
3. Fall back to SIGTERM → SIGKILL if pi doesn't respond.

The current cancel implementation talks via `piExec(...)` to a separate
pi process; that's wrong for an `--mode rpc` setup, where you keep the
same stdio pipe open. Refactor alongside §2.

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

## 9. Verification checklist (before first dogfood release)

Hard items the rewrite hinges on:

- [ ] §2 confirm `pi --mode rpc --no-session` works from a clean install.
- [ ] §2 confirm the JSON-RPC shape needed to invoke the `subagent` tool.
- [ ] §3 confirm where `pi-subagents` writes its per-run state dir.
- [ ] §4 capture run-id from `tool_execution_*` events.
- [ ] §5 confirm `cancel` command behavior.
- [ ] §6 confirm pi's MCP config filename.
- [ ] §7 swap broker detection from `list-extensions` to FS check.

After verification: replace the fake-pi fixture's marker-based protocol
with a JSON-RPC harness so CI continues to drive the broker through the
same surface real pi exposes.

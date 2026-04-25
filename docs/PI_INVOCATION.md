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

### Subagent payload shape (still TBD-VERIFY)

The exact JSON shape that the `subagent` tool from `pi-subagents` accepts
hasn't been confirmed against the nicobailon fork. The shapes the broker
emits today (single / chain / parallel / status / cancel) are speculative.
Confirm during dogfood and update both this doc and the parser in
`args.mjs#parseArgs` if they don't match.

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

## 7. Pi-subagents install detection

**TBD-VERIFY.** Pi has no `list-extensions` flag in the version we
inspected (0.70.2). Extensions live in `~/.pi/agent/extensions/` (auto-
discovered, hot-reloadable via `/reload`) or are loaded with `pi -e`.

Detection alternatives the broker can use:

- File-system check: `~/.pi/agent/extensions/pi-subagents*` exists.
- Project-local: `.pi/extensions/pi-subagents*` exists.

Update `setup-checks.mjs#checkPiSubagentsInstalled` to use file-system
detection instead of `list-extensions`. The fake-pi fixture's
`list-extensions` handler was speculative; remove or repoint when this
lands.

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

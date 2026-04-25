# pi-cc-plugin

Claude Code plugin that delegates work to
[`pi-subagents`](https://github.com/nicobailon/pi-subagents) (nicobailon
fork). Sister project to `team-tracking-mcp` — this plugin handles
*execution*, the team-tracking plugin handles *state*.

See [`DESIGN.md`](DESIGN.md) for the architecture and
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for milestones.

## Slash commands

| Command | Purpose |
|---|---|
| `/pi:setup` | Verify pi + pi-subagents, scaffold default specialist agents. |
| `/pi:run <agent> <task…>` | Delegate one task to one pi agent. |
| `/pi:chain <agent>["task"] -> <agent>["task"] …` | Run a chain. |
| `/pi:parallel <agent>["task"] <agent>["task"] …` | Run in parallel. |
| `/pi:status [id]` | List active runs, or inspect one. |
| `/pi:result <id>` | Final output of a completed run. |
| `/pi:cancel <id>` | Abort a running job. |

## Install

```
/plugin marketplace add /path/to/pi-cc-plugin
/plugin install pi@pi-cc-plugin
```

Then run `/pi:setup` once per workspace.

## Configuring an LLM provider for pi

Pi reads credentials from `~/.pi/agent/auth.json` (preferred, `0600`-secured)
or from per-provider environment variables. Quickest setups:

- **OpenRouter (one key, every model):**
  ```bash
  export OPENROUTER_API_KEY=sk-or-...        # one-shot
  echo 'export OPENROUTER_API_KEY=sk-or-...' >> ~/.bashrc   # persisted
  ```
  Or store it pi-side via `pi` → `/login` → OpenRouter.
- **Anthropic / OpenAI / Gemini direct:** use `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY` respectively.
- **Subscription providers (Claude Pro/Max, ChatGPT Plus, Copilot, Gemini
  CLI):** run `pi`, type `/login`, pick one.

See [`docs/PI_INVOCATION.md`](docs/PI_INVOCATION.md) §8 for the full
provider/env-var matrix.

## Development

```
npm install
npm test          # offline tests against the fake-pi fixture
npm run lint      # biome
PI_SMOKE=1 npm run test:smoke   # only when a real pi is installed
```

Status: in active development. M1 (verifying the real pi CLI contract) is
captured in `docs/PI_INVOCATION.md` with TBD-VERIFY markers.

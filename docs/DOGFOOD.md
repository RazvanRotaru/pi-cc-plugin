# Dogfooding `pi-cc-plugin`

Manual QA script. Run before each release. Not in CI — exercises the real
`pi` CLI and real `pi-subagents` against a live workspace.

Set up:

```bash
# Install pi if you don't have it (requires Node ≥20)
npm i -g @mariozechner/pi-coding-agent

# Install pi-subagents (nicobailon fork) — pi's package manager handles it
pi install npm:pi-subagents

# Configure at least one LLM provider for pi.
# Easiest: OpenRouter (one key, all models).
export OPENROUTER_API_KEY=sk-or-...
echo 'export OPENROUTER_API_KEY=sk-or-...' >> ~/.bashrc
# Or use pi's auth file:
pi   # then /login → OpenRouter

# Install this plugin into Claude Code
/plugin marketplace add /path/to/pi-cc-plugin
/plugin install pi@pi-cc-plugin
/reload-plugins
```

Each step below should be tried in a fresh workspace (a throwaway
`mkdir /tmp/pi-cc-dogfood && cd /tmp/pi-cc-dogfood && git init` works fine).

## 1. `/pi:setup` against a real pi install

```
/pi:setup --yes
```

Expected (all green):
- `pi installed` ✓ (resolves via npm-global lookup or nvm)
- `pi-subagents installed` ✓ (after `pi install npm:pi-subagents`)
- `.gitignore` updated to ignore `.pi-cc-plugin/`
- 6 specialist seeds copied to `.pi/agents/`
- `setup done.`

If `pi installed` fails: `which pi`, `node --version` ≥ 20.
If `pi-subagents installed` fails: `pi list | grep pi-subagents`.

## 2. `/pi:run` with a Claude model

```
/pi:run worker write a one-paragraph haiku about caches --model anthropic/claude-sonnet-4-6 --bg
```

Expected:
- `Started job-001 (pi-run-id <uuid>) — agent=worker, model=anthropic/claude-sonnet-4-6`
- `/pi:status job-001` shows running, then completed (within ~30s).
- `/pi:result job-001` returns a haiku.

## 3. `/pi:run` with a non-Claude model

This is the load-bearing test for the design — pi is what makes
non-Claude specialists possible.

```
/pi:run worker same haiku task --model openrouter/google/gemini-3-pro-preview --bg
# or:
/pi:run worker same haiku task --model openrouter/openai/gpt-5.5 --bg
```

Expected: same shape as step 2, but the result text comes from the
non-Claude model. status.json's `steps[].model` field will record
exactly what we passed.

Verify: `cat /tmp/pi-subagents-uid-$(id -u)/async-subagent-runs/<uuid>/status.json | jq '.steps[].model'`.

## 4. `/pi:chain` and `/pi:parallel`

```
/pi:chain scout["map the test files"] -> reviewer["summarize what scout produced"] --bg
/pi:parallel scout["count .mjs files"] scout["count .md files"] --worktree --bg
```

Expected:
- Each command returns immediately with a single internal_id.
- `/pi:status <id>` shows per-step status.
- `/pi:result <id>` concatenates per-step `output-N.log` under headers.

## 5. Mid-flight cancel

```
# Start a long-ish run
/pi:run worker think out loud about caches for 500 words --bg

/pi:status                      # confirm it's running
/pi:cancel job-001              # SIGTERM the pi-subagents parent

/pi:status job-001              # state shows cancelled
```

Expected:
- Cancel returns within ~5s (SIGTERM grace).
- state.json reflects cancelled at top; pi-subagents' status.json may
  freeze mid-update — render shows `pi-status: running (broker says: cancelled)`.

## 6. Forced model failure surfaces clearly

```
/pi:run worker test --model openrouter/no-such-model --bg
/pi:status job-001
```

Expected:
- Top line: `completed` (pi-subagents lifecycle ran to its end).
- Steps line: `worker: complete (error)`.
- `step-errors:` block shows the underlying API error message.

## Sign-off

When all six steps pass, tag the release:

```bash
npm version patch     # or minor / major
git push --follow-tags
```

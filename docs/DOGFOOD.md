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

## 4. Fan out via multiple `/pi:run` calls

In one assistant turn (Claude Code runs tool calls concurrently):

```
/pi:run scout "count .mjs files" --bg
/pi:run scout "count .md files"  --bg
```

Expected: two distinct internal_ids, both `running`, both `completed`
within ~30s.

For sequential pipelines, dispatch the next step from the orchestrator
after reading the previous step's `/pi:result` — this keeps the
orchestrator (Claude) in the loop to validate intermediate output.

## 4a. `--worktree` isolation on `/pi:run`

```
/pi:run scout "count js files" --worktree --bg
```

Expected:
- Returns immediately with an internal_id.
- Pi-subagents creates `/tmp/pi-worktree-<runId>-<n>` and runs the
  agent there; teardown happens at run end.
- Requires a clean git working tree.
- Dispatches via a tool-call prompt (LLM-forwarded JSON) since
  pi-subagents' slash grammar doesn't expose `--worktree` natively.
  Adds ~3-5s of dispatch latency vs slash.

## 4b. GAN flow with the seed agents

```
/pi:run architect "review plugins/pi/scripts/lib/pi-cli.mjs and propose 2 simplifications" --bg
/pi:status job-N           # poll until completed
/pi:result job-N           # read the architect's brief
```

Expected: the architect specialist (project-local in `.pi/agents/`)
produces a brief. Same for `test-writer`, `test-reviewer`, `implementer`,
`code-reviewer`, `ci-triage`. Specialists default to claude models per
their seed frontmatter — pi will fall back to the workspace's
`~/.pi/agent/settings.json#agentOverrides` if the model isn't reachable
(e.g. claude.ai not auth'd, then OpenRouter only).

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

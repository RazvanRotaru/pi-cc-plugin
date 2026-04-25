# Dogfooding `pi-cc-plugin`

Manual QA script. Run before each release. Not in CI — exercises the real
`pi` CLI and real `pi-subagents` against a live workspace.

Set up:

```bash
# Install pi if you don't have it (requires Node ≥20)
npm i -g @mariozechner/pi-coding-agent

# Install pi-subagents (nicobailon fork)
pi install npm:pi-subagents

# Configure at least one LLM provider for pi.
# Easiest: OpenRouter (one key, all models).
export OPENROUTER_API_KEY=sk-or-...
# Persist it:
echo 'export OPENROUTER_API_KEY=sk-or-...' >> ~/.bashrc
# Or use pi's auth file (0600-secured):
pi   # then /login → OpenRouter → paste key

# Install this plugin into Claude Code
/plugin marketplace add /path/to/pi-cc-plugin
/plugin install pi@pi-cc-plugin
```

> **Heads up before you start:** `docs/PI_INVOCATION.md` flags that the
> broker's current `pi-cli.mjs` was written against a `pi exec '<json>'`
> form that doesn't exist in real pi. Real pi uses `--mode rpc`. The
> first dogfood run will surface this — the broker needs an adapter
> rewrite before it actually drives a real pi process. The slash-command
> surface, args parser, state file, and skills are all real-pi-ready;
> only `pi-cli.mjs` (and parts of `setup-checks.mjs`) need updating.

Each step below should be tried in a fresh workspace (a throwaway
`mkdir /tmp/pi-cc-dogfood && cd /tmp/pi-cc-dogfood && git init` works fine).

## 1. `/pi:setup` against a real pi install

```
/pi:setup --yes
```

Expected:
- `pi installed` ✓
- `pi-subagents installed` ✓ (after the install command above)
- `.gitignore` updated to ignore `.pi-cc-plugin/`
- 6 specialist seeds copied to `.pi/agents/`
- `team-tracking-mcp registration` shows the JSON snippet for manual paste

If `pi installed` fails: re-check `which pi`. If `pi-subagents installed`
fails: `pi list-extensions --json` and confirm what pi reports.

## 2. `/pi:run` with a Claude model

```
/pi:run worker "Write a one-paragraph haiku about caches" --model anthropic/claude-sonnet-4-6
```

Expected:
- `Started job-001 (pi-run-id <uuid>)` returned within ~2s.
- `/pi:status job-001` shows running, then completed (within ~30s).
- `/pi:result job-001` returns a haiku.
- Pi's run dir under `<tmpdir>/pi-subagents-*/async-subagent-runs/<uuid>-worker/`
  contains `status.json`, `result.md`, `log.md`.

## 3. `/pi:run` with a non-Claude model

This is the load-bearing test for the design — pi is what makes
non-Claude specialists possible.

```
/pi:run worker "Same haiku task" --model openai/gpt-5
# or:
/pi:run worker "Same haiku task" --model google/gemini-2.5-pro
```

Expected: same shape as step 2, but the result text comes from the
non-Claude model. Confirm by reading `.pi/agents/worker.md`'s default
model vs the override.

If pi can't dispatch to the requested model, the run fails fast with a
clear error in `pi-run-id <uuid>`'s `status.json.error`.

## 4. `/pi:run` that exercises team-tracking-mcp

Prereqs: `team-tracking-mcp` is installed in Claude Code AND registered
with pi (paste the snippet from step 1 into pi's MCP config).

```
# In Claude Code, create a ticket
team-tracking/create_ticket({
  project: "Dogfood",
  title: "Confirm pi-driven specialist reports progress",
  body: "Acquire this ticket. Append two log entries. Release."
})

# Acquire it from the orchestrator side
team-tracking/acquire_ticket({ ref: { project: "Dogfood", id: "<id>" }, owner: "manual-qa" })

# Dispatch to a pi specialist
/pi:run implementer "Acquire ticket Dogfood-<id> with lock token <lt>. Append two log lines (one for 'starting', one for 'done'), then release_ticket." --bg
```

Expected:
- `/pi:status <job>` shows running, then completed.
- `team-tracking/get_ticket` shows the two log entries.
- The lock is released by the specialist.

If progress entries don't land: the seed agent is missing the
team-tracking MCP tools in its frontmatter, or pi's MCP config doesn't
have team-tracking registered.

## 5. Mid-flight kill + recovery

```
# Start a long-ish run
/pi:run worker "Slowly write a 500-word essay about caches" --bg

# Confirm it's running
/pi:status

# Kill the pi process directly (pretending pi died — simulates a crash)
ps aux | grep "pi exec" | head -1
kill -9 <pid>

# From the orchestrator's perspective, the lock is now stale.
# Wait for the team-tracking-mcp lock TTL to expire (default 10min in tests),
# OR force-release via the test-only release path.

# Then dispatch a fresh retry
/pi:run worker "Resume essay from checkpoint at .work/<ref>/checkpoint.md" --bg
```

Expected:
- The dead run shows up in `/pi:status` as `running` (we don't auto-detect crashes).
- `/pi:cancel <id>` reconciles the state to whatever pi's status.json says,
  or marks `cancelled` if pi's status dir is gone.
- Fresh dispatch succeeds independently.

## Sign-off

When all five steps pass, tag the release:

```bash
npm version patch     # or minor / major
git push --follow-tags
```

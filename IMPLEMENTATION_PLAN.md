# pi-cc-plugin — Implementation Plan

Ordered milestones. Each is independently testable. Nothing downstream depends on anything we haven't shipped and tested.

## Principles

- Node 20. Plain `.mjs` scripts (mirror codex-plugin-cc — no TypeScript, no bundler). Biome for lint.
- Broker is a single file with `lib/` helpers. Every command is a thin markdown wrapper that invokes the broker.
- Tests use a **fake pi fixture** that mimics pi's stdout/stderr/status-file conventions — same pattern codex-plugin-cc uses with its fake-codex fixture. No real pi needed in CI.
- Real-pi smoke test is gated behind `PI_SMOKE=1` and skipped in OSS CI.

## Milestone 1 — Verify pi CLI contract

**Deliverable:** a short `docs/PI_INVOCATION.md` documenting exactly how we call pi non-interactively, based on hands-on testing.

Things to verify against the real pi + nicobailon's pi-subagents:

- Shell syntax for invoking the `subagent` tool with a JSON payload non-interactively.
- Where pi writes `status.json` / `events.jsonl` (exact path pattern for `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>-…`).
- How pi emits the run id on launch (stdout marker, stderr, or only via status file polling).
- How to read pi's per-run dir for streaming event events.
- How `subagent({ action: "status" })` output is shaped.
- How `subagent({ action: "status", id })` inspects one run.
- Whether there's a cancel API and how it maps to a process signal.
- Pi's MCP config file location and format.
- pi-subagents install/verify command (`pi list-extensions`, etc.).

**Done when:** `docs/PI_INVOCATION.md` has concrete commands that produce known output against a local pi install. This unblocks M3+.

## Milestone 2 — Repo scaffold

**Deliverable:** plugin repo skeleton that installs cleanly in Claude Code and prints a hello-world on `/pi:status`.

Files:

```
pi-cc-plugin/
  .claude-plugin/
    marketplace.json
  plugins/pi/
    .claude-plugin/plugin.json
    commands/status.md
    scripts/pi-broker.mjs           # stub: prints "pi-cc-plugin alive"
    scripts/lib/{args.mjs, render.mjs}
    skills/pi-cc-usage/SKILL.md     # stub
  package.json
  biome.json
  tests/fake-pi.mjs                 # fixture that will grow through later milestones
  tests/helpers.mjs
  tests/broker.test.mjs             # one smoke test
  .github/workflows/ci.yml
```

`marketplace.json` lists one plugin: `pi`. `plugin.json` registers the one `status` command and the usage skill.

**Done when:**
- `/plugin marketplace add <local-path>` + `/plugin install pi@…` works in Claude Code.
- `/pi:status` prints the alive message.
- `npm test` passes with one smoke test.

## Milestone 3 — Pi spawn + args

**Deliverable:** `scripts/lib/pi-spawn.mjs` (cross-platform pi binary resolution) and `scripts/lib/args.mjs` (pi slash-command syntax parser).

- Vendor nicobailon's `pi-spawn.ts` logic as `.mjs`. License attribution in NOTICE.
- Parser handles the pi-subagents slash grammar: `<agent>["task"]`, `->`, `--`, inline `[key=value,…]`, trailing `--bg` / `--fork` / `--wait`. Same grammar pi itself parses.
- Output: a normalized `subagent` tool call (JS object) ready to hand to pi.

**Tests:**
- Unit tests for the parser covering every grammar form in the pi-subagents README.
- pi-spawn tests using fixture env vars (mock `process.platform`, `process.argv[1]`, etc.).

**Done when:** given any pi-style slash string, we produce the right `subagent` payload; binary resolution works on linux (primary) with fixtures proving windows logic is sound.

## Milestone 4 — Broker core: run + state

**Deliverable:** `/pi:run <agent> <task> [--bg] [--wait] [--model <m>] [--fork] [--cwd <p>]` works end-to-end against the fake pi fixture.

Files:
- `scripts/pi-broker.mjs` — dispatch table: `action in {run, chain, parallel, status, result, cancel, setup}`. M4 implements `run` + `status` read.
- `scripts/lib/pi-cli.mjs` — spawns pi via `pi-spawn`, attaches stdio, emits job record.
- `scripts/lib/state.mjs` — reads/writes `./.pi-cc-plugin/state.json` with atomic rename. Handles concurrent writers (lockfile).
- `scripts/lib/tracked-jobs.mjs` — CRUD over jobs in state, assigns `internal_id` counters.
- `scripts/lib/gitignore.mjs` — copied from team-tracking-mcp design; ensures `.pi-cc-plugin/` is ignored.
- `plugins/pi/commands/run.md` — forwards args to broker.
- `plugins/pi/commands/status.md` — upgraded: lists jobs from state + enriches with pi status-dir contents.

Behavior:
- `--bg` (default for M4) spawns pi detached, records job, returns immediately with `internal_id` + `pi_run_id`.
- `--wait` spawns pi with stdio inherited, streams until pi exits.
- State file writes are atomic (tmp + rename); reads tolerate malformed JSON with a loud error.

**Tests:**
- Fake pi fixture emits realistic `status.json` / `events.jsonl`. Broker run path drives it.
- Concurrent `/pi:run` calls produce unique `internal_id`s and don't corrupt state.
- `.gitignore` is updated on first use.

**Done when:** in a throwaway Claude Code session with the fixture wired, `/pi:run scout "test"` launches the fixture, `/pi:status` reports it as running, then as completed.

## Milestone 5 — Result + cancel

**Deliverable:** `/pi:result <id>` and `/pi:cancel <id>`.

- `result` reads the run's final output from pi's status dir (markdown log + `status.json.result`), renders concisely.
- `cancel` signals the pi subprocess (SIGTERM, escalating to SIGKILL after N seconds). Updates our state to `cancelled`.
- Both accept either `internal_id` or `pi_run_id` (any unambiguous prefix).

**Tests:** fake pi fixture supports both the happy path (complete → result) and a slow path where the fixture ignores SIGTERM briefly (to exercise escalation).

**Done when:** full run → status → result → cancel lifecycle works against the fixture.

## Milestone 6 — Chain + parallel

**Deliverable:** `/pi:chain` and `/pi:parallel` commands.

- Both reuse M3's parser to produce chain/parallel `subagent` payloads.
- `--worktree` flag (parallel only) passes through to pi as `worktree: true`.
- State tracks multi-step jobs as one record with `kind: "chain" | "parallel"`, `agents: string[]`, per-step sub-statuses if pi exposes them.

**Tests:** fixture emits per-step events; broker renders a multi-step status tree.

**Done when:** `/pi:chain scout "a" -> planner "b" -> worker "c" --bg` runs against the fixture, `/pi:status` shows the 3-step progression, `/pi:result` returns the final output.

## Milestone 7 — Setup command

**Deliverable:** `/pi:setup` — idempotent verification + scaffolding.

Files:
- `scripts/lib/setup-checks.mjs` — checks for pi installed, pi-subagents installed, auth status, MCP config state, specialist seed presence.
- `plugins/pi/agents-seed/*.md` — one seed per role (`architect`, `test-writer`, `test-reviewer`, `implementer`, `code-reviewer`, `ci-triage`). Each declares the team-tracking-mcp tools it needs.
- `plugins/pi/commands/setup.md` — command definition.

Behavior:
- Each check runs in order. Step fails → print remediation, stop.
- Interactive confirmations for side effects (install pi-subagents, scaffold `.pi/agents/`, add to pi's MCP config). `--yes` flag for non-interactive.
- MCP config step: prints a JSON snippet to stdout. If pi's MCP config location is verified (M1 result), offers to update it automatically; otherwise asks user to paste.

**Tests:**
- Each check as a unit test with the fake pi fixture (fixture reports different "installed/missing" states on demand).
- Scaffolding creates `.pi/agents/` idempotently; re-running setup doesn't overwrite user-customized seeds.

**Done when:** `/pi:setup` takes a fresh workspace from zero to "can dispatch harness specialists via pi," prompting for confirmations along the way.

## Milestone 8 — Usage skill + harness skill

**Deliverable:** two skills the orchestrator can load.

- `skills/pi-cc-usage/SKILL.md` — general "how to use /pi:run etc." for any Claude Code user.
- `skills/pi-cc-harness/SKILL.md` — specific guidance for the harness orchestrator: when to dispatch via Agent tool vs `/pi:run`, how to pass the ticket ref + lock token to the pi specialist, how to interpret `/pi:status` and retry from checkpoint.

The harness skill is loaded by the workspace `CLAUDE.md` (user's responsibility). Separate from the core `harness-orchestrate` skill in `~/workspace/skills` — this skill is about *this plugin's* commands, not about orchestration logic.

**Done when:** both skills exist, cross-reference each other, and explicitly state they compose with `harness-orchestrate` + `team-tracking-mcp`.

## Milestone 9 — Integration test (scripted, no real pi)

**Deliverable:** end-to-end scripted test using the fake pi fixture.

- Spawn Claude Code SDK? No — go the same route as team-tracking-mcp M10: scripted driver that speaks directly to the broker (no LLM). Exercise: setup → run → status → result → cancel flows. Assert state file shape at each step.
- Fixture plays multiple scenarios: happy path, pi crash, pi timeout, status-dir purged, malformed JSON.

**Done when:** one test file drives the plugin through every command and every failure mode, green in CI.

## Milestone 10 — Dogfood notes

**Deliverable:** `docs/DOGFOOD.md` — a one-page manual QA script a human runs before each release.

Steps include:
- Real `/pi:setup` against a real pi install.
- Real `/pi:run` with a Claude model; confirm output makes sense.
- Real `/pi:run` with a non-Claude model (GPT or Gemini); confirm output makes sense.
- Real `/pi:run` that exercises team-tracking-mcp (requires team-tracking-mcp installed and configured). Confirm progress lands on the board.
- Kill the pi run mid-flight; confirm orchestrator sees stale lock and can retry.

Not CI'd — manual validation.

## Dependencies

```
M1 (verify pi contract) ─► M2 ─► M3 ─► M4 ─► M5 ─► M6 ─► M7 ─► M8 ─► M9
                                                                      │
                                                                      └─► M10
```

M1 is a prerequisite for M3+. If M1 reveals pi requires a fundamentally different integration (e.g., JSON-RPC server rather than shell spawn), the whole plan shifts. That's why it's M1, not M0.

## Out of scope for v1

- `/pi:steer` — add if/when pi-subagents exposes steering.
- Pi-intercom bridge — the orchestrator doesn't get interrupted by subagents.
- Team-tracking-mcp auto-install. This plugin assumes team-tracking-mcp is installed separately; `/pi:setup` only registers it with pi.
- Windows-first support. Linux/macOS are the primary targets. Windows pi-spawn logic is tested via fixture, not a real CI job.
- A TUI inside Claude Code. Status/result render as plain markdown.

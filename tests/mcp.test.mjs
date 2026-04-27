import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakePiEnv, runBroker, withTempCwd } from "./helpers.mjs";
import {
  prepareEphemeralAgents,
  rewriteAgentForMcp,
} from "../plugins/pi/scripts/lib/ephemeral-agents.mjs";
import { parseArgs } from "../plugins/pi/scripts/lib/args.mjs";
import { displayAgentName } from "../plugins/pi/scripts/lib/render.mjs";

async function withFakePiTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cc-mcp-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SAMPLE_AGENT = `---
name: scout
description: A scout agent.
model: anthropic/claude-haiku-4-5
tools: read, bash, grep, find
skills: clean-code
---

You are a scout. Find things.
`;

test("parseMcpList: --mcp parsing strips mcp: prefix and splits on commas", () => {
  const { payload } = parseArgs("run", [
    "scout",
    "find",
    "--bg",
    "--mcp",
    "team-tracking/get_ticket,mcp:team-tracking/append_log",
  ]);
  assert.deepEqual(payload.mcp, ["team-tracking/get_ticket", "team-tracking/append_log"]);
});

test("parseMcpList: empty --mcp value rejected", () => {
  // Args parser requires --mcp to have a value via splitFlags's FLAGS_VALUED check.
  assert.throws(() => parseArgs("run", ["scout", "task", "--mcp"]), /requires a value/);
});

test("parseMcpList: undefined when --mcp not passed", () => {
  const { payload } = parseArgs("run", ["scout", "task", "--bg"]);
  assert.equal(payload.mcp, null);
});

test("rewriteAgentForMcp: appends mcp: entries to existing tools list", () => {
  const out = rewriteAgentForMcp(SAMPLE_AGENT, "_pi-cc-tmp", [
    "team-tracking/get_ticket",
    "team-tracking/append_log",
  ]);
  assert.match(out, /name: _pi-cc-tmp/);
  assert.match(out, /tools: read, bash, grep, find, mcp:team-tracking\/get_ticket, mcp:team-tracking\/append_log/);
  // Body preserved.
  assert.match(out, /You are a scout/);
});

test("rewriteAgentForMcp: deduplicates if mcp already present", () => {
  const withMcp = SAMPLE_AGENT.replace(
    "tools: read, bash, grep, find",
    "tools: read, bash, mcp:team-tracking/get_ticket",
  );
  const out = rewriteAgentForMcp(withMcp, "_pi-cc-tmp", [
    "team-tracking/get_ticket",
    "team-tracking/append_log",
  ]);
  // get_ticket appears once.
  const matches = out.match(/mcp:team-tracking\/get_ticket/g) ?? [];
  assert.equal(matches.length, 1);
});

test("rewriteAgentForMcp: handles agent with no tools line — adds one", () => {
  const without = SAMPLE_AGENT.replace(/^tools:.*$/m, "");
  const out = rewriteAgentForMcp(without, "_pi-cc-tmp", ["server/tool"]);
  assert.match(out, /tools: mcp:server\/tool/);
});

test("rewriteAgentForMcp: missing frontmatter throws", () => {
  assert.throws(
    () => rewriteAgentForMcp("plain markdown no frontmatter\n", "x", ["a/b"]),
    /missing a YAML frontmatter/,
  );
});

test("rewriteAgentForMcp: overlays settings.json overrides (model swap)", () => {
  const out = rewriteAgentForMcp(SAMPLE_AGENT, "_tmp", ["a/b"], {
    model: "openrouter/foo/bar",
  });
  assert.match(out, /model: openrouter\/foo\/bar/);
  // Original model line replaced (only one model: line in result).
  const modelLines = out.match(/^model:.*$/gm) ?? [];
  assert.equal(modelLines.length, 1);
});

test("rewriteAgentForMcp: appends override fields not in source", () => {
  const out = rewriteAgentForMcp(SAMPLE_AGENT, "_tmp", ["a/b"], {
    fallbackModels: "openrouter/x/y, openrouter/z/w",
  });
  assert.match(out, /fallbackModels: openrouter\/x\/y, openrouter\/z\/w/);
});

test("prepareEphemeralAgents: applies project agentOverrides[name].model", async () => {
  await withTempCwd(async (cwd) => {
    const agentsDir = join(cwd, ".pi/agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "scout.md"), SAMPLE_AGENT);
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        subagents: { agentOverrides: { scout: { model: "openrouter/swap/me" } } },
      }),
    );

    const { nameMap, cleanup } = await prepareEphemeralAgents({
      cwd,
      agents: ["scout"],
      mcpTools: ["server/tool"],
    });
    const ephem = nameMap.get("scout");
    const written = await readFile(join(agentsDir, `${ephem}.md`), "utf8");
    assert.match(written, /model: openrouter\/swap\/me/);
    // The original `model: anthropic/claude-haiku-4-5` line should be gone.
    assert.doesNotMatch(written, /model: anthropic\//);
    await cleanup();
  });
});

test("prepareEphemeralAgents: writes temp file and cleanup removes it", async () => {
  await withTempCwd(async (cwd) => {
    const agentsDir = join(cwd, ".pi/agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "scout.md"), SAMPLE_AGENT);

    const { nameMap, cleanup } = await prepareEphemeralAgents({
      cwd,
      agents: ["scout"],
      mcpTools: ["server/tool"],
    });
    assert.ok(nameMap.has("scout"));
    const ephem = nameMap.get("scout");
    assert.match(ephem, /^_pi-cc-ephem-/);
    const written = await readFile(join(agentsDir, `${ephem}.md`), "utf8");
    assert.match(written, /mcp:server\/tool/);

    await cleanup();
    const remaining = await readdir(agentsDir);
    assert.deepEqual(
      remaining.filter((f) => f.startsWith("_pi-cc-ephem-")),
      [],
    );
  });
});

test("prepareEphemeralAgents: missing source throws actionable error", async () => {
  await withTempCwd(async (cwd) => {
    await assert.rejects(
      prepareEphemeralAgents({
        cwd,
        agents: ["definitely-does-not-exist-anywhere-12345"],
        mcpTools: ["server/tool"],
      }),
      /couldn't find a source for agent "definitely-does-not-exist-anywhere-12345"/,
    );
  });
});

test("prepareEphemeralAgents: falls back to pi-subagents builtin when no project seed", async () => {
  // 'scout' is a pi-subagents builtin shipped at <npm-global>/pi-subagents/agents/scout.md.
  // If it's installed locally, ephemeral resolution should find it without a project seed.
  await withTempCwd(async (cwd) => {
    let result;
    try {
      result = await prepareEphemeralAgents({
        cwd,
        agents: ["scout"],
        mcpTools: ["server/tool"],
      });
    } catch (err) {
      // pi-subagents not installed in this CI env — skip rather than fail.
      if (/couldn't find a source/.test(err.message)) return;
      throw err;
    }
    assert.ok(result.nameMap.has("scout"));
    await result.cleanup();
  });
});

test("prepareEphemeralAgents: empty mcpTools is a no-op", async () => {
  await withTempCwd(async (cwd) => {
    const r = await prepareEphemeralAgents({
      cwd,
      agents: ["scout"],
      mcpTools: [],
    });
    assert.equal(r.nameMap.size, 0);
    await r.cleanup();
  });
});

test("displayAgentName: strips the ephemeral prefix back to the original name", () => {
  assert.equal(displayAgentName("_pi-cc-ephem-moe5vslt-ykid-architect"), "architect");
  assert.equal(displayAgentName("_pi-cc-ephem-abc123-def456-scout"), "scout");
  // Unaffected for non-ephemeral names.
  assert.equal(displayAgentName("scout"), "scout");
  assert.equal(displayAgentName("test-writer"), "test-writer");
  assert.equal(displayAgentName(undefined), undefined);
});

test("/pi:run --mcp: dispatches under ephemeral name and cleans up", async () => {
  await withTempCwd(async (cwd) =>
    withFakePiTmp(async (piTmp) => {
      const agentsDir = join(cwd, ".pi/agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, "scout.md"), SAMPLE_AGENT);

      const env = fakePiEnv({ FAKE_PI_TMPDIR: piTmp });
      const { code, stdout } = await runBroker(
        ["run", "scout", "do thing", "--bg", "--mcp", "tt/get_ticket,tt/append_log"],
        { cwd, env },
      );
      assert.equal(code, 0);
      // The OUTPUT shows the original agent name, not the ephemeral one.
      assert.match(stdout, /agent=scout/);

      // Cleanup happened: no _pi-cc-ephem-* file left in .pi/agents/.
      const after = await readdir(agentsDir);
      assert.deepEqual(
        after.filter((f) => f.startsWith("_pi-cc-ephem-")),
        [],
      );
    }),
  );
});


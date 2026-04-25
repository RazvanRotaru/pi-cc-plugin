import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  preflight,
  _resetPreflightCache,
} from "../plugins/pi/scripts/lib/preflight.mjs";

test("preflight: skipped entirely when PI_BROKER_PI_BIN is set", async () => {
  _resetPreflightCache();
  await preflight({
    env: { PI_BROKER_PI_BIN: "/no/such/path", PATH: "" },
    cwd: "/tmp",
  });
  // No throw — env override means caller knows what they're doing.
});

test("preflight: skipped via PI_BROKER_NO_PREFLIGHT=1", async () => {
  _resetPreflightCache();
  await preflight({
    env: { PI_BROKER_NO_PREFLIGHT: "1", PATH: "" },
    cwd: "/tmp",
  });
});

test("preflight: pi missing from PATH and no package → throws actionable error", async () => {
  _resetPreflightCache();
  const tempCwd = await mkdtemp(join(tmpdir(), "pi-cc-pf-"));
  try {
    await assert.rejects(
      preflight({
        env: {
          PATH: "",
          HOME: "/tmp/no-pi-here",
        },
        cwd: tempCwd,
      }),
      (err) => {
        assert.match(err.message, /pi binary not on PATH|pi script not found|pi-subagents extension not found/);
        assert.match(err.message, /Run `\/pi:setup`/);
        return true;
      },
    );
  } finally {
    await rm(tempCwd, { recursive: true, force: true });
  }
});

test("preflight: pi-subagents missing → throws with install hint", async () => {
  _resetPreflightCache();
  // Provide a fake pi binary on PATH but no pi-subagents anywhere.
  const tmpBin = await mkdtemp(join(tmpdir(), "pi-cc-pf-bin-"));
  await writeFile(join(tmpBin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const tempCwd = await mkdtemp(join(tmpdir(), "pi-cc-pf-cwd-"));
  try {
    await assert.rejects(
      preflight({
        env: {
          PATH: tmpBin,
          HOME: "/tmp/no-extensions",
        },
        cwd: tempCwd,
      }),
      /pi-subagents extension not found|pi binary not on PATH/,
    );
  } finally {
    await rm(tmpBin, { recursive: true, force: true });
    await rm(tempCwd, { recursive: true, force: true });
  }
});

test("preflight: caches result across calls", async () => {
  _resetPreflightCache();
  await preflight({
    env: { PI_BROKER_NO_PREFLIGHT: "1", PATH: "" },
    cwd: "/tmp",
  });
  // Second call returns immediately (cached). We can't easily prove the
  // cache hit without timing, so just verify it doesn't throw under
  // conditions that WOULD throw on a cold call.
  await preflight({ env: { PATH: "" }, cwd: "/tmp" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempCwd } from "./helpers.mjs";
import { ensureGitignored } from "../plugins/pi/scripts/lib/gitignore.mjs";

test("non-git workspace: no-op", async () => {
  await withTempCwd(async (cwd) => {
    const r = await ensureGitignored(cwd);
    assert.equal(r.updated, false);
    assert.match(r.reason, /not a git/);
  });
});

test("git repo without .gitignore: creates one", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(join(cwd, ".git"));
    const r = await ensureGitignored(cwd);
    assert.equal(r.updated, true);
    const body = await readFile(join(cwd, ".gitignore"), "utf8");
    assert.match(body, /\.pi-cc-plugin\//);
  });
});

test("git repo with existing .gitignore that already lists us: no-op", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n.pi-cc-plugin/\n");
    const r = await ensureGitignored(cwd);
    assert.equal(r.updated, false);
    assert.match(r.reason, /already/);
  });
});

test("git repo with existing .gitignore that doesn't list us: appends", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    const r = await ensureGitignored(cwd);
    assert.equal(r.updated, true);
    const body = await readFile(join(cwd, ".gitignore"), "utf8");
    assert.match(body, /\.pi-cc-plugin\//);
    assert.match(body, /node_modules\//);
  });
});

test("recognizes the bare form '.pi-cc-plugin' (no trailing slash) as already-present", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".gitignore"), ".pi-cc-plugin\n");
    const r = await ensureGitignored(cwd);
    assert.equal(r.updated, false);
  });
});

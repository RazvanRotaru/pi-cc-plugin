// Unit tests for readPiEvents — the broker's tail of pi-subagents'
// events.jsonl. We don't go through the broker here; just exercise the
// reader directly against synthetic files.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPiEvents } from "../plugins/pi/scripts/lib/pi-status-reader.mjs";

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-events-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ev = (type, extra = {}) => JSON.stringify({ type, ...extra });

test("readPiEvents returns null when statusDir is missing", async () => {
  assert.equal(await readPiEvents(null), null);
  assert.equal(await readPiEvents(undefined), null);
});

test("readPiEvents returns null when events.jsonl does not exist", async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await readPiEvents(dir), null);
  });
});

test("readPiEvents reads the full log when no cursor is given", async () => {
  await withTmpDir(async (dir) => {
    const lines = [
      ev("subagent.run.started", { runId: "x" }),
      ev("subagent.step.started", { stepIndex: 0, agent: "scout" }),
      ev("subagent.run.completed", { success: true }),
    ];
    await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
    const result = await readPiEvents(dir);
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].type, "subagent.run.started");
    assert.equal(result.events[2].success, true);
    assert.equal(result.cursor, Buffer.byteLength(`${lines.join("\n")}\n`));
  });
});

test("readPiEvents tails from a cursor", async () => {
  await withTmpDir(async (dir) => {
    const head = `${ev("subagent.run.started", { runId: "x" })}\n`;
    const tail = `${ev("subagent.run.completed", { success: true })}\n`;
    await writeFile(join(dir, "events.jsonl"), head + tail);
    const result = await readPiEvents(dir, { since: Buffer.byteLength(head) });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "subagent.run.completed");
    assert.equal(result.cursor, Buffer.byteLength(head + tail));
  });
});

test("readPiEvents resets cursor to file length when file shrinks", async () => {
  await withTmpDir(async (dir) => {
    const body = `${ev("subagent.run.started")}\n`;
    await writeFile(join(dir, "events.jsonl"), body);
    const result = await readPiEvents(dir, { since: 99999 });
    assert.deepEqual(result.events, []);
    assert.equal(result.cursor, Buffer.byteLength(body));
  });
});

test("readPiEvents stops at last newline (partial line is left for next read)", async () => {
  await withTmpDir(async (dir) => {
    const complete = `${ev("subagent.run.started")}\n`;
    const partial = `{"type":"subagent.step.start`; // mid-write, no newline
    await writeFile(join(dir, "events.jsonl"), complete + partial);
    const result = await readPiEvents(dir);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "subagent.run.started");
    // Cursor sits after the last newline — the partial tail is not consumed.
    assert.equal(result.cursor, Buffer.byteLength(complete));
  });
});

test("readPiEvents skips malformed lines and keeps going", async () => {
  await withTmpDir(async (dir) => {
    const lines = [
      ev("subagent.run.started"),
      "{not json",
      ev("subagent.run.completed", { success: true }),
    ];
    await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
    const result = await readPiEvents(dir);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].type, "subagent.run.started");
    assert.equal(result.events[1].type, "subagent.run.completed");
  });
});

test("readPiEvents returns empty events when cursor sits at EOF", async () => {
  await withTmpDir(async (dir) => {
    const body = `${ev("subagent.run.started")}\n`;
    await writeFile(join(dir, "events.jsonl"), body);
    const result = await readPiEvents(dir, { since: Buffer.byteLength(body) });
    assert.deepEqual(result.events, []);
    assert.equal(result.cursor, Buffer.byteLength(body));
  });
});

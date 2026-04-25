import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../plugins/pi/scripts/lib/args.mjs";

test("--foreground is accepted as an alias for --wait", () => {
  // The user reported guessing --foreground because it's the natural
  // way to say "synchronous" — make sure we accept it instead of
  // punishing them for idiomatic intuition.
  const { payload } = parseArgs("run", ["scout", "task", "--foreground"]);
  assert.equal(payload.background, false);
});

test("--background is accepted as an alias for --bg", () => {
  const { payload } = parseArgs("run", ["scout", "task", "--background"]);
  assert.equal(payload.background, true);
});

test("--detach / --async also map to --bg", () => {
  const r1 = parseArgs("run", ["scout", "task", "--detach"]).payload;
  const r2 = parseArgs("run", ["scout", "task", "--async"]).payload;
  assert.equal(r1.background, true);
  assert.equal(r2.background, true);
});

test("non-aliased typo still surfaces a helpful error", () => {
  let err = null;
  try {
    parseArgs("run", ["scout", "task", "--workt"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.match(err.message, /unknown flag: --workt/);
  assert.match(err.message, /did you mean --worktree/);
  assert.match(err.message, /valid flags:/);
});

test("unknown --modal suggests --model", () => {
  let err = null;
  try {
    parseArgs("run", ["scout", "task", "--modal", "x/y"]);
  } catch (e) {
    err = e;
  }
  assert.match(err.message, /did you mean --model/);
});

test("unknown --xyzqq has no suggestion (too far)", () => {
  let err = null;
  try {
    parseArgs("run", ["scout", "task", "--xyzqq"]);
  } catch (e) {
    err = e;
  }
  assert.match(err.message, /unknown flag: --xyzqq/);
  // No "(did you mean ...)" close-match clause when nothing is within 3 edits.
  assert.doesNotMatch(err.message, /did you mean/);
  // Still shows the full valid list.
  assert.match(err.message, /valid flags:/);
});

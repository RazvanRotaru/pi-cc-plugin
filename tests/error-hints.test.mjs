import test from "node:test";
import assert from "node:assert/strict";
import { guidanceForError } from "../plugins/pi/scripts/lib/render.mjs";

test("guidanceForError: 'No API key found' surfaces a provider-specific hint", () => {
  const h = guidanceForError("No API key found for openrouter.\n\nUse /login...");
  assert.ok(h);
  assert.match(h, /openrouter/);
  assert.match(h, /OPENROUTER_API_KEY/);
});

test("guidanceForError: invalid model ID hint", () => {
  const h = guidanceForError("400 some-name is not a valid model ID");
  assert.match(h, /pi --list-models|pi-prices/);
});

test("guidanceForError: dirty worktree hint", () => {
  const h = guidanceForError("worktree isolation requires a clean git working tree.");
  assert.match(h, /Commit or stash/);
});

test("guidanceForError: spawn pi ENOENT hint", () => {
  const h = guidanceForError("spawn pi ENOENT");
  assert.match(h, /\/pi:setup|PATH/);
});

test("guidanceForError: returns null when nothing matches", () => {
  assert.equal(guidanceForError("totally unrelated message"), null);
  assert.equal(guidanceForError(""), null);
  assert.equal(guidanceForError(null), null);
});

test("guidanceForError: handles unknown provider gracefully", () => {
  const h = guidanceForError("No API key found for some-new-provider.");
  assert.ok(h);
  assert.match(h, /some-new-provider/);
  // Falls back to generic "/login or env var" guidance when no map entry.
  assert.match(h, /\/login|API_KEY/);
});

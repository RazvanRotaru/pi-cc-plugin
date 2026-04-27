#!/usr/bin/env node
// pi-broker — single entry-point invoked by every /pi:* slash command.
//
// Usage:
//   node pi-broker.mjs <action> [args...]
//
// Actions: run | status | result | cancel | setup
//
// Each action is dispatched to a handler in scripts/lib/. The broker writes
// to ./.pi-cc-plugin/state.json and reads pi's per-run status dir.

import { dispatch } from "./lib/dispatch.mjs";

const [, , action, ...rest] = process.argv;

if (!action) {
  process.stderr.write("pi-broker: missing action\n");
  process.exit(2);
}

try {
  const exitCode = await dispatch(action, rest, {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(exitCode ?? 0);
} catch (err) {
  process.stderr.write(`pi-broker: ${err.message}\n`);
  if (process.env.PI_BROKER_DEBUG) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}

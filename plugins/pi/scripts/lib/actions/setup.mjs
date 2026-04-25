// /pi:setup — verify pi + pi-subagents and scaffold default specialist agents.
//
// Idempotent. Each step is a no-op if already done. Side effects (file
// writes, MCP registration) require confirmation unless --yes is passed.

import { parseArgs } from "../args.mjs";
import {
  checkGitignore,
  checkPiAuth,
  checkPiInstalled,
  checkPiSubagentsInstalled,
  checkSpecialistSeeds,
} from "../setup-checks.mjs";

const ICON_OK = "✓";
const ICON_FAIL = "✗";
const ICON_FIX = "→";

export default async function setup(argv, ctx) {
  const { flags } = parseArgs("setup", argv);
  const autoYes = !!flags.yes;

  const checks = [
    () => checkPiInstalled({ env: ctx.env }),
    () => checkPiSubagentsInstalled({ env: ctx.env, cwd: ctx.cwd }),
    () => checkPiAuth({ env: ctx.env }),
    () => checkGitignore({ cwd: ctx.cwd }),
    () => checkSpecialistSeeds({ cwd: ctx.cwd }),
  ];

  let hadHardFail = false;
  for (const fn of checks) {
    const r = await fn();
    if (r.ok) {
      ctx.stdout.write(`${ICON_OK} ${r.name} — ${r.message}\n`);
      continue;
    }
    if (r.fixable) {
      if (autoYes || prompt(ctx, `${ICON_FIX} ${r.name} — ${r.message}\n  apply fix? [y/N] `)) {
        await r.fix();
        ctx.stdout.write(`${ICON_OK} ${r.name} — fixed\n`);
      } else {
        ctx.stdout.write(`${ICON_FAIL} ${r.name} — skipped\n`);
      }
      continue;
    }
    ctx.stdout.write(`${ICON_FAIL} ${r.name} — ${r.message}\n`);
    if (r.name === "pi installed" || r.name === "pi-subagents installed") {
      hadHardFail = true;
    }
  }

  if (hadHardFail) {
    ctx.stderr.write(
      "\npi-cc-plugin: setup found hard failures (pi or pi-subagents missing). " +
        "Resolve them and re-run /pi:setup.\n",
    );
    return 1;
  }
  ctx.stdout.write("\nsetup done.\n");
  return 0;
}

// Non-interactive shim — auto-no without --yes. Real interactive prompting
// requires a TTY, which slash-command bash environments don't always have.
function prompt(_ctx, message) {
  // Always answer "no" without --yes. Users who want auto-apply pass --yes.
  process.stderr.write(message);
  process.stderr.write("(non-interactive — pass --yes to apply)\n");
  return false;
}

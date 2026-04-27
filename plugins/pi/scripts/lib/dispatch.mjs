// dispatch.mjs — action router for the broker.
//
// Each action is implemented as its own module. We import lazily so that a
// stub installation (no pi running) can still print /pi:status and never
// pulls cancel/result code paths.

const ACTIONS = {
  run: () => import("./actions/run.mjs"),
  status: () => import("./actions/status.mjs"),
  result: () => import("./actions/result.mjs"),
  cancel: () => import("./actions/cancel.mjs"),
  setup: () => import("./actions/setup.mjs"),
};

export async function dispatch(action, args, ctx) {
  const loader = ACTIONS[action];
  if (!loader) {
    ctx.stderr.write(`pi-broker: unknown action "${action}"\n`);
    ctx.stderr.write(`available: ${Object.keys(ACTIONS).join(", ")}\n`);
    return 2;
  }
  const mod = await loader();
  return mod.default(args, ctx);
}

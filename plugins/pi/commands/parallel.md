---
description: Run several pi agents in parallel. Add --worktree to isolate filesystems.
argument-hint: "<agent>[\"task\"] <agent>[\"task\"] … [--worktree] [--bg|--wait]"
allowed-tools: ["Bash"]
---

Forward the slash arguments to the broker's `parallel` action.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" parallel $ARGUMENTS
```

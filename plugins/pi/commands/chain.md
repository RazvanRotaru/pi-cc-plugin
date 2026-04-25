---
description: Run a chain of pi agents — output of step N feeds step N+1.
argument-hint: "<agent>[\"task\"] -> <agent>[\"task\"] … [--bg|--wait]"
allowed-tools: ["Bash"]
---

Forward the slash arguments to the broker's `chain` action.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" chain $ARGUMENTS
```

---
description: Verify pi + pi-subagents and scaffold default specialist agents.
argument-hint: "[--yes]"
allowed-tools: ["Bash"]
---

Idempotent — safe to re-run. Each step is a no-op if already done.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" setup $ARGUMENTS
```

---
description: Show the final markdown output of a completed pi run.
argument-hint: "<job-id>"
allowed-tools: ["Bash"]
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" result $ARGUMENTS
```

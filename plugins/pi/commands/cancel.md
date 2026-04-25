---
description: Abort a running pi job. SIGTERM, escalates to SIGKILL.
argument-hint: "<job-id>"
allowed-tools: ["Bash"]
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" cancel $ARGUMENTS
```

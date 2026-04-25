---
description: Show pi job status — all active runs, or one if you pass an id.
argument-hint: "[job-id]"
allowed-tools: ["Bash"]
---

Run the pi-cc broker `status` action and display its output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" status $ARGUMENTS
```

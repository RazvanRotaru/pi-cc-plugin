---
description: Delegate a task to one pi agent. Backgrounds by default.
argument-hint: "<agent> <task…> [--bg|--wait] [--model <m>] [--fork] [--cwd <p>]"
allowed-tools: ["Bash"]
---

Forward the slash arguments to the broker's `run` action. Pi handles the
actual model dispatch and writes durable status under its own runs dir.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-broker.mjs" run $ARGUMENTS
```

---
description: List the cloud sessions nuvem follows, with their state, age and the watcher heartbeat. Reads only the local registry.
disable-model-invocation: true
argument-hint: '[--all]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" list:*)
---

Show the output below to the person as it is, with nothing added.

```!
/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" list $ARGUMENTS 2>&1 || true
```

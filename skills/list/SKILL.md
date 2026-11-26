---
description: List the cloud sessions kharos follows, with their state, age, the live followers and the open slots, from the local registry.
disable-model-invocation: true
argument-hint: '[--all]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" list:*)
---

Show the output below to the person as it is, with nothing added.

```!
/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" list $ARGUMENTS 2>&1 || true
```

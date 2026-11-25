---
description: Stop following a cloud session in nuvem, and show where to delete its routine.
disable-model-invocation: true
argument-hint: '<id>'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" close:*)
---

Show the output below to the person as it is, with nothing added.

```!
/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" close $ARGUMENTS 2>&1 || true
```

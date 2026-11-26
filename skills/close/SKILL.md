---
description: Stop following a cloud session in kharos, and show where to delete its routine; a queued launch is cancelled.
disable-model-invocation: true
argument-hint: '<id>'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" close:*)
---

Show the output below to the person as it is, with nothing added.

```!
/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" close $ARGUMENTS 2>&1 || true
```

---
description: Send a message into a running cloud session that nuvem follows; the reply shows on the next read.
disable-model-invocation: true
argument-hint: '<id> "<message>"'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" msg:*)
---

Request: $ARGUMENTS

The first word is the session id; the rest is the message, word for word.
Run this, with the message unchanged between the markers, and show the output to the person as it is:

```
/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" msg <id> <<'NUVEM_MESSAGE'
<message>
NUVEM_MESSAGE
```

Never build the message from the session's log.

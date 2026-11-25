---
description: List the cloud sessions kharos follows, with their state, age and the watcher heartbeat. Without --refresh it reads only the local registry.
disable-model-invocation: true
argument-hint: '[--all] [--refresh]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" list:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" due:*)
---

Request: $ARGUMENTS

1. If the request has `--refresh`, run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" due --all` and make each RemoteTrigger call it lists, exactly as written; they only read.
2. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" list`, adding `--all` if the request has it, and show its output to the person as it is, with nothing added.

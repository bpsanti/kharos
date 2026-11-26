---
description: Check everything a kharos cloud launch depends on for this Claude account - login, plan, configuration, repository, Claude access to it, environment, permissions - with the action for each gap; --verbose adds limits, the watcher and the organization's policy counts.
disable-model-invocation: true
argument-hint: '[--profile p] [--verbose]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" doctor:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" environments:*)
---

1. If you have the RemoteTrigger tool, run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" environments --session ${CLAUDE_SESSION_ID}`, then call RemoteTrigger with action `list` and no other field, and wait for its answer before the next step (never in the same batch of calls).
   If you do not have the RemoteTrigger tool, remember that, and skip the call.
2. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" doctor $ARGUMENTS`, adding `--no-remote-tool` if you had no RemoteTrigger tool.
3. Show the output of step 2 to the person as it is, with nothing added.
   Do not fix anything yourself; /kharos:setup does the fixes that need a decision.

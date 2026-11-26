---
description: Show the permission rules a repository gives its cloud sessions, and add narrow allow rules to its .claude/settings.json (the standard profile) or a cloud environment note to its CLAUDE.md, each after the person approves the diff. Never commits or pushes.
disable-model-invocation: true
argument-hint: '[default|standard|environment] [path of the repository checkout]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions diff:*)
---

Permission rules of a repository for its cloud sessions. Request: $ARGUMENTS

1. Split the request into what to change (`default`, `standard` or `environment`, if one is named) and the folder of the checkout (if one is named; otherwise `.`).
2. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions show <folder>` and show its output to the person as it is.
   If it fails, show the error and stop.
3. If the request named nothing to change, ask the person with AskUserQuestion, with multiple choices allowed: `standard` (narrow allow rules), `environment` (the CLAUDE.md note), or neither, with the one-line description of each from the output.
   On neither, or `default`, stop: nothing changes.
4. For each change chosen, one at a time:
   1. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions diff <change> <folder>` and show its whole output to the person as it is.
      If it says there is nothing to change, go to the next one.
   2. Ask the person with AskUserQuestion whether to write exactly this change to the file, with the diff in the preview of the yes option.
   3. Only on an explicit yes, run the `kharos permissions write <change> --expect <token> <folder>` command the diff names, prefixed with `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos"` in place of `kharos`, and show its output.
      Never write the file yourself, never change the token, and never run it without that yes.
5. Never commit, push, or open a pull request: say that the change takes effect for cloud sessions only once the person commits it and pushes it to the branch their launches start from, and that `/kharos:doctor` reads that branch.

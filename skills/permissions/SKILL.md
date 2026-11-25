---
description: Show the permission rules a repository gives its cloud sessions, and switch its .claude/settings.json to a kharos permission profile (default, standard, open) after the person approves the diff. Never commits or pushes.
disable-model-invocation: true
argument-hint: '[default|standard|open] [path of the repository checkout]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions diff:*)
---

Permission rules of a repository for its cloud sessions. Request: $ARGUMENTS

1. Split the request into a permission profile (`default`, `standard` or `open`, if one is named) and the folder of the checkout (if one is named; otherwise `.`).
2. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions show <folder>` and show its output to the person as it is.
   If it fails, show the error and stop.
3. If the request named no profile, ask the person with AskUserQuestion which profile to use: keep the rules as they are (recommended when the output has no warning), `standard`, or `open`, with the one-line description of each from the output.
   On keep, or `default`, stop: nothing changes.
4. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions diff <profile> <folder>` and show its whole output to the person as it is.
   If it says there is nothing to change, stop.
5. Ask the person with AskUserQuestion whether to write exactly this change to the file, with the diff in the preview of the yes option.
   Only on an explicit yes, run the `kharos permissions write <profile> --expect <token> <folder>` command the diff names, prefixed with `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos"` in place of `kharos`, and show its output.
   Never write the file yourself, never change the profile or the token, and never run it without that yes.
6. Never commit, push, or open a pull request: say that the change takes effect for cloud sessions only once the person commits it and pushes it to the branch their launches start from, and that `/kharos:doctor` reads that branch.

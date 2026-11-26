---
description: Show the permission rules a repository gives its cloud sessions; add narrow allow rules to its .claude/settings.json (the standard profile), or install the opt-in kharos permission hook, each after the person approves the diff. Never commits or pushes.
disable-model-invocation: true
argument-hint: '[default|standard|hook] [path of the repository checkout]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions diff:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions hook show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions hook diff:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions approvals:*)
---

Permission rules of a repository for its cloud sessions. Request: $ARGUMENTS

`kharos` below stands for `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos"`; always run it with that prefix.

1. Split the request into what to do (`default`, `standard` or `hook`, if one is named) and the folder of the checkout (if one is named; otherwise `.`).
2. Run `kharos permissions show <folder>` and show its output to the person as it is.
   If it fails, show the error and stop.
3. If the request named nothing to do, ask the person with AskUserQuestion: `standard` (narrow allow rules), `hook` (the opt-in permission hook, which answers prompts in cloud sessions), or keep everything as it is, with the one-line description of `standard` from the output.
   On keep, or `default`, stop: nothing changes.
4. For `standard`:
   1. Run `kharos permissions diff standard <folder>` and show its whole output to the person as it is.
      If it says there is nothing to change, stop.
   2. Ask the person with AskUserQuestion whether to write exactly this change to the file, with the diff in the preview of the yes option.
   3. Only on an explicit yes, run the `kharos permissions write standard --expect <token> <folder>` command the diff names, and show its output.
      Never write the file yourself, never change the token, and never run it without that yes.
5. For `hook`:
   1. Run `kharos permissions hook show <folder>` and show its output as it is.
   2. If it says `permission_hook` is off, explain in one or two sentences that the hook is opt-in and off by default, and that while it is on the hook answers permission prompts in cloud sessions of any repository that has it, with no person asked.
      Ask with AskUserQuestion whether to turn it on; only on an explicit yes run `kharos permissions hook enable` and show its output. On no, stop.
   3. Ask the person what to change, in their own words: allow patterns to add (a command whose words must match exactly, where a `*` word stands for one argument, such as `psql -h 127.0.0.1 -p 5432 -U dev -d * -Atc *`), patterns to drop, whether anything else is denied with a message (the default) or left to the prompt, mirroring the organization's ask rules, or removing the hook.
      Offer mirroring only when the show output says it is available; when it says it is refused or unavailable, say why, in its words.
   4. Build the flags: `--allow "<pattern>"` and `--drop "<pattern>"` once per pattern, `--unmatched deny|prompt`, `--mirror` or `--unmirror`, or `--uninstall` alone.
      Run `kharos permissions hook diff <flags> <folder>` and show its whole output as it is. If it fails, show the error and stop. If it says there is nothing to change, stop.
   5. Ask the person with AskUserQuestion whether to write exactly this change, with the diff in the preview of the yes option.
   6. If the diff mirrors the organization's ask rules, ask a second, separate AskUserQuestion that quotes the WARNING line of the diff and lists every rule it converts, and whose yes option says the person checked with the organization's administrator.
   7. Only on an explicit yes to every question, run the `kharos permissions hook write ...` command the diff names, exactly as written (with `--org-confirmed` only when the diff names it and the person said yes to the warning), and show its output.
      Never write the files yourself, never change the token or the flags, and never run it without those yeses.
6. Never commit, push, or open a pull request: say that the change takes effect for cloud sessions only once the person commits it and pushes it to the branch their launches start from, and that `/kharos:doctor` reads that branch.
7. When the person asks what the hook allowed, run `kharos permissions approvals` (add `--all` for the denials too, `--session <id>` for one session) and show its output as it is.

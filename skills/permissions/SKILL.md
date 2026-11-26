---
description: Show the permission rules a repository gives its cloud sessions; list the prompts a launch is likely to hit (preflight); add narrow allow rules to its .claude/settings.json (the standard profile), or install the opt-in kharos permission hook or its unblock preset, each after the person approves the diff. Never commits or pushes.
disable-model-invocation: true
argument-hint: '[default|standard|hook|preflight|unblock|account-mode] [path of the repository checkout]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions account-mode diff:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions diff:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions hook show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions hook diff:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions approvals:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions preflight:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions unblock show:*)
---

Permission rules of a repository for its cloud sessions. Request: $ARGUMENTS

`kharos` below stands for `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos"`; always run it with that prefix.

1. Split the request into what to do (`default`, `standard`, `hook`, `preflight` or `unblock`, if one is named) and the folder of the checkout (if one is named; otherwise `.`).
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
   3. Ask the person what to change, in their own words: allow patterns to add (a command whose words must match exactly, where a `*` word stands for one argument, such as `psql -h 127.0.0.1 -p 5432 -U dev -d * -Atc *`), prefix rules to add (`Bash(<program> <subcommands>:*)`, which allow any arguments, such as `Bash(git push:*)`), patterns or prefix rules to drop, mirroring the organization's ask rules, or removing the hook.
      Offer mirroring only when the show output says it is available; when it says it is refused or unavailable, say why, in its words.
   4. Build the flags: `--allow "<pattern>"`, `--allow-prefix "<prefix rule>"` and `--drop "<pattern or prefix rule>"` once per rule, `--mirror` or `--unmirror`, or `--uninstall` alone.
      Add `--broad` only when the person asked for a broad rule (a pattern for a shell, an interpreter, a wrapper or a wildcard program, or mirroring broad organization rules) after you told them that it allows any command in this repository's cloud sessions with no person asked.
      Run `kharos permissions hook diff <flags> <folder>` and show its whole output as it is. If it fails, show the error and stop. If it says there is nothing to change, stop.
   5. Ask the person with AskUserQuestion whether to write exactly this change, with the diff in the preview of the yes option.
   6. If the write command the diff names has `--org-confirmed`, ask a second, separate AskUserQuestion that quotes the diff's WARNING line about the organization's administrator and lists every rule it converts, and whose yes option says the person checked with the organization's administrator.
      When the diff says the earlier confirmation still holds (and the write command has no `--org-confirmed`), do not ask it again; when it says the organization's settings changed, quote what changed in that question.
      If the diff warns that it adds broad rules, ask a separate AskUserQuestion that quotes that WARNING line, whose yes option says the person accepts that those rules allow any command they cover.
   7. Only on an explicit yes to every question, run the `kharos permissions hook write ...` command the diff names, exactly as written (with `--broad` and `--org-confirmed` only when the diff names them and the person said yes to each warning), and show its output.
      Never write the files yourself, never change the token or the flags, and never run it without those yeses.
6. For `preflight`: run `kharos permissions preflight <folder>` and show its whole output as it is.
   If the person wants the suggested rules, go on with `hook` (step 5) using exactly the `--allow` patterns and `--allow-prefix` rules it printed.
   To turn automatic preflight on or off, the person runs `kharos permissions auto preflight on|off` themselves; never run it for them.
7. For `unblock`:
   1. Run `kharos permissions unblock show` and show its whole output as it is. If it says the preset is not available, say why in its words, and stop.
   2. If it is not confirmed, ask one AskUserQuestion that lists everything the output says it opens (every prompt allowed, the organization's ask rules, the remote databases, and what stays), whose yes option says the person accepts all of it.
      Only on an explicit yes, run the `kharos permissions unblock confirm --fingerprint <fp>` command it names, exactly, and show its output.
   3. Then follow `hook` from its step 4, with the flag `--unblock` (or `--no-unblock` to turn it off); the confirmation already covers the mirroring, so ask no second question about the organization.
   4. The automatic mode (`kharos permissions auto unblock on|off`) is the person's to run; never run it for them.
8. Never commit, push, or open a pull request: say that the change takes effect for cloud sessions only once the person commits it and pushes it to the branch their launches start from, and that `/kharos:doctor` reads that branch.
9. For `account-mode` (whether this Claude account starts its sessions in auto mode, where the classifier reviews each launch instead of an approval prompt):
   1. Run `kharos permissions account-mode diff auto` (or `off` to undo it) and show its whole output as it is; if it says there is nothing to change, or that it is not available, stop.
   2. Ask with AskUserQuestion whether to write exactly this change, with the diff in the preview of the yes option and its effect (every session of this account, not only launches) in the question.
   3. Only on an explicit yes, run the `kharos permissions account-mode write ... --expect <token>` command the diff names, exactly, and show its output.
10. When the person asks what the hook allowed, run `kharos permissions approvals` (add `--all` for the denials too, `--session <id>` for one session) and show its output as it is.

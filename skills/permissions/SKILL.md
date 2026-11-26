---
description: Free every permission prompt kharos can free for this Claude account in one step (unblock all), after one confirmation; take back what it turned on (off); or show where it stands. Never changes a repository's own files.
disable-model-invocation: true
argument-hint: '[on|off|state]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" permissions unblock-all show:*)
---

Unblock all for this Claude account. Request: $ARGUMENTS

`kharos` below stands for `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos"`; always run it with that prefix.

1. Read what to do from the request: `off` (also when the person asks to undo, take back or turn off unblock all), `state` (also when they only ask where it stands), and otherwise `on`.
2. Run `kharos permissions unblock-all show` (`kharos permissions unblock-all show off` for off) and show its whole output to the person as it is.
   If it says there is nothing to change or nothing to take back, and offers no change "with the statement", or the request was `state`, stop.
3. Ask one AskUserQuestion: its question says, in plain words, every part the output turns on (or takes back) and what each frees, the parts it leaves out with why, and that auto mode changes every session of this account, not only launches; its yes option says the person accepts all of it, with the output's diff of the account's settings as the preview of that option.
   When the output says Claude Code keeps no copy of the organization's settings, the question also says the one check it names (an interactive Claude Code session with this account, then this again), and offers a second yes option: all of it, with the statement that this account has no organization settings, with the output's text from "If there is still no copy" on as its preview; say that kharos cannot check that statement. Never pick that option for the person, and never treat the first yes as that statement.
   Ask nothing else: this one question is the whole confirmation.
4. Only on an explicit yes, run the `kharos permissions unblock-all on --expect <token>` command the output names for the option picked (`on --no-org-settings --expect <token>` for the statement, `off --expect <token>` for off), exactly, and show its output.
   If it stops part way, show the error as it is: it says which parts are on.
   If Claude Code does not let you run it, show the command prefixed with `! ` so the person runs it here; never change the token.
5. Never change a repository's `.claude/settings.json` or the permission hook's files, and never commit, push or open a pull request: unblock all puts what it needs on a side branch of each launch, and `/kharos:doctor` shows one line on where it stands.

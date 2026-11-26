# Changelog

## Unreleased

- A permission preflight before each launch (`kharos permissions preflight`, and a step of `/kharos:run`): the prompts a session is likely to hit, from the organization's ask rules, the repository's own commands that such a rule covers, and earlier sessions on the same repository, each with a narrow rule of the permission hook, why, and the command that adds them. A prompt of an earlier session becomes a prefix rule of its program and subcommands (`Bash(psql:*)`, `Bash(git push:*)`), which allows any arguments, so none of the values it was run with reaches a rule.
- Prefix rules in the permission hook (`--allow-prefix 'Bash(<program> <subcommands>:*)'`, the `prefix` list of the rules file): a single simple command they cover is allowed, never one whose program runs other commands unless `--broad`.
- Automatic preflight (`kharos permissions auto preflight on`, off by default): each launch gets a side branch `kharos/<id>` with those narrow rules and starts there; the launch branch is never changed, and `/kharos:close` deletes the side branch while it holds only that commit.
- The confirmation to mirror the organization's ask rules is remembered with a fingerprint of its managed settings, and asked again, with what changed, only when they change.
- The unblock preset (`kharos permissions unblock`, off by default): after one confirmation of what it opens, the permission hook allows every prompt in cloud sessions and mirrors every organization ask rule; refused when the organization disabled bypass mode, deny rules untouched, every allow logged. Hook script version 3.
- `/kharos:setup` has an assisted path for creating a cloud environment: it prepares the setup script (the repository's `tools/cloud/bootstrap.sh`, or a minimal one), the variable names and the network level, opens claude.ai/code, and writes the new id into the profile after you confirm it (`docs/setup.md`).
- `/kharos:doctor` warns when no environment is known to fit a profile's repository, and when the setup script changed since you confirmed the environment.

## 0.1.0

The first version published to npm.

- `/kharos:setup` writes a launch profile for a repository, and `/kharos:doctor` checks what a launch depends on, with the fix for each gap (`docs/setup.md`).
- `/kharos:run` launches one cloud session through the `RemoteTrigger` tool and records it; a second `run` of the same launch is refused, and a lost answer is recovered by reading.
- Launched sessions are followed with `/kharos:list`, `/kharos:log` and `/kharos:close`; `/kharos:send` sends a message into a running session, and `/kharos:result` shows its end mark, pull request and branch.
- Each command also has a short form, `/kharos <action>` (`/kharos log k-0001`); `/kharos` alone lists the actions.
- The watcher (`/loop 10m /kharos:watch`) classifies each session from its log and tells apart a closed turn from the end; `kharos health` reports a watcher that stopped (`docs/watcher.md`).
- Events go to desktop notifications, a JSON-lines file, Slack, any command, or firstmate (`docs/outputs.md`).
- `/kharos:permissions` shows the permission rules a repository gives its cloud sessions and writes a profile of narrow allow rules after you approve the diff; a session waiting at a permission prompt raises a notice (`docs/permissions.md`).
- An opt-in permission hook, off by default, answers prompts in cloud sessions with your own allow patterns; broad patterns are accepted only with `--broad` and are marked.
- A logo and brand kit (`assets/brand/`).
- The `kharos` command from `npm install -g kharos`.

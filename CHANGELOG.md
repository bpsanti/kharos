# Changelog

## Unreleased

- The followers due at the same moment share one reader process instead of starting one each: each read round makes every due session's `RemoteTrigger` calls in a single `claude -p`, so a machine with many open sessions runs one reader at a time rather than one per session.
  Only followers of the same Claude account (`CLAUDE_CONFIG_DIR`) share a round, and a round holds at most 20 sessions; more split into a few.
  The hook stores and classifies each answer as before, an answer that fails is recorded for its session alone, and a session the reader made no call for is a failed read for that session only.
  The read interval (15 to 60 seconds) is still counted from when the last answer came; a read due within 5 seconds joins a round already open, so it comes at most 5 seconds sooner, never later; `reader_cost_usd` is each follower's share of its rounds.
  The rounds are kept in `rounds.json` of the state folder for a minute after they end.
  A follower started by an earlier kharos still reads on its own.

## 0.3.0

### Upgrading from 0.2.0

- The watcher is gone: stop any session that runs `/loop 10m /kharos:watch`, and change scripts that use a [removed command](#removed-commands).
- The permission hook script is now version 5, with the same decisions as before.
  Each launch with unblock all writes it to its side branch.
  A branch that has an older copy from an earlier kharos keeps it until its maintainers change or remove its files, and `/kharos:doctor` reports it as outdated.
- A configuration that still sets `watch.interval_min` loads, and the next write drops it.
- The permission mode `auto-unblock` is now named `unblock-all`, and the old name is still read.
  A profile that stored a [removed mode](#removed-commands) reads as `as-is`.

### Removed commands

| Stop using | Use instead |
|---|---|
| `/kharos:watch`, `kharos due`, `kharos pass-end`, `watch.interval_min` | Nothing to run: each launch has its own follower |
| `/kharos:follow` | Nothing to run: a Stop hook follows any open session nobody follows; from a shell, `kharos follow <id> --detach` |
| `/kharos:list --refresh` | `/kharos:list` (followers keep it fresh) |
| `kharos log --cached` | `kharos log <id> [lines]` in a shell |
| `/kharos:permissions` with `default`, `standard`, `hook`, `preflight`, `unblock` or `account-mode`; `kharos permissions show`, `diff`, `write`, `hook`, `unblock`, `auto`, `account-mode`, `preflight <folder>` | `/kharos:permissions [on\|off\|state]`; each launch runs its own preflight |
| Setup permission modes `standard`, `hook`, `standard+hook`, `auto-preflight`, `unblock` | `as-is` or `unblock-all` |
| `kharos setup --account-mode`, `--account-expect` | `/kharos:permissions` |
| `kharos setup --model`, `--deadline` | `/kharos:run --model`, `--deadline`, or the configuration file |
| `kharos setup --tools`, `--connectors`, `--no-connectors`, `--default`, `--json`; `kharos doctor --json`; `kharos env-wait` | No replacement |

### Permissions

- `/kharos:permissions` is unblock all: one list of everything kharos can free for a Claude account and one confirmation; `off` takes back what it turned on, `state` shows where it stands.
  `/kharos:setup` offers it as the `unblock-all` mode (`docs/permissions.md`).
- Unblock all also works for an account whose organization has no managed settings, once you state that in the confirmation (`--no-org-settings`).
- kharos no longer changes a repository's own `.claude/settings.json`: what unblock all needs goes to a side branch of each launch.
- `kharos permissions approvals --all` also lists denials of prompts whose log line has the reason instead of the command.

### Commands

- The slash commands are `setup`, `doctor`, `run`, `list`, `log`, `send`, `result`, `close` and `permissions`.
  Each CLI command now refuses a flag it does not read.
- `/kharos:run --revision <branch>` starts one launch on another branch or tag than the profile's.
- `/kharos:close <id> --ask-stop` asks the session to stop before releasing it.
- A session closed while it still runs is `closing` and keeps its slot until it ends or its deadline passes; `kharos close <id> --stopped` frees it at once.
- `kharos log <id> [lines] [--full]` prints a session's stored events from a shell, with no model.
- `kharos health` and the line at the start of a Claude Code session check only that each open session has a live follower.

### Follow and end detection

- A turn that closes without `KHAROS-DONE` and stays quiet for 5 minutes, with no background task left that could wake it, gets one message asking the session whether it finished (`session.end_asked`).
  With no end mark in reply, it is closed at its deadline (`session.deadline_closed`).
- New event `session.pr_opened`, with the pull request's URL.
- The deadline counts from the moment the cloud session opened, and `session.overdue` is raised once.
- A `run` refused by the auto mode classifier goes back to "routine created", so `/kharos:run --resume` fires it with no re-arm.
- `/kharos:setup` no longer moves an account's files while a follower reads an open session from the shared ones.

### Reports

- Sessions are asked to send the final report in numbered `KHAROS-PART` messages, and `/kharos:result` puts them together and names the missing or cut ones.
- `/kharos:result` calls the last message cut only when it is, and `kharos show` names the last message and its time.

## 0.2.0

### Upgrading from 0.1.0

- With a `CLAUDE_CONFIG_DIR` other than `~/.claude`, run `/kharos:setup` again: that account now has its own kharos files, and setup moves its profiles and sessions into them.
- `watch.max_open` is 10 by default (5 before).
- The permission hook script is now version 3: a repository that has the hook gets it with `/kharos:permissions hook`, once you approve, commit and push the diff.

### Setup

- `/kharos:setup` is one guided flow, once per Claude account: everything a launch needs in order, each with its state and the one action that fixes it, then a short summary with the next action (`docs/setup.md`).
- The cloud environment is picked by name, with no `env_...` id to paste; when none fits, an assisted path prepares what to paste into a new one.
- Each Claude account has its own files, and profiles record which account wrote them.
- Setup asks the permission mode and `watch.max_open` once, and offers to start the account's sessions in auto mode, so headless launches need no extra flag.
- `/kharos:doctor` shows only what you can act on (`--verbose` for the rest), and warns when no environment is known to fit a repository or its setup script changed.

### Permissions

- A permission preflight before each launch lists the prompts the session is likely to hit, each with a narrow rule and the command that adds it (`docs/permissions.md`).
- The permission hook accepts prefix rules, such as `Bash(git push:*)`.
- Opt-in, off by default: automatic preflight writes those rules to a side branch of each launch, and the unblock preset allows every prompt in cloud sessions.
- The confirmation to mirror the organization's ask rules is asked again only when its managed settings change.
- A permission alert says why the prompt asks, in a fixed category; only the tool name and the category leave the machine.

### Follow and continuity

- `/kharos:run` now follows each session with a background agent that reports when it asks, waits on a permission prompt or ends; the watcher is optional (`docs/follow.md`).
- `/kharos:follow` picks open sessions up again, and a Stop hook starts a follower process for any open session nobody follows.
- Headless launches (`claude -p`) stay followed by a process of their own; `kharos follow <id>` does the same from a shell.
- Alerts nobody acknowledged are sent again when a follower restarts, and `/kharos:list` and `/kharos:doctor` flag a stuck or stopped follower.

### Launch

- `/kharos:run --queue` queues a launch that finds every `watch.max_open` slot taken, and kharos fires it when a slot frees.
- `/kharos:run --no-push` leaves out the request to push work in progress every 30 minutes.
- `kharos log <id> [lines] --cached` prints the stored log lines from a shell, with no model.
- `/kharos <action>` is a short form of `/kharos:<action>`; `/kharos` alone lists the actions.

### Fixes

- A `KHAROS-QUESTION` or `KHAROS-DONE` is no longer hidden when a repository's Stop hook or a background task notification comes right after it.
- A permission prompt the hook answers right away no longer raises an alert.
- `kharos list` keeps each session's title while a notice is open.
- `/kharos:result` names the repository in its fetch command, offers `claude --teleport` only when there is a branch or a pull request, and says when the last message was cut.

## 0.1.0

The first version published to npm.

- `/kharos:setup` writes a launch profile for a repository, and `/kharos:doctor` checks what a launch depends on, with the fix for each gap (`docs/setup.md`).
- `/kharos:run` launches one cloud session through the `RemoteTrigger` tool and records it; a second `run` of the same launch is refused, and a lost answer is recovered by reading.
- Launched sessions are followed with `/kharos:list`, `/kharos:log` and `/kharos:close`; `/kharos:send` sends a message into a running session, and `/kharos:result` shows its end mark, pull request and branch.
- The watcher (`/loop 10m /kharos:watch`) classifies each session from its log and tells apart a closed turn from the end; `kharos health` reports a watcher that stopped (`docs/watcher.md`).
- Events go to desktop notifications, a JSON-lines file, Slack, any command, or firstmate (`docs/outputs.md`).
- `/kharos:permissions` shows the permission rules a repository gives its cloud sessions and writes a profile of narrow allow rules after you approve the diff; a session waiting at a permission prompt raises a notice (`docs/permissions.md`).
- An opt-in permission hook, off by default, answers prompts in cloud sessions with your own allow patterns; broad patterns are accepted only with `--broad` and are marked.
- A logo and brand kit (`assets/brand/`).
- The `kharos` command from `npm install -g kharos`.

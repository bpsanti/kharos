# Changelog

## Unreleased

- The protocol footer tells the session that the log kharos reads cuts each message to about 2000 characters, so a long report goes in the pull request description or a file on its branch. The README's limits name what the tool cannot do: delete a routine, stop a session, list cloud environments outside `/schedule`, and tell kharos of a run refused in a permission dialog.
- `session.pr_opened` (`progress`): the session opened a pull request, with its URL in `pr`, as soon as a read shows the result of the call that created it, once per pull request; the firstmate output writes it as a `note`.
- Moving to the files of each Claude account: until `/kharos:setup` ran on an account, a launch and the permission preflight there name the shared files that hold its profiles and the command that moves them, instead of "no configuration yet" or "known: none". `/kharos:setup` moves nothing while a follower reads an open session of the account from the shared files, and says which, so a follower of an earlier kharos does not lose it. `kharos setup --permissions default` is accepted as `as-is`, the name `/kharos:permissions` uses.
- A session closed while it still runs is `closing`: it keeps its `watch.max_open` slot, and kharos goes on reading it, with no alerts, only to free the slot when the session ends or its deadline passes, whichever comes first; `kharos close <id> --stopped` frees it at once. Freeing the slot never stops the session. `/kharos:close` and `kharos list` say so, and the slots line names when each closing session frees its slot.
- Permission hook: `kharos permissions hook diff --mirror` says what happens to an organization ask rule it does not mirror (the hook denies it in cloud sessions, it does not stay a prompt), and its warning, like `hook show`, says that every other prompt is denied, Claude Code's own checks that no rule can allow included. `kharos permissions approvals --all` now lists a prompt whose log line carries the reason of the prompt instead of the command, decided with the command of its call, so the hook's denials of such prompts are there too. Hook script version 4: the same decisions, with no two-letter names that a repository's own lint rules can flag; `kharos permissions hook diff` updates an installed copy.
- A turn that closed with no end mark is reported (`session.quiet_unmarked`) after `watch.unmarked_end_min`, 5 minutes by default, when it started no background task; one that started a command in the background, a `Monitor` or a background agent keeps `watch.quiet_end_min` (40), since that task may wake it. The notice says which.
- `/kharos:run --revision <branch>` starts the session on another branch or tag than the profile's, for that launch only; the permission preflight reads that branch, and the launch checks that it exists every time.
- A `run` that the auto mode classifier refused goes back to "routine created" (a `PermissionDenied` hook): nothing reached the service, so `/kharos:run --resume` fires it once with no re-arm, a queued launch is tried again, and `kharos show` names the refusal. A refusal in a permission dialog or in a headless session outside auto mode reaches no hook, and keeps the re-arm path.
- `kharos log <id> [lines]` in a shell prints the events already stored for a session, with no model (`--cached` does the same anywhere), and `--full` prints each event's whole stored text instead of its start. `kharos show` names the session's last message and its time, which tells a turn closed on the session's own build from one that stopped.
- `/kharos:result` says the last message is cut only when the message itself is, not when only the result line that repeats it is.
- `/kharos:close <id> --ask-stop` sends the session a request to stop (start nothing new, commit and push what is worth keeping unless the launch was `--no-push`, end the turn) before it is released; when the request cannot be sent, the session stays followed. Without it, the output of `/kharos:close` on a running session says how to ask.
- The deadline counts from the moment the cloud session opened, not from the preparation of the launch: the wait for an approval, a refused fire or a place in the queue no longer count. `session.overdue` is raised once per session, and not again at once when a message reopens a session past its deadline; such a session is then still told when it loops, goes silent or closes a turn without an end mark.

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

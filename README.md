<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-dark-card.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/wordmark.svg">
    <img src="assets/brand/wordmark.svg" alt="kharos logo: a coin with a canoe over waves" width="280">
  </picture>
</p>

# kharos

**Your agents, on the other shore.**

`kharos` is a plugin for Claude Code.
It launches cloud sessions of Claude Code (claude.ai/code) from any terminal session, follows their progress, sends them messages mid-run, and tells you when one needs you, is stuck, or is done.
You drive a cloud session much like a local background subagent: launch it, keep working, and its follower reports back when the session asks something, waits on a permission prompt, or ends.

It uses only official surfaces: the `RemoteTrigger` tool built into Claude Code and the unmodified `claude` binary.
It never reads, stores, or relays your claude.ai login or any token.

Status: early development.

## When to use something else

| You want | Use |
|---|---|
| A stream of related tasks with shared context, followed on the web, desktop or phone | Claude Projects |
| One goal across several repositories, with a pull request each | Claude Projects |
| One isolated task, with no need for the terminal or outside notices | `claude --cloud "<task>"` or claude.ai/code |
| A task that repeats on a schedule | A scheduled task (`/schedule`) |
| Launching and following from the terminal, or notifying another system | kharos |
| A repository whose own hooks and `.claude/settings.json` must load in the session | kharos (a session on one repository loads them) |

## Requirements

- A claude.ai login on a Pro, Max, Team or Enterprise plan. API keys, Bedrock and Vertex do not work, and `ANTHROPIC_API_KEY` must not be set, because it takes precedence over the login.
  On Team and Enterprise, an owner can turn off cloud sessions or scheduled tasks; then the `RemoteTrigger` tool does not appear.
- Claude Code 2.1.323 or newer.
- Node.js 22.18 or newer on the machine (the plugin is TypeScript that Node runs directly, with no build and no runtime dependency; the npm package carries the compiled JavaScript).
- GitHub access for the Claude side, one of:
  - the Claude GitHub App installed with access to the repository (https://github.com/apps/claude); in an organization only an owner can install it;
  - or `/web-setup` in Claude Code, which sends your `gh` token to your Claude account.
- The repository has at least one commit.
- A cloud environment on claude.ai/code, once per account; Claude Code creates a first one when the account has none, and `/kharos:setup` lets you pick it by name.
  When none fits the repository, `/kharos:setup` prepares what to paste into a new one: see [creating a cloud environment](docs/setup.md#creating-a-cloud-environment).

## Install

```
/plugin marketplace add bpsanti/kharos
/plugin install kharos@kharos
```

Then run `/kharos:setup` in the repository you want to launch sessions on, once per Claude account.
It shows one list of everything a launch needs, in order (account and plan, GitHub connection, repository access, cloud environment, commit identity, permission prompts, profile), each with its state and the one action that fixes it.
It checks again after each fix, asks only what it cannot settle itself (the environment by name when there are several, and the permission mode, once), then writes the profile and ends with a short summary and the next action: see [docs/setup.md](docs/setup.md).

Every launch asks for your approval before its routine is created and run: Claude Code ignores allow rules for that and offers no "always allow".
In auto mode its classifier reviews the launch instead: unblock all (`/kharos:permissions`, or setup's `unblock-all` permission mode) starts the account's sessions in auto mode (every session of the account, not only launches), and then headless launches need nothing extra; otherwise a headless launch needs `claude -p --permission-mode auto` ([docs/setup.md](docs/setup.md#launch-approval)).

Cloud sessions push with the GitHub credential your Claude account has, and author commits as `Claude <noreply@anthropic.com>` unless the environment sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` (on claude.ai/code: the environment's settings, Environment variables).

The plugin runs the `kharos` CLI by itself.
To run it from your own shell too (see [For scripts](#for-scripts)), install it from npm:

```
npm install -g kharos
```

### Updating

`/kharos:doctor` shows the installed kharos and the latest release on GitHub, and when a newer one is out, what changed between them from `CHANGELOG.md`.
It then asks once whether to update; on yes it runs `claude plugin marketplace update kharos` and `claude plugin update kharos@kharos` for the Claude account in use, and you restart Claude Code to load the new version.
Nothing is updated without that yes.
A `kharos` command installed from npm gets its own line with the `npm install -g` command to run; npm is asked about it at most once a day while it is current, and again on each doctor while it is outdated.
Run from that npm command itself, `kharos doctor` and the daily line give that `npm install -g` command instead of the plugin update.

`/kharos:run` and `/kharos:list` add one line when a newer release is out, such as `kharos 0.3.2 is available (you have 0.3.1); /kharos:doctor shows what changed and updates it.`, at most once a day.
The release is read from GitHub at most once a day, in a background process, so it never slows a command; without a network it says nothing.
Set `"update": { "notify": false }` in the configuration to turn the line off.

## Commands

| Command | What it does |
|---|---|
| `/kharos:setup [owner/repo] [--profile p] [--revision branch]` | Takes this Claude account from zero to ready for a repository, once, then writes its launch profile |
| `/kharos:doctor [--profile p] [--verbose]` | Checks login, plan, configuration, repository, Claude access, environment and permission rules, with the action for each gap; shows a newer kharos release, with what changed, and updates the plugin on your yes ([Updating](#updating)); `--verbose` adds limits and policy counts |
| `/kharos:run "<instruction>" [--profile p] [--revision branch] [--model m] [--title t] [--deadline min] [--file path] [--no-push] [--queue]` | Launches one cloud session, records it, and starts its follower in the background; `--revision` starts it on another branch or tag than the profile's; `--no-push` leaves out the footer line that asks the session to push work in progress; `--queue` queues a launch that finds every slot taken |
| `/kharos:list [--all]` | Lists followed sessions from the local registry, with their followers and the open slots |
| `/kharos:log <id> [lines]` | Shows the last lines of a session's log |
| `/kharos:send <id> "<text>"` | Sends a message into the session; the reply shows on the next read |
| `/kharos:result <id>` | Shows the end mark, pull request and branch, the final report put together from its numbered parts (or the last message), and how to bring the work here |
| `/kharos:close <id> [--ask-stop] [--stopped]` | Stops following a session, and shows where to delete its routine; `--ask-stop` first sends the session a request to stop; cancels a queued launch. A session that still runs is `closing` (below) |
| `/kharos:permissions [on\|off\|state]` | Unblock all: frees every permission prompt kharos can free for this account, in one step, after one confirmation; `off` takes back what it turned on; `state` shows where it stands. It never changes a repository's own files |

Commands that spend plan usage or change state can only be started by you, not by the model.

Both forms work: `/kharos:log k-0001` and `/kharos log k-0001`; `/kharos` alone lists the commands above.

### For scripts

The `kharos` CLI also serves scripts and orchestrators, with no model: `kharos prepare` (with `--output firstmate --status-file <file> --firstmate-home <home>` for the firstmate adapter), `show`, `list`, `log <id> [lines] [--full]` (the events already stored), `send`, `result`, `close [--ask-stop] [--stopped]`, `follow <id> [--detach]`, `wait`, `followers`, `health` (exits with 1 when an open session has no live follower, for cron or launchd) and `permissions approvals` (what the permission hook allowed).
`kharos help` lists every command.

## How a launch works

1. `kharos prepare` checks the profile, the login, the repository and the number of open sessions, and writes the routine body to disk.
2. The model calls `RemoteTrigger create` with a placeholder; the plugin's hook puts in the stored body, so the model never copies the instruction by hand.
   The routine is created disabled, with a run date a year ahead, so it never fires by itself.
   Creating it costs nothing, and it is also where the service checks the repository: a `repo_access_denied` answer stops the launch with the exact fix, before any session exists.
3. The model calls `RemoteTrigger run` once.
   The hook records each step before the call that depends on it and refuses a second `run`, because a repeated run starts another paid session.
4. The session id and link go into the registry, and the session is followed from then on.

When the answer to `run` is lost, `/kharos:run --resume <id>` asks `list_runs` for the session instead of firing again.
If `list_runs` shows no session, kharos never fires again by itself, because a `run` still waiting at a permission prompt would start a second session once approved.
The person checks the routine page, and when it shows no run and no Claude Code window is still asking to approve the run, `/kharos:run --rearm <id>` re-arms the launch.
The re-arm is accepted only within 10 minutes of an empty `list_runs`, asks for its own approval, and fires nothing; `/kharos:run --resume <id>` then fires it once.
A run that the auto mode classifier refused needs no re-arm: Claude Code tells kharos about that refusal, so the launch goes back to "routine created" and `/kharos:run --resume <id>` fires it once; a refusal in a permission dialog, or in a headless session that is not in auto mode, reaches no hook, so it keeps the re-arm path.

### Closing a session

A session closed while it still runs keeps its `watch.max_open` slot: it is `closing`, and kharos goes on reading it, with no alerts, only to free the slot when the session ends or when its deadline passes, whichever comes first.
`kharos close <id> --stopped` frees the slot at once, for a session you saw stop.
Freeing the slot never stops the session: only `--ask-stop` asks it to stop (it commits and pushes what it has first, unless the launch was `--no-push`), and only its page stops it.

### Queued launches

A launch refused because every `watch.max_open` slot is taken can wait instead: `/kharos:run --queue "<instruction>"` runs every check and the permission preflight as usual, stores the routine body, and records the launch as `queued`, with nothing created.
When a slot frees (a session ends, is closed or is refused, or a closing one ends or reaches its deadline), the hook or command that sees it starts a dispatcher, which fires the oldest queued launch it can fire now, then the next while slots are free:

- The fire is a paid action with nobody present: a minimal headless Claude Code in auto mode makes the same RemoteTrigger calls `/kharos:run --resume` names, so Claude Code's classifier approves the `run`, and the hook allows one `run` per launch, as always.
- Only the Claude account that queued a launch fires it; under another login it stays queued, and an event says so.
- The session it opens gets a follower process, and its events go to the outputs.
- A fire that does not go through is tried again 10 minutes later, 3 times in all; then a `session.not_fired` event asks the person, and `/kharos:run --resume <id>` fires it with the person present.
  A launch left to the person no longer holds up the queue or a new launch; resuming it while every slot is taken puts it back in line, and it fires by itself again.
- `/kharos:run --resume <id>` takes a launch out of the queue: from then on the person fires it, and the dispatcher no longer does.
- A queued launch holds no slot, and is ahead of any new launch: a slot that frees is the queue's first.
- `kharos list` and `/kharos:doctor` show the queue, and `/kharos:close <id>` cancels a queued launch, with nothing created and nothing spent.
- When the organization disabled auto mode, `--queue` is refused, since nobody could approve the fire.

The one-run guard covers only launches kharos knows.
Calling RemoteTrigger `run` by hand on a routine id read elsewhere (the routine page, /schedule) starts another paid session, and the service has no fire-once flag.
While the registry file cannot be read, every `run`, `list_runs` and `get_run_log` answer is hidden behind one line that names the file, because kharos cannot tell its own launches from others.

The instruction gets a short footer: the session ends with a `KHAROS-DONE {...}` line when it is truly finished, or a `KHAROS-QUESTION {...}` line when it needs an answer, sends its final report before the end mark in numbered parts (`KHAROS-PART <i>/<n>`, each a message of its own of at most 1500 characters, since the log keeps about 2000 of each message), and pushes work in progress every 30 minutes.
`--no-push` leaves that last line out, for work that should reach the remote only when the session decides it is done.

## Following sessions

By default, `/kharos:run` ends by starting the plugin's `kharos:follow` agent in the background, one per session, and you go on working.
The follower is a small Haiku agent that sits inside `kharos wait <id>`, which reads the session's log every 15 to 60 seconds and returns only when its state changes.
The followers due at the same moment read together, in one reader process per round of up to 20 sessions.
Its report reaches your session like the result of any background subagent:

- a question from the session, which you answer with `/kharos:send <id> "<answer>"`;
- a permission prompt, with the tool's name, a fixed category of why it asks, and the link to the session page, where you answer it;
- the end, with the status, the summary, the pull request and the branch;
- a failure, a usage limit, or another notice, with the link.

After a report that is not the end, your session starts the follower again at once, and an answer you send does not wake it before the next real change.
Closing Claude Code stops its follower agents; the cloud session goes on.
At the end of every turn of a Claude Code session with kharos, its Stop hook starts a follower process (the one `kharos follow <id> --detach` starts) for each open session that no follower reads, so a follower that died is replaced without anyone asking.
It reads only local files and calls nothing unless a follower is missing, and never starts a second follower for a session.

### Headless launches

A headless Claude Code (`claude -p "/kharos:run ..."`, or the Agent SDK) stops its background agents 10 minutes after its last turn, so a follower agent there would stop long before the session ends.
There, `/kharos:run` starts no agent: each session is followed by a process of its own, `kharos follow <id>`, the follower's loop without a model, which goes on after `claude -p` exits.
`claude -p` then ends right after the launch, and says where the follower writes and how to answer.
What it sees reaches your outputs (desktop notification, `events.jsonl`, Slack, a command, firstmate), and `kharos list` shows the state.
Answer a question with `claude -p '/kharos:send <id> <answer>'`, and a permission prompt on the session page.
To keep a follower agent inside the headless launch instead, start it with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: `claude -p` then stays running until the session ends.

Two more things a headless launch needs:

- The `run` step needs an approval that `--allowedTools` does not give: start `claude -p` with `--permission-mode auto`, or start the account's sessions in auto mode with unblock all, so the classifier reviews the launch.
- Give it an empty stdin (`< /dev/null`) when nothing is piped in, or `claude -p` waits for input before it starts.

`kharos follow <id>` also runs in your own shell or from another orchestrator: it prints one JSON line per change, the same line as `kharos wait`, until the session ends.

What to expect:

- A change reaches you within about a minute, at your session's next turn.
- kharos cannot stop a cloud session (the tool has no stop action): `/kharos:send` can ask it to stop, and its page stops it.
- Permission prompts are answered by a person on the session page, as before.
- The work comes back as a branch or a pull request, not as files in your checkout.
- Reads go through a minimal headless `claude -p` on Haiku, a fraction of a cent, because only a model can call the `RemoteTrigger` tool that reads a cloud session; one such process reads every session whose read is due in the same round.

See [docs/follow.md](docs/follow.md) for how it works and its limits.

### What a follower reports

Each read is classified by code, not by the model: `running`, `turn_closed`, `silent`, `waiting_answer`, `waiting_permission`, `looping`, `overdue`, `usage_limit`, `invisible`, `finished`, `failed`.
Only the session's own `KHAROS-DONE` mark ends it, and "could not read" is never taken for "finished".
When a turn closes without the mark and stays quiet for `watch.unmarked_end_min` (5 minutes), with no background task left that could wake it (every task it started, a background command, a `Monitor` or a background agent, has ended, by its notice of the end, a wait on its output that saw it end, or a stop that worked), the follower asks the session once whether it finished: one short message that asks for the final report in `KHAROS-PART` messages and the `KHAROS-DONE` line, or to go on with its work.
The session ends when it answers with `KHAROS-DONE`, and is `running` again when it goes on working; with no answer, or an answer with neither, it stays `turn_closed` with the `session.quiet_unmarked` warning, keeps its `watch.max_open` slot, and is closed at its deadline with `session.deadline_closed` (`terminal`), which carries its last message.
It is asked once per quiet period, never past its deadline, and never once you closed it.
While a task it started may still wake it, a closed turn is only a warning after `watch.quiet_end_min` (40 minutes).
A session waiting at a permission prompt raises a notice that names the tool and a fixed category of why it asks (an ask rule of the organization, an ask rule of the repository, a check of Claude Code itself that no rule can allow, the auto mode classifier after blocked calls, or a reason kharos cannot tell), with the link to the session, where a person answers it.
Only the tool name and a fixed category leave the machine: what the tool would run never does.
`kharos health` exits with 1 when an open session has no live follower, for launchd, cron or any other check.
`/kharos:list` shows each follower's heartbeat, and `/kharos:list` and `/kharos:doctor` flag a follower whose heartbeat stopped for more than 3 minutes: stuck while its process still runs, or stopped without handing over.
See [docs/states.md](docs/states.md) for the rules, the numbers behind them, and the event format.

## Permission prompts

A cloud session that a routine starts runs in auto mode ([scheduled tasks](https://code.claude.com/docs/en/routines)).
It still stops at a prompt for `ask` rules, both the organization's managed ones and the repository's, and after the classifier blocks 3 actions in a row or 20 in the session ([permission modes](https://code.claude.com/docs/en/permission-modes)).
Cloud sessions have no bypass mode, auto mode drops broad allow rules such as `Bash(*)`, and no allow rule outranks an ask rule.
The routine's `allowed_tools` neither allows nor restricts anything there.

Before each launch, `/kharos:run` runs a permission preflight: the prompts the session is likely to hit (the organization's ask rules, commands of the repository that such a rule covers, and prompts of earlier sessions on the same repository), each with the narrow rule that answers it, and why.
By default kharos answers no prompt: it tells you when one waits, and you answer it on the session page.

To free everything kharos can free for a Claude account, run `/kharos:permissions` (opt-in, off by default, refused in part when the organization disabled bypass mode or auto mode).
It lists, once, what it frees, and after your one confirmation it turns on all of it:

- the unblock preset of the kharos permission hook, confirmed for the organization's current managed settings, which allows every prompt in cloud sessions, so none waits on a person; the organization's deny rules are never touched, and kharos asks again when those settings change;
- automatic preflight: at each launch, kharos writes the hook with the preset and the preflight's narrow rules to a side branch `kharos/<id>` of the launch and starts the session there, so the branch your team shares is never changed; `/kharos:close` deletes the side branch;
- the account's sessions in auto mode, so launches need no approval prompt (every session of the account, not only launches).

kharos never changes a repository's own `.claude/settings.json`: what unblock all needs goes only to the side branch of each launch.
`/kharos:setup` offers the same as its `unblock-all` permission mode: it shows the full list of what unblock all frees before it asks, and when you pick that mode it turns all of it on itself.
When Claude Code keeps no copy of the organization's managed settings for the account (`remote-settings.json` in its config folder, which Claude Code does not write when the organization has none), unblock all says how to check, and then lets you state, in the same confirmation, that the account has no organization settings; kharos asks again if a copy appears later ([docs/permissions.md](docs/permissions.md#no-copy-of-the-organizations-settings)).
`/kharos:permissions off` takes back what it turned on, leaving what was on before it as it was, and `/kharos:permissions state` and `/kharos:doctor` show in one line whether it is on, partly on (and what is missing), or off.
kharos logs each of the hook's decisions as it reads the session, and `kharos permissions approvals` lists them.
`/kharos:doctor` warns when a launch branch would likely stall, about managed ask rules that would stop a session, about broad rules or modes that cloud sessions ignore, and while unblock all is on: see [docs/permissions.md](docs/permissions.md).

## Outputs

Events go to the outputs of the configuration: desktop notification, a JSON-lines file, Slack (the webhook URL is kept in the keychain as the plugin's `slack_webhook` option), any command, and the firstmate adapter.
By default you get a notification when a session needs you or ends, and every event in `~/.local/state/kharos/events.jsonl`.
That file is kharos's journal: it holds every event whatever the outputs are, with a `delivered` mark once the outputs got it and an `acknowledged` mark once a follower handed it on; a follower that starts again first sends the alerts no follower acknowledged.
See [docs/outputs.md](docs/outputs.md).

## Files

| Path | Content |
|---|---|
| `~/.config/kharos/config.json` | Profiles, thresholds and outputs ([schema](schema/config.schema.json)) |
| `~/.local/state/kharos/sessions.json` | The registry, mode 0600, written atomically under a lock |
| `~/.local/state/kharos/events.jsonl` | The journal: every event, with its `delivered` and `acknowledged` marks |
| `~/.local/state/kharos/logs/<id>.jsonl` | The events read from each session, deleted 14 days after it is closed |
| `~/.local/state/kharos/followers/<id>.json` | The lease of the follower that reads a session now: its process id, its kind (agent or process) and a heartbeat, or a handover while the next follower starts |
| `~/.local/state/kharos/rounds.json` | The read rounds of the last minute: which followers share a reader, with each one's result and share of the cost, never a log |
| `~/.local/state/kharos/repo-rules.json` | The ask rules of each launch branch's `.claude/settings.json`, as the last launch preflight read them, to tell a repository prompt from the rest |
| `~/.local/state/kharos/setups.json` | The cloud environments you confirmed, by account, repository and revision |
| `~/.local/state/kharos/approvals.jsonl` | The permission hook's decisions, as kharos read them: time, session, tool, decision and matched rule, never the command |
| `~/.local/state/kharos/preflight.jsonl` | What automatic preflight applied at each launch: session, side branch, commit, rules |
| `~/.local/state/kharos/org-confirmations.json` | Your confirmation of the unblock preset, with the fingerprint of the managed settings it holds for |
| `~/.local/state/kharos/release.json` | The latest kharos release, as the last daily read found it, and when its notice was last shown |

Each Claude account has its own files: with a `CLAUDE_CONFIG_DIR` other than `~/.claude`, they are under `accounts/<folder>-<hash>/` of both folders, and the first `/kharos:setup` there moves that account's profiles and sessions out of the files every account shared before.
`KHAROS_HOME` puts everything under one folder of your choice instead.

## Limits to know

| Limit | Value |
|---|---|
| Runs started by hand, per routine | 30 per hour |
| Runs started by hand, per account | 100 per hour |
| Concurrent cloud sessions | exists; no published number (`watch.max_open` is a local cap, 10 by default, that `/kharos:setup` asks once; `--queue` waits for a slot instead of being refused) |
| Session cost | not readable: the run log the tool returns carries no token usage or cost, so kharos cannot show what a session spent; the usage page of claude.ai does, and `--deadline` raises an overdue notice past a set time |
| Message length in the log | each message is cut to about two thousand characters and flattened to one line, and what a session only thought never shows; the footer asks for the final report in numbered parts, `/kharos:result` puts them together and names the parts that are missing or cut, and the session page has the whole text |
| Deleting a routine | not possible through the tool: each launch leaves a disabled routine, and `/kharos:close` prints the link of its page, where it is deleted |
| Stopping a session | not possible through the tool: `/kharos:close --ask-stop` asks the session to stop, and its page stops it |
| Listing cloud environments | only through the bundled `/schedule` skill, which `/kharos:setup` uses; a shell has no way to list them |
| Refusing a run at a prompt | Claude Code tells a hook only when the auto mode classifier refuses; a "no" in a permission dialog, or a refusal in a headless session outside auto mode, leaves the launch at `launch firing` until it is re-armed |
| Cloud machine | 4 vCPU, 16 GB, 30 GB of disk |
| Usage | the same plan usage as everything else: five sessions spend five times |

## Why kharos

The name comes from Kharon (Charon), the ferryman of Greek myth who carries travelers across the river for a single coin, the obol on the logo; *kharos* follows the modern Greek form of his name, Charos.
kharos does the same for your work: it carries a task to a Claude Code session in the cloud, watches the crossing, and brings the result back to your session.
One launch, one crossing; nothing is fired twice.

## Development

```
npm ci
npm run check        # typecheck and tests
npm run validate     # claude plugin validate . --strict
npm run build        # compile to dist/, which only the npm package ships
```

This project is not affiliated with or endorsed by Anthropic.
It works with Claude Code.

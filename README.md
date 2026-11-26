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
In auto mode its classifier reviews the launch instead: setup offers, once, to start the account's sessions in auto mode (every session of the account, not only launches), and then headless launches need nothing extra; otherwise a headless launch needs `claude -p --permission-mode auto` ([docs/setup.md](docs/setup.md#launch-approval)).

Cloud sessions push with the GitHub credential your Claude account has, and author commits as `Claude <noreply@anthropic.com>` unless the environment sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` (on claude.ai/code: the environment's settings, Environment variables).

The plugin runs the `kharos` CLI by itself.
To run it from your own shell too, for `kharos health` from cron or launchd or `kharos permissions approvals`, install it from npm:

```
npm install -g kharos
```

## Commands

| Command | What it does |
|---|---|
| `/kharos:setup [owner/repo] [--profile p] [--revision branch]` | Takes this Claude account from zero to ready for a repository, once, then writes its launch profile |
| `/kharos:doctor [--profile p] [--verbose]` | Checks login, plan, configuration, repository, Claude access, environment and permission rules, with the action for each gap; `--verbose` adds limits, the watcher and policy counts |
| `/kharos:permissions [default\|standard\|hook\|preflight\|unblock\|account-mode] [folder]` | Shows the permission rules a repository gives its cloud sessions, writes narrow allow rules to its `.claude/settings.json`, or installs the opt-in permission hook, each after you approve the diff; lists the prompts a launch is likely to hit; `account-mode` sets whether the account's sessions start in auto mode; never commits or pushes |
| `/kharos:run "<instruction>" [--profile p] [--revision branch] [--model m] [--title t] [--deadline min] [--file path] [--no-push] [--queue]` | Launches one cloud session, records it, and starts its follower in the background; `--revision` starts it on another branch or tag than the profile's; `--no-push` leaves out the footer line that asks the session to push work in progress; `--queue` queues a launch that finds every slot taken |
| `/kharos:follow [id]` | Starts a follower again for each open session nobody follows, after Claude Code was closed and opened again (a follower process of its own in a headless Claude Code) |
| `/kharos:list [--all] [--refresh]` | Lists followed sessions from the local registry; `--refresh` reads each open session first |
| `/kharos:log <id> [lines]` | Shows the last lines of a session's log; in a shell, `kharos log <id> [lines]` prints the events already stored, with no model, and `--full` prints each one's whole stored text |
| `/kharos:send <id> "<text>"` | Sends a message into the session; the reply shows on the next read |
| `/kharos:result <id>` | Shows the end mark, pull request and branch, and how to bring the work here |
| `/kharos:close <id> [--ask-stop]` | Stops following a session, and shows where to delete its routine; `--ask-stop` first sends the session a request to stop; cancels a queued launch |
| `/kharos:watch` | One watcher pass, the advanced mode; run it as `/loop 10m /kharos:watch` in a session of its own |

Commands that spend plan usage or change state can only be started by you, not by the model.

Both forms work: `/kharos:log k-0001` and `/kharos log k-0001`; `/kharos` alone lists the actions (for `/loop`, use `/kharos:watch`).

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

### Queued launches

A launch refused because every `watch.max_open` slot is taken can wait instead: `/kharos:run --queue "<instruction>"` runs every check and the permission preflight as usual, stores the routine body, and records the launch as `queued`, with nothing created.
When a slot frees (a session ends, is closed or is refused), the hook or command that sees it starts a dispatcher, which fires the oldest queued launch it can fire now, then the next while slots are free:

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

The instruction gets a short footer: the session ends with a `KHAROS-DONE {...}` line when it is truly finished, or a `KHAROS-QUESTION {...}` line when it needs an answer, and pushes work in progress every 30 minutes.
`--no-push` leaves that last line out, for work that should reach the remote only when the session decides it is done.

## Following sessions

By default, `/kharos:run` ends by starting the plugin's `kharos:follow` agent in the background, one per session, and you go on working.
The follower is a small Haiku agent that sits inside `kharos wait <id>`, which reads the session's log every 15 to 60 seconds and returns only when its state changes.
Its report reaches your session like the result of any background subagent:

- a question from the session, which you answer with `/kharos:send <id> "<answer>"`;
- a permission prompt, with the tool's name, a fixed category of why it asks, and the link to the session page, where you answer it;
- the end, with the status, the summary, the pull request and the branch;
- a failure, a usage limit, or another notice, with the link.

After a report that is not the end, your session starts the follower again at once, and an answer you send does not wake it before the next real change.
Closing Claude Code stops its followers; the cloud session goes on, and `/kharos:follow` picks the open sessions up again.
At the end of every turn of a Claude Code session with kharos, its Stop hook starts a follower process (the one `kharos follow <id> --detach` starts) for each open session that no follower reads, so a follower that died is replaced without anyone asking.
It reads only local files and calls nothing unless a follower is missing, starts nothing while the watcher runs, and never starts a second follower for a session.

### Headless launches

A headless Claude Code (`claude -p "/kharos:run ..."`, or the Agent SDK) stops its background agents 10 minutes after its last turn, so a follower agent there would stop long before the session ends.
There, `/kharos:run` and `/kharos:follow` start no agent: each session is followed by a process of its own, `kharos follow <id>`, the follower's loop without a model, which goes on after `claude -p` exits.
`claude -p` then ends right after the launch, and says where the follower writes and how to answer.
What it sees reaches your outputs (desktop notification, `events.jsonl`, Slack, a command, firstmate), and `kharos list` shows the state.
Answer a question with `claude -p '/kharos:send <id> <answer>'`, and a permission prompt on the session page.
To keep a follower agent inside the headless launch instead, start it with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: `claude -p` then stays running until the session ends.

Two more things a headless launch needs:

- The `run` step needs an approval that `--allowedTools` does not give: start `claude -p` with `--permission-mode auto`, or let `/kharos:setup` start the account's sessions in auto mode, so the classifier reviews the launch.
- Give it an empty stdin (`< /dev/null`) when nothing is piped in, or `claude -p` waits for input before it starts.

`kharos follow <id>` also runs in your own shell or from another orchestrator: it prints one JSON line per change, the same line as `kharos wait`, until the session ends.

What to expect:

- A change reaches you within about a minute, at your session's next turn.
- kharos cannot stop a cloud session (the tool has no stop action): `/kharos:send` can ask it to stop, and its page stops it.
- Permission prompts are answered by a person on the session page, as before.
- The work comes back as a branch or a pull request, not as files in your checkout.
- Each read is one minimal headless `claude -p` call on Haiku, a fraction of a cent, because only a model can call the `RemoteTrigger` tool that reads a cloud session.

See [docs/follow.md](docs/follow.md) for how it works and its limits.

### The watcher, the advanced mode

For many sessions at once, headless launches, or outputs that must keep going with no terminal open (Slack, firstmate), run the watcher in a separate terminal with a small model:

```
claude --model haiku
/loop 10m /kharos:watch
```

Both modes share the registry, the rules and the outputs, and can run together: each event is emitted once, whichever process read, and the watcher leaves a session to its live follower.
Each read is classified by code, not by the model: `running`, `turn_closed`, `silent`, `waiting_answer`, `waiting_permission`, `looping`, `overdue`, `usage_limit`, `invisible`, `finished`, `failed`.
A closed turn is never taken for the end: only the session's own `KHAROS-DONE` mark ends it, and "could not read" is never taken for "finished".
A session waiting at a permission prompt raises a notice that names the tool and a fixed category of why it asks (an ask rule of the organization, an ask rule of the repository, a check of Claude Code itself that no rule can allow, the auto mode classifier after blocked calls, or a reason kharos cannot tell), with the link to the session, where a person answers it.
Only the tool name and a fixed category leave the machine: what the tool would run never does.
`kharos health` exits with 1 when an open session has no live follower and the watcher stopped, for launchd, cron or any other check.
`/kharos:list` shows each follower's heartbeat, and `/kharos:list` and `/kharos:doctor` flag a follower whose heartbeat stopped for more than 3 minutes: stuck while its process still runs, or stopped without handing over.
See [docs/watcher.md](docs/watcher.md) for the rules, the numbers behind them, and the event format.

## Permission prompts

A cloud session that a routine starts runs in auto mode ([scheduled tasks](https://code.claude.com/docs/en/routines)).
It still stops at a prompt for `ask` rules, both the organization's managed ones and the repository's, and after the classifier blocks 3 actions in a row or 20 in the session ([permission modes](https://code.claude.com/docs/en/permission-modes)).
Cloud sessions have no bypass mode, auto mode drops broad allow rules such as `Bash(*)`, and no allow rule outranks an ask rule.
The routine's `allowed_tools` neither allows nor restricts anything there.
`/kharos:permissions` shows a repository's rules, and adds narrow allow rules for its own commands (the `standard` profile).
The opt-in permission hook (off by default) answers prompts in cloud sessions with your own allow patterns (narrow ones, unless you ask for broad ones with `--broad`), and denies the rest with a message that names the allowed form, so the session sends the right command instead of waiting.
When the organization has not disabled bypass mode, it can also mirror the organization's ask rules as a cloud-only allow, after you confirm the list once (kharos asks again only when the organization's rules change); deny rules are never touched.
Before each launch, `/kharos:run` runs a permission preflight: the prompts the session is likely to hit (the organization's ask rules, commands of the repository that such a rule covers, and prompts of earlier sessions on the same repository), each with the narrow rule that answers it, why, and the exact command that adds them.
With automatic preflight (opt-in, off by default), kharos writes those narrow rules itself to a side branch `kharos/<id>` of each launch and starts the session there, so the branch your team shares is never changed; `/kharos:close` deletes the side branch.
The unblock preset (opt-in, off by default, refused when the organization disabled bypass mode) goes further: confirmed once, it makes the hook allow every prompt in cloud sessions, so none waits on a person.
The watcher logs each of the hook's decisions, and `kharos permissions approvals` lists them.
`/kharos:doctor` warns when a launch branch would likely stall, about managed ask rules that would stop a session, about broad rules or modes that cloud sessions ignore, and while the hook is on: see [docs/permissions.md](docs/permissions.md).

## Outputs

Events go to the outputs of the configuration: desktop notification, a JSON-lines file, Slack (the webhook URL is kept in the keychain as the plugin's `slack_webhook` option), any command, and the firstmate adapter.
By default you get a notification when a session needs you or ends, and every event in `~/.local/state/kharos/events.jsonl`.
That file is kharos's journal: it holds every event whatever the outputs are, with a `delivered` mark once the outputs got it and an `acknowledged` mark once a follower handed it on; a follower that starts again first sends the alerts no follower acknowledged.
See [docs/outputs.md](docs/outputs.md).

## Files

| Path | Content |
|---|---|
| `~/.config/kharos/config.json` | Profiles, watcher thresholds and outputs ([schema](schema/config.schema.json)) |
| `~/.local/state/kharos/sessions.json` | The registry, mode 0600, written atomically under a lock |
| `~/.local/state/kharos/events.jsonl` | The journal: every event, with its `delivered` and `acknowledged` marks |
| `~/.local/state/kharos/logs/<id>.jsonl` | The events read from each session, deleted 14 days after it is closed |
| `~/.local/state/kharos/followers/<id>.json` | The lease of the follower that reads a session now: its process id, its kind (agent or process) and a heartbeat, or a handover while the next follower starts |
| `~/.local/state/kharos/repo-rules.json` | The ask rules of each launch branch's `.claude/settings.json`, as the last launch preflight read them, to tell a repository prompt from the rest |
| `~/.local/state/kharos/setups.json` | The cloud environments you confirmed, by account, repository and revision |
| `~/.local/state/kharos/approvals.jsonl` | The permission hook's decisions the watcher read: time, session, tool, decision and matched rule, never the command |
| `~/.local/state/kharos/preflight.jsonl` | What automatic preflight applied at each launch: session, side branch, commit, rules |
| `~/.local/state/kharos/org-confirmations.json` | Your confirmations to mirror the organization's ask rules and of the unblock preset, each with the fingerprint of the managed settings it holds for |

Each Claude account has its own files: with a `CLAUDE_CONFIG_DIR` other than `~/.claude`, they are under `accounts/<folder>-<hash>/` of both folders, and the first `/kharos:setup` there moves that account's profiles and sessions out of the files every account shared before.
`KHAROS_HOME` puts everything under one folder of your choice instead.

## Limits to know

| Limit | Value |
|---|---|
| Runs started by hand, per routine | 30 per hour |
| Runs started by hand, per account | 100 per hour |
| Concurrent cloud sessions | exists; no published number (`watch.max_open` is a local cap, 10 by default, that `/kharos:setup` asks once; `--queue` waits for a slot instead of being refused) |
| Session cost | not readable: the run log the tool returns carries no token usage or cost, so kharos cannot show what a session spent; the usage page of claude.ai does, and `--deadline` raises an overdue notice past a set time |
| Message length in the log | each message is cut to about two thousand characters and flattened to one line; `/kharos:result` says when the last one was cut, and the session page has the whole text |
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

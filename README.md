<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/wordmark.svg">
    <img src="assets/brand/wordmark.svg" alt="kharos logo: a coin with a canoe over waves" width="280">
  </picture>
</p>

# kharos

`kharos` is a plugin for Claude Code.
It launches cloud sessions of Claude Code (claude.ai/code) from any terminal session, follows their progress, sends them messages mid-run, and tells you when one needs you, is stuck, or is done.

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
- Node.js 22.18 or newer on the machine (the plugin is TypeScript that Node runs directly, with no build and no runtime dependency).
- GitHub access for the Claude side, one of:
  - the Claude GitHub App installed with access to the repository (https://github.com/apps/claude); in an organization only an owner can install it;
  - or `/web-setup` in Claude Code, which sends your `gh` token to your Claude account.
- The repository has at least one commit.
- A cloud environment, created on claude.ai/code; its id (`env_...`) shows in `/schedule`.
  If the project needs tools installed, give the environment a setup script; it runs in the cloud, not on your machine.

## Install

```
/plugin marketplace add bpsanti/kharos
/plugin install kharos@kharos
```

Then run `/kharos:setup` in the repository you want to launch sessions on.
It writes a profile, checks the repository, and tells you exactly what to fix: see [docs/setup.md](docs/setup.md).

## Commands

| Command | What it does |
|---|---|
| `/kharos:setup [owner/repo]` | Writes a launch profile and checks everything a launch needs |
| `/kharos:doctor [--profile p]` | Checks login, plan, configuration, repository, Claude access, environment, permission rules and limits, with the fix for each gap |
| `/kharos:permissions [default\|standard\|hook] [folder]` | Shows the permission rules a repository gives its cloud sessions, writes narrow allow rules to its `.claude/settings.json`, or installs the opt-in permission hook, each after you approve the diff; never commits or pushes |
| `/kharos:run "<instruction>" [--profile p] [--model m] [--title t] [--deadline min] [--file path]` | Launches one cloud session and records it |
| `/kharos:list [--all] [--refresh]` | Lists followed sessions from the local registry; `--refresh` reads each open session first |
| `/kharos:log <id> [lines]` | Shows the last lines of a session's log |
| `/kharos:send <id> "<text>"` | Sends a message into the session; the reply shows on the next read |
| `/kharos:result <id>` | Shows the end mark, pull request and branch, and how to bring the work here |
| `/kharos:close <id>` | Stops following a session, and shows where to delete its routine |
| `/kharos:watch` | One watcher pass; run it as `/loop 10m /kharos:watch` in a session of its own |

Commands that spend plan usage or change state can only be started by you, not by the model.

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

The one-run guard covers only launches kharos knows.
Calling RemoteTrigger `run` by hand on a routine id read elsewhere (the routine page, /schedule) starts another paid session, and the service has no fire-once flag.
While the registry file cannot be read, every `run`, `list_runs` and `get_run_log` answer is hidden behind one line that names the file, because kharos cannot tell its own launches from others.

The instruction gets a short footer: the session ends with a `KHAROS-DONE {...}` line when it is truly finished, or a `KHAROS-QUESTION {...}` line when it needs an answer, and pushes work in progress every 30 minutes.

## Following sessions

Start the watcher in a separate terminal, with a small model:

```
claude --model haiku
/loop 10m /kharos:watch
```

Each pass reads the sessions that are due, and code (not the model) classifies each one: `running`, `turn_closed`, `silent`, `waiting_answer`, `waiting_permission`, `looping`, `overdue`, `usage_limit`, `invisible`, `finished`, `failed`.
A closed turn is never taken for the end: only the session's own `KHAROS-DONE` mark ends it, and "could not read" is never taken for "finished".
A session waiting at a permission prompt raises a notice that names the tool, with the link to the session, where a person answers it; what the tool would run never leaves the machine.
`kharos health` exits with 1 when sessions are open and the watcher stopped, for launchd, cron or any other check.
See [docs/watcher.md](docs/watcher.md) for the rules, the numbers behind them, and the event format.

## Permission prompts

A cloud session that a routine starts runs in auto mode ([scheduled tasks](https://code.claude.com/docs/en/routines)).
It still stops at a prompt for `ask` rules, both the organization's managed ones and the repository's, and after the classifier blocks 3 actions in a row or 20 in the session ([permission modes](https://code.claude.com/docs/en/permission-modes)).
Cloud sessions have no bypass mode, auto mode drops broad allow rules such as `Bash(*)`, and no allow rule outranks an ask rule.
The routine's `allowed_tools` neither allows nor restricts anything there.
`/kharos:permissions` shows a repository's rules, and adds narrow allow rules for its own commands (the `standard` profile).
The opt-in permission hook (off by default) answers prompts in cloud sessions with your own narrow allow patterns, and denies the rest with a message that names the allowed form, so the session sends the right command instead of waiting.
When the organization has not disabled bypass mode, it can also mirror the organization's ask rules as a cloud-only allow, after you confirm the list; deny rules are never touched.
The watcher logs each of the hook's decisions, and `kharos permissions approvals` lists them.
`/kharos:doctor` warns when a launch branch would likely stall, about managed ask rules that would stop a session, about broad rules or modes that cloud sessions ignore, and while the hook is on: see [docs/permissions.md](docs/permissions.md).

## Outputs

Events go to the outputs of the configuration: desktop notification, a JSON-lines file, Slack (the webhook URL is kept in the keychain as the plugin's `slack_webhook` option), any command, and the firstmate adapter.
By default you get a notification when a session needs you or ends, and every event in `~/.local/state/kharos/events.jsonl`.
See [docs/outputs.md](docs/outputs.md).

## Files

| Path | Content |
|---|---|
| `~/.config/kharos/config.json` | Profiles, watcher thresholds and outputs ([schema](schema/config.schema.json)) |
| `~/.local/state/kharos/sessions.json` | The registry, mode 0600, written atomically under a lock |
| `~/.local/state/kharos/logs/<id>.jsonl` | The events read from each session, deleted 14 days after it is closed |
| `~/.local/state/kharos/approvals.jsonl` | The permission hook's decisions the watcher read: time, session, tool, decision and matched rule, never the command |

`KHAROS_HOME` moves both under one folder, which is how one machine serves several accounts.

## Limits to know

| Limit | Value |
|---|---|
| Runs started by hand, per routine | 30 per hour |
| Runs started by hand, per account | 100 per hour |
| Concurrent cloud sessions | exists; no published number (`watch.max_open` is a local cap, 5 by default) |
| Cloud machine | 4 vCPU, 16 GB, 30 GB of disk |
| Usage | the same plan usage as everything else: five sessions spend five times |

## Development

```
npm ci
npm run check        # typecheck and tests
npm run validate     # claude plugin validate . --strict
```

This project is not affiliated with or endorsed by Anthropic.
It works with Claude Code.

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
| `/kharos:doctor [--profile p]` | Checks login, plan, configuration, repository, Claude access, environment and limits, with the fix for each gap |
| `/kharos:run "<instruction>" [--profile p] [--model m] [--title t] [--deadline min] [--file path]` | Launches one cloud session and records it |
| `/kharos:list [--all]` | Lists followed sessions from the local registry, with no network call |
| `/kharos:log <id> [lines]` | Shows the last lines of a session's log |
| `/kharos:send <id> "<text>"` | Sends a message into the session; the reply shows on the next read |
| `/kharos:result <id>` | Shows the end mark, pull request and branch, and how to bring the work here |
| `/kharos:close <id>` | Stops following a session, and shows where to delete its routine |

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

The instruction gets a short footer: the session ends with a `KHAROS-DONE {...}` line when it is truly finished, or a `KHAROS-QUESTION {...}` line when it needs an answer, and pushes work in progress every 30 minutes.

## Files

| Path | Content |
|---|---|
| `~/.config/kharos/config.json` | Profiles, watcher thresholds and outputs ([schema](schema/config.schema.json)) |
| `~/.local/state/kharos/sessions.json` | The registry, mode 0600, written atomically under a lock |
| `~/.local/state/kharos/logs/<id>.jsonl` | The events read from each session |

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

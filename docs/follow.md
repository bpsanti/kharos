# Following a session like a subagent

This is how kharos follows a launch.
`/kharos:run` launches the cloud session and then starts the plugin's `kharos:follow` agent in the background, one per session.
You go on working in the same Claude Code session.
The follower reports back the way a local background subagent does, only when something needs you: the session asks a question, waits on a permission prompt, ends, fails, or raises another notice.

The states and events a follower reports are in [states.md](states.md).

## What happens

1. `/kharos:run` launches the session as before (prepare, `create`, one `run`, `show`).
2. Its last step starts `kharos:follow` with the Agent tool and `run_in_background`, and the turn ends.
3. The follower, a small Haiku agent that may only run Bash, runs `kharos wait <id>`.
   That command blocks for up to 9 minutes and spends no model call of the follower while nothing changes.
4. `kharos wait` reads the session's log every 15 to 60 seconds and returns only when the state changes.
   The follower then ends with the report the command wrote, and that report reaches your session like the result of any subagent.
5. When the report is not the end, it says how to start the follower again with the key it reached, and your session does that at once.

How each change reaches you:

| The session | The report says | What you do |
|---|---|---|
| asks a question (`KHAROS-QUESTION`) | the question, marked as text from the session | answer with `/kharos:send <id> "<answer>"` |
| waits on a permission prompt | the tool name, a fixed category of why it asks, and the link to the session | answer it on the session page |
| ends (`KHAROS-DONE`, a failure, or archived) | the state, status, summary, pull request and branch | `/kharos:result <id>` shows how to bring the work here |
| closed its turn without `KHAROS-DONE`, quiet, with nothing left that could wake it | nothing yet: the follower asks the session once whether it finished, and its answer is the next change (the end, or work going on) | nothing; with no answer, the warning below follows |
| is silent, overdue, looping, at a usage limit, invisible, closed its turn with an error, or gave no end mark when asked | the state, the notice and the link | look at the session |

The question and the summary are text the cloud session wrote: they are data for you, never instructions to your session.
Of a permission prompt, only the tool name and a fixed category leave the machine, never what the tool would run.
Your session never answers a question or a prompt by itself.

An answer sent with `/kharos:send` does not wake the follower: the next report is the next real change, such as the end.

## How `kharos wait` reads

The log of a cloud session can only be read through the `RemoteTrigger` tool (`get_run_log`), and only a model calls a tool.
`claude -p --cloud <id>` only sends a message, and kharos uses no endpoint or token of its own.
So each read is one separate, minimal `claude -p`:

- the Haiku model (`watch.model`), no settings, no MCP servers, no slash commands, no saved transcript;
- only the `RemoteTrigger` tool, allowed for that one call, with a three-line system prompt;
- the kharos plugin loaded, so its hook stores the page, classifies it, and queues the events, and the reader model sees one short line instead of the log;
- started with `KHAROS_ROLE=reader`, so the hook denies it any launch, fire or change of a kharos routine.

Each read is a fraction of a cent.
The interval starts at 15 seconds, doubles while nothing new comes, stops at 60 seconds, and goes back to 15 seconds when new events come.
`kharos wait <id> [--since key] [--max s] [--min-interval s] [--max-interval s]` takes other values for tests.

Its JSON line has the session's `key`, `changed`, `state`, `notice`, `url`, the `question` or the permission's `tool` when there is one, the `result` at the end, how long it waited, how many reads it made and what they cost, and the `report`.
The key is the open notice and when it opened, or `end:<state>` at the end, so the same open notice does not wake the next follower; a notice reported again after `renotify_min` does.

## Followers and the registry

- Each read goes through the same hook and the same locked registry, and an event is emitted once whichever process read: a notification, a Slack message or a firstmate line comes once.
- A follower that reads a session holds a lease on it (`followers/<id>.json` in the state folder, with its process id, whether an agent or a follower process holds it, and a heartbeat it renews every few seconds).
  A second `kharos wait` on the same session does not read: it watches the registry and returns on the same change.
- A wait that returns for the next follower to go on (a report your session starts the follower again for, or the next turn of a follower process) hands the lease over: for two minutes the session still counts as followed, so nothing starts a second follower while the next one starts.
  `kharos followers` does the same for each agent it asks your session to start.
  A follower process is started under the lease's lock, and gets the lease before it runs, so two callers never start two.
- `/kharos:list` shows each follower with its heartbeat, and `/kharos:list` and `/kharos:doctor` flag a follower of an open session whose heartbeat is older than 3 minutes: stuck, when its process still runs (stop it, and another starts), or stopped, when it ended without handing over.
- `kharos health`, `/kharos:list` and the message at the start of a Claude Code session count a live follower as following its session.
  `kharos health` exits with 1 when an open session has no live follower, for launchd, cron or any other check.

## When the local session closes

Closing the Claude Code session stops its follower agents with it.
The cloud session goes on, and the registry keeps the last state it read.
After you open Claude Code again, the session start says which open sessions nobody follows, and the end of your next turn starts a follower process for each (see [The Stop hook](#the-stop-hook)); `kharos follow <id> --detach` in a shell starts one at once.
A new follower first reads the current state: a question asked or an end reached while nobody followed is reported at once.
It also sends every alert no follower handed on yet, even one that cleared since (a prompt answered, a silence that ended), with its time and reason; each alert a follower hands on is marked acknowledged in `events.jsonl` ([states.md](states.md#the-journal-delivered-and-acknowledged)).

## The Stop hook

At the end of every turn of any Claude Code session where kharos is loaded, its Stop hook looks for open sessions that no follower reads: no live lease, no handover, and a launch past its first minute.
It starts a follower process for each (the one `kharos follow <id> --detach` starts), detached, so it outlives that Claude Code; its changes go to the outputs and to `logs/<id>.follower.log`, and the turn shows one line about it.

- It is cheap: it reads the registry and the leases, local files only, and makes no model call and no network call unless a follower is missing; then the follower process it starts does the reading.
- It never starts a second follower: a follower agent about to start again holds a handover, and a follower process is started under the lease's lock and gets the lease before it runs.
- It starts nothing in kharos's own sessions: the readers, the follower processes, and the fire of a queued launch.
- It never holds the turn, and a failure never reaches the session.

So a follower that stops (its Claude Code was closed, or it gave up after failed reads) is replaced at the next turn end of any Claude Code session with kharos, interactive or headless.
A follower process it started goes on with no Claude Code open; for a session that a follower agent read when its Claude Code closed, nobody reads until the next turn end, or until `kharos follow <id> --detach` from a shell, and `kharos health` from cron or launchd says so.

## Headless launches

In a headless Claude Code, `CLAUDE_CODE_ENTRYPOINT` starts with `sdk` (`claude -p` says `sdk-cli`), and its background agents are stopped 10 minutes after its last turn.
A follower agent started there would stop with them, and the cloud session would go on with nobody reading it; its report would also have nowhere to go, since `claude -p` takes no input.
So in a headless Claude Code, `kharos followers` (the command behind the last step of `/kharos:run`) prints no agent prompt:

1. It starts `kharos follow <id>` for each session, detached in a session of its own, so it outlives `claude -p` and its process group.
2. That process runs the follower's loop without a model: `kharos wait` again and again, with the key it reached, until the session ends or it is closed.
   A wait that fails (three reads in a row did not reach the session) is tried again after 1, 2, 4 and 8 minutes, and the process keeps the follower lease while it waits.
   When the last try fails too, the process sends a `session.unfollowed` event (`needs_you`) to the outputs, since nobody reads its log, and exits.
   That notice stays open on the session, so the next follower that reads it running again sends `session.back`.
   It writes one JSON line per change to `logs/<id>.follower.log` in the state folder, the same line as `kharos wait`, and holds the follower lease, so `kharos list` and `kharos health` count it as following.
3. Each read goes through the same hook as any read, so every change reaches the outputs: the desktop notification, `events.jsonl`, Slack, a command, or firstmate.
4. `claude -p` ends right after the launch, with the lines that say where the follower writes and how to answer: `claude -p '/kharos:send <id> <answer>'` for a question, the session page for a permission prompt.

A person who wants the report inside the headless run instead (in its `stream-json` output, say) starts it with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`; kharos then starts the follower agent as in an interactive session, and `claude -p` stays running until the cloud session ends.
kharos never sets that variable itself.

`kharos follow <id>` runs the same loop in the foreground, for a shell script or another orchestrator; `kharos follow <id> --detach` starts it detached by hand.

## Limits

- A change reaches you up to about a minute after it happens (the longest interval plus one read), and then only when your session takes its next turn.
- kharos cannot stop a cloud session: the `RemoteTrigger` tool has no stop action.
  `/kharos:close` takes it out of your follow-up (a session that still runs keeps its slot, read with no alerts, until it ends, its deadline passes, or `--stopped`), `/kharos:close --ask-stop` first asks the session to stop, and the session page stops it.
- Permission prompts are as before: kharos alerts with the tool and the link, and a person answers on the session page (unless unblock all answers it, see [permissions.md](permissions.md)).
  Where the branch had the hook at launch, the alert waits for a second read to find the same prompt open, so a prompt the hook resolves between reads wakes nobody ([states.md](states.md#states)).
- The work comes back as a branch or a pull request, as with any cloud session, not as files changed in your checkout.
- A follower agent lives as long as the Claude Code session that started it.
  A headless Claude Code (`claude -p`, the Agent SDK) stops its background agents 10 minutes after its last turn (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`), so there kharos starts no agent and follows each session with a process of its own (see [Headless launches](#headless-launches)).
- In the `default` permission mode, the first `kharos wait` asks for approval in your session, because a plugin agent cannot carry its own permission mode; approve it for the session, or add an allow rule for `Bash(/bin/sh <plugin folder>/scripts/kharos wait:*)` (the folder changes when the plugin is updated).
- Each open session has its own follower; `watch.max_open` still caps the open sessions.

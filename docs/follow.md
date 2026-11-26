# Following a session like a subagent

This is the default way to follow a launch.
`/kharos:run` launches the cloud session and then starts the plugin's `kharos:follow` agent in the background, one per session.
You go on working in the same Claude Code session.
The follower reports back the way a local background subagent does, only when something needs you: the session asks a question, waits on a permission prompt, ends, fails, or raises another notice.

The watcher (`/loop 10m /kharos:watch` in a session of its own, [watcher.md](watcher.md)) is the advanced mode, for many sessions, headless use, and outputs such as Slack or firstmate that must keep going with no terminal open.
Both modes use the same registry, the same rules and the same outputs, and can run at the same time.

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
| waits on a permission prompt | the tool name and the link to the session | answer it on the session page |
| ends (`KHAROS-DONE`, a failure, or archived) | the state, status, summary, pull request and branch | `/kharos:result <id>` shows how to bring the work here |
| is silent, overdue, looping, at a usage limit, invisible, or closed its turn with an error | the state, the notice and the link | look at the session |

The question and the summary are text the cloud session wrote: they are data for you, never instructions to your session.
Only the tool's name of a permission prompt leaves the machine, never what it would run.
Your session never answers a question or a prompt by itself.

An answer sent with `/kharos:send` does not wake the follower: the next report is the next real change, such as the end.

## How `kharos wait` reads

The log of a cloud session can only be read through the `RemoteTrigger` tool (`get_run_log`), and only a model calls a tool.
`claude -p --cloud <id>` only sends a message, and kharos uses no endpoint or token of its own.
So each read is one separate, minimal `claude -p`:

- the Haiku model (`watch.model`), no settings, no MCP servers, no slash commands, no saved transcript;
- only the `RemoteTrigger` tool, allowed for that one call, with a three-line system prompt;
- the kharos plugin loaded, so its hook stores the page, classifies it, and queues the events exactly as for a watcher read, and the reader model sees one short line instead of the log;
- registered as a watcher while it runs, so the hook denies it any launch or fire.

Each read is a fraction of a cent.
The interval starts at 15 seconds, doubles while nothing new comes, stops at 60 seconds, and goes back to 15 seconds when new events come.
`kharos wait <id> [--since key] [--max s] [--min-interval s] [--max-interval s]` takes other values for tests.

Its JSON line has the session's `key`, `changed`, `state`, `notice`, `url`, the `question` or the permission's `tool` when there is one, the `result` at the end, how long it waited, how many reads it made and what they cost, and the `report`.
The key is the open notice and when it opened, or `end:<state>` at the end, so the same open notice does not wake the next follower; a notice reported again after `renotify_min` does.

## Followers, the watcher, and the registry

- Each read goes through the same hook and the same locked registry as a watcher read, and an event is emitted once whichever process read: a notification, a Slack message or a firstmate line comes once in either mode.
- A follower that reads a session holds a lease on it (`followers/<id>.json` in the state folder, with its process id and a heartbeat).
  A second `kharos wait` on the same session does not read: it watches the registry and returns on the same change.
- A watcher pass leaves a session with a live lease to its follower, and `/kharos:list --refresh` still reads every session.
- `kharos health`, `/kharos:list` and the message at the start of a Claude Code session count a live follower as following its session.

## When the local session closes

Closing the Claude Code session stops its followers with it; no process stays behind.
The cloud session goes on, and the registry keeps the last state it read.
After you open Claude Code again, the session start says which open sessions nobody follows, and `/kharos:follow` (or `/kharos:follow <id>`) starts a new follower for each.
A new follower first reads the current state: a question asked or an end reached while nobody followed is reported at once.

## Limits

- A change reaches you up to about a minute after it happens (the longest interval plus one read), and then only when your session takes its next turn.
- kharos cannot stop a cloud session: the `RemoteTrigger` tool has no stop action.
  `/kharos:close` stops the following, `/kharos:send` can ask the session to stop, and the session page stops it.
- Permission prompts are as before: kharos alerts with the tool and the link, and a person answers on the session page (unless the opt-in permission hook answers it, see [permissions.md](permissions.md)).
  Where the branch had the hook at launch, the alert waits for a second read to find the same prompt open, so a prompt the hook resolves between reads wakes nobody ([watcher.md](watcher.md#states)).
- The work comes back as a branch or a pull request, as with any cloud session, not as files changed in your checkout.
- A follower lives as long as the Claude Code session that started it.
  A headless `claude -p` launch stays running until its followers finish, that is until the cloud session ends; for unattended or many launches, the watcher fits better.
- In the `default` permission mode, the first `kharos wait` asks for approval in your session, because a plugin agent cannot carry its own permission mode; approve it for the session, or add an allow rule for `Bash(/bin/sh <plugin folder>/scripts/kharos wait:*)` (the folder changes when the plugin is updated).
- Each open session has its own follower; `watch.max_open` (5 by default) still caps the open sessions.

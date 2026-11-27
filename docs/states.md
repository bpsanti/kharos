# Session states and events

kharos follows every open session and turns its log into a state.
The rules are code (`src/classify.ts`), not the judgment of a model: they are reproducible, tested on recorded logs, and cheap.
A follower ([follow.md](follow.md)) makes the reads; the hooks store, classify and answer with one short line, so the log text never reaches a model.

## Reads

- `kharos wait` reads a session's log every 15 to 60 seconds: the interval starts at 15 seconds, doubles while nothing new comes, and goes back to 15 seconds when new events come.
- A read is `get_run_log` for a session, or `list_runs` while the session id is unknown and every sixth read, to see whether the session was archived.
- When more than 200 events happened between two reads, the newest page does not reach the stored events; the hook asks for older pages until one reaches them, at most two.
- Each read is made by a kharos reader, the minimal headless `claude -p` a follower starts for that one read.
  A reader may only read: its hook denies `create`, `run`, `update` and `create_webhook_trigger` on a kharos routine.
  Routines outside kharos pass untouched.
- A machine that sleeps loses no notice for good: the first read after it wakes classifies the current state.

## States

Times come from the log events; `now` is the clock of the machine that reads.
The rules are checked in this order, and the first that matches wins.

| State | Rule | Notice |
|---|---|---|
| `invisible` | two failed reads in a row (HTTP error, the session missing from `list_runs`, an empty log for a session that had events), or the account logged in now is not the one that launched it | yes |
| `failed` | `KHAROS-DONE` with `failed` | yes, terminal |
| `finished` | `KHAROS-DONE` with `ok` after the last message from a person, no tool call after it in the same turn, and no `KHAROS-QUESTION` after it; turns that events woke later (an `init` with no `user`, such as pull request activity or CI) keep the mark once the last event is a `result` again | yes, terminal |
| `waiting_permission` | a `permission prompt` event that is still open: the calls open at that moment do not all have results, and the model has not spoken again since; when the session's branch had the permission hook at launch, seen on two reads | yes, naming the tool |
| `waiting_answer` | `KHAROS-QUESTION` in a closed turn, or `AskUserQuestion` as the last event | yes |
| `usage_limit` | a plan usage limit in the last events of the turn, in text the service writes (an error `result`, an environment or system line), seen on two reads | yes |
| `failed` | an environment error (setup or clone) in the current turn before the first `init` | yes, terminal |
| `turn_closed` | the last event is a `result` with `is_error=true` | `turn_error`, a warning: a message can wake the session again |
| `probably_finished` | the last event is a `result` with no mark, quiet for `unmarked_end_min` (3), and no background task left that could wake it (below); checked before the deadline, since a session that ended is not running past it | yes, terminal, with the last message; raised once, and its notice stays open, so a session that resumes says `session.back` |
| `overdue` | running for longer than the launch's deadline (`--deadline`, or the profile's `deadline_min`), counted from the open of the cloud session; raised once per session and repeated while it stays open, unless a check below it has a notice to raise, which replaces it; once it closes, a session a message reopens past its deadline is read by the checks below it (looping, silent, `quiet_unmarked`) | yes |
| `looping` | `loop_failures` calls in a row failed with the same tool and the same error (numbers, paths and ids removed), seen on two reads | yes |
| `provisioning` | no `init` line yet, when the stored events reach the start of the session | after `provision_min` |
| `silent` | an open turn with no new event for `silence_min` | at `silence_min`, again at `silence_severe_min` |
| `turn_closed` | the last event is a `result` with no mark | `quiet_unmarked`, a warning, after `quiet_end_min` (40) while a background task the session started may still wake it; with none, `probably_finished` above |
| `running` | anything else | no |

A session archived in `list_runs` without an end mark becomes `ended_unmarked`, terminal.

A background task may still wake the session while the log shows it started and not its end:

- It started when a call's result names it: `Command running in background with ID: <id>`, `Command was moved to the background with ID: <id>`, `Monitor started (task <id>, expires in <n>m ...)`, or `Async agent launched ... agentId: <id>`.
  A foreground agent returns its report inside the turn, so it wakes nothing.
- It ended when a `user` event `<task-notification>` names it with a `<status>` (`completed`, `failed`, `killed`), or says that the Monitor expired; a Monitor past the time its start gave has ended too.
- A start whose result names no task cannot be matched with its end, so it counts while its turn lasts.

A session that probably finished:

- holds no `watch.max_open` slot, as an end, and a closing one is closed;
- is read every five minutes, whichever follower reads it, only to see it resume;
- is `running` again at the first new event, with `session.back` (`the session resumed after it seemed finished`), and takes a slot again, even when that puts the open sessions over `watch.max_open` for a while;
- moves to `finished` when it later writes `KHAROS-DONE`;
- is closed at its deadline, on a read after the one that found it, so its end is always reported first.

## Why these numbers

- A command in the foreground can run up to 10 minutes; gaps of almost 10 minutes with no event are normal, so `silence_min` is 15.
- A closed turn is not a sure end, not even one that ended with an error result: a session closed its turn, stayed quiet for over 10 minutes, and woke up by itself when a background command finished.
  A command moved to the background can run up to 30 minutes more, hence `quiet_end_min` of 40 while a task the session started has not ended, and that notice is a warning, never an end.
  Only the tasks that have not ended count: a session that ran a build in the background, was woken by its end, and then closed its last turn has nothing left to wake it.
  On recorded logs of many sessions, every closed turn that later woke by itself still had a task with no notice of its end, and every turn that closed with none was the session's end.
  So a turn with nothing left to wake it is said after `unmarked_end_min`, as a probable end; events (pull request activity, CI) or a person can still wake it, which is why it stays reversible.
- Repeated calls of the same script are normal (waiting for CI, for example); only the same error in a row counts as a loop.
- The end is said by the session itself, with a mark it sends as its own last message: the condensed log cuts each event at about a thousand characters, so a mark at the end of a long message would be lost.
- The marks in the prompt (the footer) do not count: only `assistant` and `result` events after the last `user` event are read.
- `last_event_at` of `list_runs`, `worker_status` and the routine's `last_run` are not used as signs of life or of an end: each was seen to lag or to report the end of a turn as the end of the run.

- A permission request shows in the log as `permission prompt <Tool>: {...}`.
  A message sent while it is open shows as a `user` event but stays queued behind it, so it does not count as an answer; neither does the result of another call made in parallel.
  The `worker_status` of `list_runs` was only seen as `running` or `idle`, never with a value for a pending prompt, so the log event is the only sign kharos reads.
  Why a cloud session prompts at all, and how to change it: [permissions.md](permissions.md).
- A prompt that the opt-in permission hook answers shows the same `permission prompt` line, followed by its refusal, which starts with `Refused by the kharos permission hook`, or by the call's result once the call ends.
  A read can land between the two lines, so when the session's branch had the hook at launch, a prompt counts only when the next read of the newest page still finds that same prompt open; without the hook it counts on the first read.
  The follower reads such a session again on its next read.
  The log has no line for the hook's answer, so an allowed call that is still running at that next read raises the notice too.
  When the session's branch had the hook at launch, kharos puts each such line through the hook's own decision code with the branch's rules, and logs the decision with the rule that matched, never the command ([permissions.md](permissions.md#the-log-of-the-hooks-decisions)).

If the cloud environment raises the Bash timeout, raise `silence_min` with it.

## Events

An event is a one-line JSON object, `kharos.event.v1`:

```json
{"schema":"kharos.event.v1","id":"k-0007:waiting_permission:1795632264","event":"session.waiting_permission",
 "class":"needs_you","session":"k-0007","title":"fix the panel limit","state":"waiting_permission",
 "previous_state":"running","since":"2026-11-25T18:40:00Z","at":"2026-11-25T18:44:10Z",
 "url":"https://claude.ai/code/session_...","repo":"owner/repo","pr":null,"branch":null,
 "reason":"permission request for Bash (an ask rule of the organization) with no answer for 4 min","open_notice":null,
 "permission":{"tool":"Bash","category":"org_ask_rule"}}
```

- `class` is `progress` (`session.opened`, `session.back`, `session.queued`, `session.pr_opened`), `needs_you` (every warning), or `terminal` (`session.finished`, `session.failed`, `session.ended_unmarked`, `session.probably_finished`).
- `session.queued` (`progress`) says a launch made with `--queue` waits for a slot; `session.not_fired` (`needs_you`) says kharos did not fire a queued launch by itself (another account is logged in, a refusal, or fires that did not go through) and the person decides.
- `session.pr_opened` (`progress`) says the session opened a pull request, with its URL in `pr`, as soon as a read shows the result of the call that created it (`gh pr create`, or a GitHub tool that creates one); once per pull request.
- `session.unfollowed` (`needs_you`) comes from a follower process that stops because reads keep failing: nobody reads the session until a follower starts again.
- `reason` is a fixed text written by the classifier; it never copies the log, except the name of the tool a permission prompt is for, with the fixed text of its category.
  Only `session.waiting_answer` carries `question`, only `session.finished` carries `summary`, and only `session.probably_finished` carries `last_message`, the session's last message as the log returns it (at most 2000 characters), all cleaned of control characters and cut.
- Only `session.waiting_permission` carries `permission`: the name of the tool the prompt is for, and a fixed `category` of why it asks ([permissions.md](permissions.md#why-a-prompt-asks)).
  The tool's input (the command, the file, the URL, the query) is never copied into an event; the person reads it on the session's page.
- `url` is the direct link to the session, `https://claude.ai/code/session_<id>`.
- An event is emitted when a notice opens, again every `renotify_min` while it lasts, and `session.back` once when the session returns to normal.
  A permission prompt that a different one replaces is reported again as soon as it counts (at once without the permission hook); the same prompt is not reported again before `renotify_min`.
- Delivery is at least once; `id` lets a receiver drop a repeat.

### The journal: delivered and acknowledged

`events.jsonl` in the state folder is kharos's journal: every event is written there when it is queued, whatever the outputs are, and later lines mark what became of it, `kharos.mark.v1`:

```json
{"schema":"kharos.mark.v1","mark":"delivered","event":"k-0007:waiting_permission:1795632264","session":"k-0007","at":"2026-11-25T18:44:11Z","outputs":["config:0:notification"],"gave_up":[]}
{"schema":"kharos.mark.v1","mark":"acknowledged","event":"k-0007:waiting_permission:1795632264","session":"k-0007","at":"2026-11-25T18:44:12Z","by":"agent"}
```

- `delivered`: every output the event was meant for got it, or was given up on after five tries (`gave_up`).
- `acknowledged`: a follower handed the alert on, to your session in a follower agent's report (`by: "agent"`), or to the log of a follower process (`by: "shell"`).
- An alert is a `needs_you` or `terminal` event, except `session.unfollowed`.
  Until a follower acknowledges it, it stays on the session in the registry (the last 20), so a follower that starts again sends it first, even when the notice has cleared since: a prompt answered or a silence that ended while nobody followed still reaches the person, once, with its time and reason, in the next report.
- A follower process also delivers, when it starts, what a follower that stopped left in the queue.
- A reader of the journal tells lines apart by `schema`; a `file` output on the journal's own path writes nothing more, since the journal has every event already.

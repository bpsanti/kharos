# The watcher

The watcher follows every open session and turns its log into a state.
The rules are code (`src/classify.ts`), not the judgment of a model: they are reproducible, tested on recorded logs, and cheap.
The model of the watcher session only makes the reads that `nuvem due` lists; the hooks store, classify and answer with one short line, so the log text never reaches it.

## Running it

In a separate terminal:

```
claude --model haiku
/loop 10m /nuvem:watch
```

Use a fixed interval: a fixed-interval `/loop` comes back with `claude --resume`, a self-paced one does not.
`/loop` runs only while Claude Code is open and idle and the machine is awake; `/bg` moves it to a background session that goes on without a terminal.
When no session is open, the pass ends the loop by itself.

Each pass:

1. `nuvem due` writes the heartbeat and lists the reads due now (no network).
2. The model makes those `RemoteTrigger` reads: `get_run_log` for a session, `list_runs` while the session id is unknown and every sixth read, to see whether the session was archived.
3. The hooks store the new events in `logs/<id>.jsonl`, classify, and queue events.
4. `nuvem pass-end` answers with one line: what changed, or that nothing did.

The watcher session can only read: its hook denies `create`, `update`, `run` and `create_webhook_trigger`.

## Who watches the watcher

- `nuvem health` exits with code 1 when sessions are open and the heartbeat is older than three intervals; call it from launchd, cron or any check.
- `/nuvem:list` shows the heartbeat.
- Any new Claude Code session says it in one line when sessions are open and the heartbeat is stale.

A machine that sleeps loses no notice for good: the first read after it wakes classifies the current state.

## States

Times come from the log events; `now` is the clock of the machine that reads.
The rules are checked in this order, and the first that matches wins.

| State | Rule | Notice |
|---|---|---|
| `invisible` | two failed reads in a row (HTTP error, the session missing from `list_runs`, an empty log for a session that had events), or the account logged in now is not the one that launched it | yes |
| `failed` | an environment error (setup or clone), a last `result` with `is_error=true`, or `NUVEM-DONE` with `failed` | yes, terminal |
| `finished` | `NUVEM-DONE` with `ok` after the last message from a person, and no work after it | yes, terminal |
| `waiting_permission` | a permission request with no answer or denial after it | yes |
| `waiting_answer` | `NUVEM-QUESTION` in a closed turn, or `AskUserQuestion` as the last event | yes |
| `usage_limit` | a plan usage limit in the last events of the turn, seen on two reads | yes |
| `overdue` | running for longer than the profile's `deadline_min` | yes |
| `looping` | `loop_failures` calls in a row failed with the same tool and the same error (numbers, paths and ids removed), seen on two reads | yes |
| `provisioning` | no `init` line yet, when the stored events reach the start of the session | after `provision_min` |
| `silent` | an open turn with no new event for `silence_min` | at `silence_min`, again at `silence_severe_min` |
| `turn_closed` | the last event is a `result` with no mark | `quiet_unmarked` after `quiet_end_min` |
| `running` | anything else | no |

A session archived in `list_runs` without an end mark becomes `ended_unmarked`, terminal.

## Why these numbers

- A command in the foreground can run up to 10 minutes; gaps of almost 10 minutes with no event are normal, so `silence_min` is 15.
- A closed turn is not an end: a session closed its turn, stayed quiet for over 10 minutes, and woke up by itself when a background command finished.
  A command moved to the background can run up to 30 minutes more, hence `quiet_end_min` of 40, and the notice is a warning, never an end.
- Repeated calls of the same script are normal (waiting for CI, for example); only the same error in a row counts as a loop.
- The end is said by the session itself, with a mark it sends as its own last message: the condensed log cuts each event at about a thousand characters, so a mark at the end of a long message would be lost.
- The marks in the prompt (the footer) do not count: only `assistant` and `result` events after the last `user` event are read.
- `last_event_at` of `list_runs`, `worker_status` and the routine's `last_run` are not used as signs of life or of an end: each was seen to lag or to report the end of a turn as the end of the run.

If the cloud environment raises the Bash timeout, raise `silence_min` with it.

## Reads and usage

- A session is read on every pass during its first 20 minutes and while a notice is open, every second pass up to two hours, and every third pass after that.
  A `/loop` pass can come up to half an interval late, and the cadence allows for that.
- When more than 200 events happened between two reads, the newest page does not reach the stored events; the hook asks for the older page, at most two.
- Run the watcher with a small model.
  Its context grows with each pass; restart the watcher session once a day if it gets large.

## Events

An event is a one-line JSON object, `nuvem.event.v1`:

```json
{"schema":"nuvem.event.v1","id":"n-0007:waiting_permission:1795632264","event":"session.waiting_permission",
 "class":"needs_you","session":"n-0007","title":"fix the panel limit","state":"waiting_permission",
 "previous_state":"running","since":"2026-11-25T18:40:00Z","at":"2026-11-25T18:44:10Z",
 "url":"https://claude.ai/code/session_...","repo":"owner/repo","pr":null,"branch":null,
 "reason":"permission request with no answer for 4 min","open_notice":null}
```

- `class` is `progress` (`session.opened`, `session.back`), `needs_you` (every warning), or `terminal` (`session.finished`, `session.failed`, `session.ended_unmarked`).
- `reason` is a fixed text written by the classifier; it never copies the log.
  Only `session.waiting_answer` carries `question`, and only `session.finished` carries `summary`, both cleaned of control characters and cut.
- An event is emitted when a notice opens, again every `renotify_min` while it lasts, and `session.back` once when the session returns to normal.
- Delivery is at least once; `id` lets a receiver drop a repeat.

# Outputs

Events (see [watcher.md](watcher.md#events)) go to the outputs listed in the configuration, plus the outputs given to one launch.
Each output has an `events` filter: event classes (`progress`, `needs_you`, `terminal`), event names (`session.finished` or `finished`), or `*`.

```json
"outputs": [
  { "type": "notification", "events": ["needs_you", "terminal"] },
  { "type": "file", "path": "{state}/events.jsonl", "events": ["*"] },
  { "type": "slack", "events": ["needs_you", "terminal"] },
  { "type": "command", "argv": ["/usr/local/bin/my-pager", "--quiet"], "timeout_s": 10, "events": ["terminal"] }
]
```

| Type | Fields | What it does |
|---|---|---|
| `notification` | `events` | A desktop notification: `osascript` on macOS, `notify-send` on Linux |
| `file` | `path`, `events` | Appends the event as one JSON line; `{state}` is kharos's state folder, `~` is your home |
| `slack` | `webhook_env`, `events` | Posts the title, state, reason, pull request and link to a Slack incoming webhook |
| `command` | `argv`, `timeout_s`, `events` | Runs the program with no shell, the event as JSON on stdin, and a deadline (10 s by default) |
| `firstmate` | `status_file`, `home`, `mode`, `events` | The firstmate adapter, below |

Any other destination is a `command`: nothing in the plugin needs to change.

## Delivery

- Events go out right away from the hook that saw the change, and again at the end of each watcher pass for what is left.
- Delivery is at least once: the event `id` lets a receiver drop a repeat.
- An output that fails is tried again on the next delivery, five times at most; after that the event is set aside and `/kharos:list` says so.

## Slack

The webhook URL never goes in the configuration file.
By default the `slack` output reads the plugin's `slack_webhook` option, which Claude Code keeps in the system keychain (set it with `/plugin` or `claude plugin configure kharos`).
That option reaches hooks only, so a Slack message goes out from the hook that saw the change; a delivery outside a hook leaves it for the next hook, without counting a failed try.
`webhook_env` can name another environment variable instead.

## The firstmate adapter

The core does not know firstmate.
The adapter writes one line per event to one status file, given at launch and never guessed:

```
/kharos:run "<instruction>" --output firstmate --status-file <home>/state/<task>.status --firstmate-home <home>
```

- The line is `{verb} [key=kharos-<session>] [at=<epoch>]: text`, appended.
- After writing, when `<home>/config/fleet-ledger` exists, it runs `<home>/bin/fm-fleet-ledger.sh appended <home>/config <status_file>`, and ignores a failure.
- It never creates the file: when the file does not exist, or is not `<home>/state/*.status`, the launch is refused.
- It writes nothing else in the home: no backlog, no inbox, no other file.
- A pull request is always written as its full `https://` URL.

| Event | `mode: shared` (default) | `mode: dedicated` |
|---|---|---|
| opened | `working` | `working` |
| waiting_answer | `needs-decision [key=...]` | same |
| waiting_permission, silent, looping, overdue, usage_limit, invisible, quiet_unmarked, provisioning_slow | `blocked [key=...]` | same |
| back | `resolved [key=...]` | same |
| finished | `resolved [key=...]` if a notice was open, otherwise `note`, with the pull request | `done` with the summary, the pull request and the session sheet |
| failed, ended_unmarked | `blocked [key=...]` | `failed` |

- `shared` is for a task that has a local worker owning its status file: the adapter never writes `done` or `failed`, because a cloud session ending is not the task ending.
- `dedicated` is for a status file that exists only for the cloud session.
  Every `done` there needs the session sheet (`FIM faltou=... ;; refiz=... ;; esperei=...`), so a dedicated launch asks the session for it in the `sheet` field of `KHAROS-DONE`; without it the adapter writes `blocked [key=...]: ... finished without the session sheet`.

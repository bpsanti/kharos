# Testing

## Offline

```
npm ci
npm run check        # typecheck and tests, no network
npm run validate     # claude plugin validate . --strict
```

The tests use a fake `claude` binary and a temporary `KHAROS_HOME`, and never reach the network.
They set `KHAROS_RELEASES_API=off`, which turns off every read of kharos's latest release; the tests of the update check point it at a local server instead.
The log fixtures in `test/fixtures/` are recorded test sessions with their ids replaced; any new fixture must be synthetic or anonymized.

## End to end, with real cloud sessions

Each run spends plan usage, so keep the task small and the deadline short.

1. Use a separate state folder, so the test does not touch your own sessions:
   ```
   export KHAROS_HOME=$(mktemp -d)
   ```
2. Load the plugin from the working copy, in a lean headless session:
   ```
   claude -p --plugin-dir . --model haiku --setting-sources "" --strict-mcp-config --allowedTools RemoteTrigger Bash "/kharos:doctor"
   ```
3. Write a profile on a branch made for the test, with `kharos setup --repo <owner/repo> --revision <branch> --environment env_... --permissions as-is` (with no `--from-schedule`, an `env_...` id is taken as it is), and add a `command` output that appends events to a file, to see each delivery.
4. Launch with `/kharos:run`.
   In a headless session the `run` step needs an approval that `--allowedTools` does not give: launch with `--permission-mode auto` (or from an account whose sessions start in auto mode).
   A `run` the auto mode classifier refuses goes back to `launch routine_created`, and `/kharos:run --resume <id>` fires it once.
   A `run` refused at a prompt in any other way leaves the launch at `launch firing`; `/kharos:run --resume <id>` then finds no session in `list_runs` and says to re-arm it, and `/kharos:run --rearm <id>` followed by `/kharos:run --resume <id>` fires it once.
5. Follow it: an interactive `/kharos:run` starts the `kharos:follow` agent in the background, and its reports arrive in the launching session.
   A headless one starts `kharos follow <id>` detached instead and exits; its JSON lines are in `logs/<id>.follower.log` of the state folder.
   `kharos wait <id> --max 60` in a shell shows one wait's JSON line without an agent.
6. Check each step against the session page on claude.ai/code.

What to provoke:

| Case | How |
|---|---|
| Permission request | an `ask` rule in the test branch's `.claude/settings.json` for one exact command, and an instruction that runs it |
| Question | an instruction that asks a question with `KHAROS-QUESTION` before changing anything; answer it with `/kharos:send` |
| Mid-run message | `/kharos:send` while the session works; the reply shows on the next read |
| End | the session's `KHAROS-DONE` mark, with the pull request |
| Follower after an answer | answer a question with `/kharos:send`; the next report must be the next change, not the same question |
| Follower after a restart | close the launching Claude Code session while the cloud session runs, open it again, and end a turn: the Stop hook starts a follower process |

A session left waiting on a permission request cannot be answered from the terminal; open its page, or leave it to idle.
Routines are created disabled; delete them on claude.ai/code when the test is over.

Set `KHAROS_DEBUG_HOOKS=1` to keep every hook input in `hook-inputs.jsonl` of the state folder, when an answer format seems to have changed.
That file holds remote session content: delete it when done.

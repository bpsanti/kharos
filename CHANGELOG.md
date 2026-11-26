# Changelog

## 0.1.0

The first version published to npm.

- `/kharos:setup` writes a launch profile for a repository, and `/kharos:doctor` checks what a launch depends on, with the fix for each gap (`docs/setup.md`).
- `/kharos:run` launches one cloud session through the `RemoteTrigger` tool and records it; a second `run` of the same launch is refused, and a lost answer is recovered by reading.
- Launched sessions are followed with `/kharos:list`, `/kharos:log` and `/kharos:close`; `/kharos:send` sends a message into a running session, and `/kharos:result` shows its end mark, pull request and branch.
- The watcher (`/loop 10m /kharos:watch`) classifies each session from its log and tells apart a closed turn from the end; `kharos health` reports a watcher that stopped (`docs/watcher.md`).
- Events go to desktop notifications, a JSON-lines file, Slack, any command, or firstmate (`docs/outputs.md`).
- `/kharos:permissions` shows the permission rules a repository gives its cloud sessions and writes a profile of narrow allow rules after you approve the diff; a session waiting at a permission prompt raises a notice (`docs/permissions.md`).
- An opt-in permission hook, off by default, answers prompts in cloud sessions with your own allow patterns; broad patterns are accepted only with `--broad` and are marked.
- A logo and brand kit (`assets/brand/`).
- The `kharos` command from `npm install -g kharos`.

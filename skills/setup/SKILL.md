---
description: Set up kharos for a repository - write a launch profile, check the repository and Claude's access to it, and fix what needs the person's word, such as an empty repository.
disable-model-invocation: true
argument-hint: '[owner/repo] [--profile name]'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" setup:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" doctor:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" environments:*), Bash(git remote get-url:*)
---

Set up a kharos launch profile. Request: $ARGUMENTS

1. Pick the repository.
   If the request names one, use it.
   Otherwise run `git remote get-url origin`; if it is a GitHub URL, offer it as the recommended choice with AskUserQuestion, and let the person name another.
   The repository must be on GitHub.
2. Pick the cloud environment.
   If you have the RemoteTrigger tool, run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" environments --session ${CLAUDE_SESSION_ID}`, then call RemoteTrigger with action `list` and no other field, and wait for its answer (never in the same batch of calls); it lists the environment ids your routines use.
   Ask the person which one to use with AskUserQuestion (most recent first, recommended).
   If there is none, or the person wants another, tell them: create or pick an environment on claude.ai/code (with a setup script if the project needs tools installed; it runs in the cloud, so it cannot point at files on this machine), and read its id with /schedule.
   Without an `env_...` id, stop here.
   If you have no RemoteTrigger tool, stop and tell the person to run /kharos:doctor: cloud sessions are not available in this Claude Code.
3. Write the profile:
   `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" setup --profile <name> --repo <owner/repo> --environment <env_id>`
   The name defaults to the repository name in lowercase.
   Add `--default` when the person wants it as the default profile, and `--revision`, `--model` or `--deadline` only if they asked.
   Without `--revision`, the profile uses the repository's default branch.
4. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" doctor --profile <name>` and show its output as it is.
5. If the doctor says the repository has no commit, ask the person with AskUserQuestion whether you may create an initial commit with a README.md in it.
   Only on an explicit yes, run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/kharos" repo-init <owner/repo>`, show its output, and run the doctor again.
   Never write to the repository without that yes.
6. For any other failed line, show its fix and say which step is the person's (installing the Claude GitHub App, connecting GitHub, creating an environment); do not try to work around it.
7. End with the next steps: `/kharos:run "<instruction>"` to launch, and `/loop 10m /kharos:watch` in a separate session (`claude --model haiku`) to follow launches.

---
description: Launch a cloud session of Claude Code with an instruction, on a configured profile, and record it for follow-up.
disable-model-invocation: true
argument-hint: '"<instruction>" [--profile p] [--model m] [--title t] [--deadline min] [--file path] [--output firstmate --status-file f --firstmate-home h] | --resume <id>'
allowed-tools: Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" prepare:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" show:*), Bash(/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" resume:*)
---

Launch one cloud session for this request: $ARGUMENTS

Each launch spends plan usage, so follow these steps exactly and never fire twice.

1. If the request is `--resume <id>`, run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" resume <id>`, make only the RemoteTrigger call it names, then go to step 6.
2. Split the request into options (`--profile`, `--model`, `--title`, `--deadline`, `--file`, and `--output firstmate` with `--status-file`, `--firstmate-home` and `--firstmate-mode`) and the instruction, which is everything else, word for word.
   If the instruction is a batch of independent tasks, or one goal across several repositories, say in one line that Claude Projects fits that better, and go on.
3. Run this, with the options you found and the instruction unchanged between the markers:
   ```
   /bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" prepare --session ${CLAUDE_SESSION_ID} [options] <<'NUVEM_INSTRUCTION'
   <instruction>
   NUVEM_INSTRUCTION
   ```
   With `--file`, pass `--file <path>` and no text between the markers.
   If it prints "not launched", show its output to the person and stop.
4. Call the RemoteTrigger tool with action `create` and body `{"nuvem_launch":"<id>"}`, with the id that prepare printed.
   Do not write the routine body yourself: the plugin puts in the stored one.
   If the answer does not start with `nuvem:`, the plugin hooks are not active: stop, and tell the person to run /nuvem:doctor.
   If the answer says to stop, show it to the person and stop.
5. Call RemoteTrigger with action `run` and the `trigger_id` the answer names, exactly once.
   If that answer asks for `list_runs`, call it once with the same `trigger_id`. Never call `run` again for this launch.
6. Run `/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/nuvem" show <id>` and show its output to the person as it is.

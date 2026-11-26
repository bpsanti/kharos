# Permissions in cloud sessions

A cloud session that stops at a permission prompt waits until a person answers it on the session page.
Nobody sees that prompt unless something says so: the watcher turns it into a `session.waiting_permission` event (see [watcher.md](watcher.md)), and `/kharos:permissions` changes what in the repository causes prompts.
By default kharos never answers a prompt: there is no documented way to answer one outside the session page, and it never uses the login.
The one exception is opt-in: the [permission hook](#the-permission-hook-opt-in), which a person turns on and installs in a repository, answers prompts inside the session with rules the person approved.

## Where the prompts come from

Each line below is from the Claude Code documentation, unless it says it comes from a kharos test.

- A cloud session on one repository reads the repository's `.claude/settings.json`, because the file is part of the clone.
  It does not read `~/.claude/settings.json` or `.claude/settings.local.json`: both stay on the person's machine ([settings](https://code.claude.com/docs/en/settings)).
  kharos profiles have one repository each, so their sessions read that file.
- A cloud session also gets the organization's server-managed settings, fetched from Anthropic's servers when it starts ([cloud environments](https://code.claude.com/docs/en/cloud-environments)).
  Managed permission rules are the highest level: no other level, command line arguments included, can override them ([permissions](https://code.claude.com/docs/en/permissions)).
- A session that a routine starts begins in auto mode, unless auto mode is not available ([scheduled tasks](https://code.claude.com/docs/en/routines)).
  Every kharos launch is a routine run.
- In auto mode, actions that match an allow, ask or deny rule resolve at once; a classifier decides the rest ([permission modes](https://code.claude.com/docs/en/permission-modes)).
  - An `ask` rule always prompts, even in auto mode.
  - A matching `ask` rule prompts even when a more specific `allow` rule also matches the same call ([permissions](https://code.claude.com/docs/en/permissions)): an allow rule never outranks an ask rule.
  - An `ask` or `deny` rule matches when any subcommand of a compound command matches it, and past any variable assignment in front.
  - A `deny` rule always blocks, in every mode.
  - On entering auto mode, broad allow rules that grant arbitrary code execution are dropped: `Bash(*)` (the same rule as `Bash`), rules that start with a wildcard, wildcarded interpreters such as `Bash(python*)`, a wrapper followed only by a wildcard such as `Bash(timeout *)`, package-manager run commands, and `Agent` and `Monitor` rules.
    Narrow rules such as `Bash(npm test)` stay, and resolve before the classifier.
  - After the classifier blocks 3 actions in a row, or 20 in the session, a prompt appears in the run's session and waits until someone answers it; these numbers are not configurable.
  - `autoMode` settings are read only from user settings, managed settings or `--settings`, never from a repository's `.claude/settings.json`; they do not act on `ask` rules, which resolve before the classifier.
- Cloud sessions have no bypass mode: the mode menu offers Accept edits, Plan and Auto, and `bypassPermissions` and `dontAsk` in settings files are ignored.
  `defaultMode: "auto"` does not take effect from a repository's settings either; cloud sessions honor `acceptEdits`, and they pre-approve file edits in any mode.
  On a person's machine a session in `bypassPermissions` mode does not stop at the organization's ask rules, unless the managed settings set `permissions.disableBypassPermissionsMode`; the same work in a cloud session stops at every one of them.
- `permissions.denyInsteadOfPrompting`, which turns a prompt into a denial, is read only from user or managed settings, and a cloud session does not read the user's file.
- A `PreToolUse` hook does not get past an ask rule: the rule still prompts when the hook returned allow.
  A `PermissionRequest` hook runs when Claude Code is about to ask for permission, and allows or denies on behalf of the user; it cannot approve what a deny rule refuses ([hooks](https://code.claude.com/docs/en/hooks)).
  Hooks of the repository run in cloud sessions too, unless the managed settings set `allowManagedHooksOnly`.
- The `allowed_tools` list of a routine neither allows nor restricts anything, in two kharos tests.
  With `allowed_tools: ["Bash", "Read"]`, `Write` ran with no prompt; with `Bash` in the list, a Bash command that an `ask` rule of the repository covered still prompted.

So, for a kharos launch, the prompts that wait for a person come from:

- `ask` rules of the organization's managed settings, which no repository setting outranks;
- `ask` rules in the repository's `.claude/settings.json`;
- repeated classifier blocks;
- tools that always ask, such as `AskUserQuestion`, which the watcher reports as `waiting_answer`;
- every command not allowed by a rule, when auto mode is not available.

In kharos tests, every prompt that stopped a cloud session came from a managed ask rule (the prompt records `reasonCode: "rule:policySettings"`), for local database clients such as `psql`, whatever the command line held.
Narrow repository allow rules did not stop those prompts, and neither did `autoMode` settings.
A repository `PermissionRequest` hook answered them with no person asked: it allowed the exact command it was given in every call, and a denial with a message let the session go on at once.
`/kharos:doctor` lists the managed ask rules from the local copy of the managed settings, and warns about the ones that would stop a profile's sessions.
No setting in the repository can allow everything: broad rules are dropped and no bypass mode exists.
What helps is narrow allow rules for the commands the work needs, against repository ask rules and the classifier, and the opt-in permission hook, against ask rules of any level.

## Why a prompt asks

The run log says that a prompt waits, for which tool and with which input, but not why.
kharos tells why on the machine that reads the log, and only a fixed category goes into the alert, next to the tool name; the input never leaves the machine.

| Category | Text in the alert | How kharos tells it |
|---|---|---|
| `org_ask_rule` | an ask rule of the organization | an ask rule of the local copy of the organization's managed settings covers the call |
| `repo_ask_rule` | an ask rule of the repository | an ask rule of the launch branch's `.claude/settings.json`, as the launch preflight read it within the last day, covers the call |
| `classifier_block` | the auto mode classifier, after it blocked calls in a row | calls right before the prompt came back blocked by the auto mode classifier |
| `claude_code_check` | a check of Claude Code itself that no rule can allow | the call holds text Claude Code cannot check (a substitution or expansion, quotes inside a flag name, an escaped blank, more than one line), or writes a file Claude Code protects (`.git/`, `.claude/settings*.json`, shell start-up files) |
| `unknown` | a reason kharos cannot tell | none of the above, or a line the service cut before the command ended |

They are tried in that order, as Claude Code resolves them: ask rules first, the organization's above the repository's.
A Bash ask rule covers a call when it matches the whole command or one of its simple commands, past the variable assignments in front; a rule of another tool covers every call of that tool.
The category is a reading of what kharos knows on this machine, not a reason Claude Code wrote: a rule added on the branch after the launch, or managed settings this machine has not fetched, show as another category.

Not tested yet:

- Whether allow rules wait for folder trust in a cloud session, as they do on a person's machine.
- Which mode a routine run uses when auto mode is not available.
- Whether a repository's `defaultMode: "acceptEdits"` changes how a routine run starts.

## Permission profiles

`/kharos:permissions [default|standard] [folder]` works on a local checkout of the repository.

1. It shows the rules of `.claude/settings.json`, which profile they match, and what in them would hold a session at a prompt or does nothing in a cloud session.
2. With a profile, it shows the change as a diff.
3. It writes the file only after the person approves that exact diff, and never commits or pushes.

| Change | What it does |
|---|---|
| `default` | Nothing |
| `standard` | Adds narrow allow rules, which auto mode keeps, for the file tools, read-only shell commands, git commands that read, commit and create a branch, and the build, test and dev commands of the repository; keeps every `ask` and `deny` rule |

Rules the person already has stay first, and every other key of the file stays as it is.
`standard` allows no `git push`: the auto mode classifier decides it, unless an `ask` rule asks for it.
It covers no connector (MCP) tools, and it never removes an `ask` rule: a person removes one on purpose, if at all.

`standard` allows:

- `Read`, `Glob`, `Grep`, `Edit`, `Write`;
- `Bash(ls *)`, `Bash(pwd)`, `Bash(cat *)`, `Bash(head *)`, `Bash(tail *)`, `Bash(wc *)`, `Bash(grep *)`, `Bash(rg *)`, `Bash(diff *)`, `Bash(which *)`;
- `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git show *)`, `Bash(git branch *)`, `Bash(git rev-parse *)`, `Bash(git fetch *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git switch -c *)`, `Bash(git checkout -b *)`;
- the build, test and dev commands of what the repository holds at its root:

| Found | Rules |
|---|---|
| `package.json` | `<pm> install` and the lockfile install (`npm ci`, or `<pm> install --frozen-lockfile` for pnpm, yarn or bun, picked by its lockfile), `<pm> test`, and `<pm> run <script>` for each script named build, test, check, lint, typecheck, format, compile, verify, dev, start or serve (with a suffix such as `test:unit`, unless the name says deploy, release, publish, upload or push); these are exact commands, since auto mode drops package-manager run rules with a wildcard |
| `Cargo.toml` | `cargo build`, `test`, `check`, `clippy`, `fmt` |
| `go.mod` | `go build`, `test`, `vet` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `pytest.ini`, `tox.ini` | `pytest *` |
| `Makefile` | `make <target>` for each target with one of the names above |
| `gradlew` | `./gradlew build`, `test`, `check` |
| `pom.xml` | `mvn compile`, `test`, `verify`, `package` |

The `make`, `./gradlew` and `mvn` rules are exact commands too: with a trailing wildcard, another target, task or phase after them (`make build deploy`, `mvn package deploy`) would run with no prompt.

The settings file must be plain JSON; kharos refuses to edit a file it cannot parse.
`write` takes the token that `diff` printed, and refuses when the file changed since, or when the token is for another change.

## The permission hook (opt-in)

The permission hook is off by default.
`kharos permissions hook enable` sets `permission_hook: true` in the configuration, and `kharos permissions hook disable` sets it back.
While it is off, kharos installs nothing and only alerts on prompts, as described above.
While it is on, `/kharos:doctor` warns that it is on.

`/kharos:permissions hook [folder]` works on a local checkout, with the same approve-the-diff flow as the permission profiles.
`kharos permissions hook diff` shows the change, and `kharos permissions hook write --expect <token>` writes exactly that change, with the same flags; kharos never commits or pushes.
The change touches three files:

| File | What it holds |
|---|---|
| `.claude/settings.json` | one `PermissionRequest` entry, matcher `*`, that runs the script only when `CLAUDE_CODE_REMOTE` is `true`; every other key and hook stays |
| `.claude/hooks/kharos-permission.mjs` | the script, a copy of [`cloud/kharos-permission.mjs`](../cloud/kharos-permission.mjs); Node.js only, no dependency |
| `.claude/kharos-permissions.json` | the rules: `allow` patterns, `prefix` rules, `mirror` (mirrored organization ask rules), and `broad: true` when it holds broad rules |

The script decides only in a cloud session, where `CLAUDE_CODE_REMOTE` is `true`; on a person's machine it says nothing and the prompt shows as usual.
In a cloud session it answers each prompt, in this order:

1. A Bash call that is one simple command and matches an allow pattern word for word is allowed.
   An allow from the hook covers the whole call, so a command that is chained, piped, run in the background or redirected, that substitutes a command, expands a variable, has an unquoted wildcard, or sets a variable in front is never allowed, and neither is one over 600 characters.
2. The same for a mirrored organization rule (see below), and then for a prefix rule.
3. Anything else is denied, with a message that tells the session what to do instead.
   When an allow pattern names the program, the message names each allowed form, so the session sends the right command; in kharos tests the next call was the allowed form after every such denial.
   Otherwise it tells the session to go on without the call, or to stop and say what it needs.
   In a kharos test in a cloud session started by a routine, the hook answered each prompt within 0.2 s: the exact form ran, a chained call and a call with a variable in front were denied with the allowed form, and the next call was that form.

An allow pattern is a command whose words must match exactly, where a `*` word stands for exactly one word of any content:

```
kharos permissions hook diff --allow "psql -h 127.0.0.1 -p 5432 -U dev -d * -Atc *" .
```

This allows `psql -h 127.0.0.1 -p 5432 -U dev -d app -Atc 'select 1'` and nothing longer, shorter or chained.
kharos refuses a pattern that a deny rule of the managed settings or of the repository covers, since a hook cannot approve what a deny rule refuses.
A prefix rule, `--allow-prefix 'Bash(<program> <subcommands>:*)'`, allows that program, or that subcommand of it, with any arguments, still as one simple command: `Bash(psql:*)` allows `psql -h 127.0.0.1 -c 'select 1'`, and `Bash(git push:*)` allows any `git push`, also with the program's known global options in front (`git --no-pager push`).
Its words are literal (no wildcard), and kharos refuses it when its program runs other commands (unless `--broad`) or when a deny rule covers it.
`--drop <pattern or prefix rule>` removes one, and `--uninstall` removes the three files' kharos parts.

A broad pattern is one whose program is a wildcard (`* foo`), or a shell, an interpreter or a wrapper (`bash *`, `python3 *`, `env *`, `sudo *`, `xargs *` and the like).
kharos refuses it unless the change has `--broad`, since it allows any command in this repository's cloud sessions with no person asked: auto mode drops such rules from settings, but a hook's allow counts whatever pattern produced it.
With `--broad` the diff warns about each broad rule it adds, the rules file says `"broad": true`, and `kharos permissions hook show`, `/kharos:doctor` and `kharos permissions approvals` mark each broad rule and each approval it gave.

### Mirroring the organization's ask rules

Members of an organization that has not disabled bypass mode can run past its ask rules on their own machines; in a cloud session the same rules stop the work.
`--mirror` turns the organization's ask rules into a cloud-only allow:

- kharos reads only `permissions.ask`, `permissions.deny`, `disableBypassPermissionsMode` and `allowManagedHooksOnly` from the local copy of the managed settings, `~/.claude/remote-settings.json` (under `CLAUDE_CONFIG_DIR` when that is set), which Claude Code writes when it fetches them; it never writes that file.
- With no copy, or one it cannot read, mirroring is unavailable and kharos says so: it never guesses the rules.
- When the managed settings set `disableBypassPermissionsMode`, kharos refuses: the organization's ask rules then bind every session, on a person's machine too.
- When the organization sets `disableBypassPermissionsMode` after rules were mirrored, kharos refuses every change to the hook but `--unmirror` and `--uninstall`, and `/kharos:doctor` and `kharos permissions hook show` warn until the mirrored rules are gone.
- Otherwise the diff lists every ask rule it converts and every one it keeps as a prompt, with why: rules for other tools than Bash always stay prompts, and so do broad rules (a rule for every command, a rule whose program is a wildcard such as `Bash(*.db.example.com*)`, and rules for a shell, an interpreter or a wrapper) unless the change has `--broad`.
- The diff carries a warning to check with the organization's administrator first, and the write needs `--org-confirmed` besides the token.
- kharos remembers that confirmation in `org-confirmations.json` of its state folder, with a fingerprint of the managed settings' ask rules, deny rules and `disableBypassPermissionsMode`.
  While they still match, a later `--mirror` (in a checkout or by automatic preflight) needs no `--org-confirmed`, and the diff says so.
  When they change, the diff lists what changed (ask or deny rules added or removed, bypass mode) and asks again.
  A confirmation of narrow rules does not cover `--broad`: mirroring broad rules is confirmed on its own.
- Deny rules are never copied, converted or changed.
- A mirrored rule allows only a single simple command, like an allow pattern, and never one whose program is a shell, an interpreter or a wrapper, unless the rule itself is broad and was mirrored with `--broad`.
- With `--broad`, a bare `Bash` ask rule of the organization becomes an allow for every command in this repository's cloud sessions, still one single simple command per call.
- `--mirror` again refreshes the list from the current copy (without `--broad`, broad rules go back to prompts), and `--unmirror` removes it.

### The log of the hook's decisions

The hook runs in the cloud session, where kharos keeps no state, so the watcher writes the log on this machine.
At launch, while `permission_hook` is on, kharos reads the hook's rules from the branch the session starts on.
Each `permission prompt` line the watcher reads then goes through the same decision code the hook runs, and the decision goes to `~/.local/state/kharos/approvals.jsonl`: the time of the prompt, the kharos and cloud session ids, the tool, allow or deny, and the allow pattern or mirrored rule that matched, marked when it is broad.
Never the command, nor any other input or output of the call.
`kharos permissions approvals` lists the approvals; `--all` adds the denials, `--session k-0001` keeps one session.
Sessions kharos does not follow (started on claude.ai, for example) are not in that log.
The hook also returns a `systemMessage` with each approval, which Claude Code documents as shown to the user; in a kharos test it did not appear in the condensed run log, so the watcher does not rely on it.

Limits:

- A managed setting `allowManagedHooksOnly` blocks repository hooks; then only a change of the managed settings helps.
  When the local copy of the managed settings sets it, `/kharos:doctor` and `kharos permissions hook show` warn, and a launch stores no rules, so the watcher logs no decision the hook never made.
- The hook allows what an organization chose to have a person approve; agree on it with whoever owns those rules.

## Permission preflight

`kharos permissions preflight [folder]` reads a local checkout, and `kharos permissions preflight --launch [--profile p]` reads the branch a launch profile starts on, through your own `gh`.
`/kharos:run` runs the second one before each launch, with the instruction (`--stdin` or `--file`), and shows its output.
It lists the prompts the session is likely to hit, each as `likely prompt -> suggested narrow rule -> why`, then the exact command that adds them, from three sources:

| Source | What counts |
|---|---|
| Ask rules | The ask rules of the organization's managed settings (the local copy the doctor reads) and of the repository's `.claude/settings.json`: each prompts in every cloud session |
| The repository | Commands it runs that such an ask rule covers: `package.json` scripts, Makefile recipes, shell scripts (at the root, `scripts/`, `bin/`, up to two folders deep), the `docker compose` commands of a compose file, and shell blocks of `README.md`, `CONTRIBUTING.md` and `docs/` |
| Earlier sessions | The Bash permission prompts in the stored logs of earlier sessions on the same repository (kharos keeps a log for 14 days after the session is closed), each as a prefix rule |

A command of the repository becomes an allow pattern word by word, since its words are in the repository already: the program stays as written, a variable assignment in front goes, and each argument that expands a variable, needed quoting (free text such as a query) or is not a plain word becomes `*`.
Commands with the same program, first argument and length merge into one pattern, where the words that differ become `*`.
A prompt of an earlier session never gives a rule its values: it is reduced to its program and the words that name its action, and suggested as a prefix rule, `Bash(<program> <subcommands>:*)`, so no password, token, host or path it was run with reaches a rule, a side branch or a log.
The subcommand words are the lowercase words after the program (letters, digits and `-`): one for `git`, `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `go`, `make`, `terraform`, `helm`, `brew`, `pip`, `poetry`, `uv`, `docker` and `podman` (`Bash(git push:*)`, `Bash(docker ps:*)`), two for `kubectl`, `gh`, `aws` and `gcloud` (`Bash(kubectl get pods:*)`, `Bash(gh pr view:*)`), and one more after `docker compose` or `podman compose` (`Bash(docker compose exec:*)`); any other program keeps only its name (`Bash(psql:*)`, `Bash(redis-cli:*)`).
The program's known global options before the subcommand are skipped with their values (`git --no-pager log` and `git -C dir log` give `Bash(git log:*)`, `npm --prefix web test` gives `Bash(npm test:*)`, `docker compose -f x.yml exec db psql` gives `Bash(docker compose exec:*)`), also when written `--option=value`; any other option in front stops the match.
The hook skips the same options when it matches a prefix rule, with the same parser, so `Bash(git log:*)` allows `git --no-pager log` too.
Options that set what the program runs are not skipped: `git -c` (a pager or an alias), `git --exec-path`, `git --config-env`, `npm --script-shell` and `npm --node-options` stop the match, so `git -c core.pager=less log` gives the bare `Bash(git:*)` for review.
Some skipped options do load configuration that can run commands: `git -C`, `--git-dir` and `--work-tree` read that repository's config (its pager or fsmonitor), `kubectl --kubeconfig` can run the credential plugin of that file, and `docker -H` or `--config` can run ssh or load another config.
A prefix rule allows those forms too; that is the accepted trade-off of prefix rules.
A suggested rule must allow, by the hook's own decision, each command it was learned from; one that does not is listed for review instead.
When an option kharos does not know comes first, or no subcommand follows, the subcommand cannot be told apart from the options: the bare program (`Bash(git:*)`) is listed under `review before adding`, left out of the command that adds the suggestions, and never applied by automatic preflight.
A prefix rule allows any arguments of that program or subcommand, a width chosen on purpose so a session is not stopped by the next form of the same command.
Earlier prompts with the same prefix give one rule, and a repository pattern that a suggested prefix rule allows anyway is listed as covered by it.
Merged and prefix rules can widen what is allowed: earlier prompts `git push origin feature-x` and `git push origin main` give `Bash(git push:*)`, which allows any push, such as to another branch or with `--force`, and repository commands `psql -d app -c x` and `psql -d shop -c x` merge into `psql -d * -c *`.
Read such a rule before you add it; automatic preflight applies it as it is.
A rule for every command (such as a bare `Bash` ask rule) does not make every line of every script a likely prompt: only earlier prompts count for it.
Each pattern goes through the same filter as `kharos permissions hook diff`: a broad pattern (a shell, an interpreter, a wrapper) or one a deny rule covers is listed as not suggested, with why, and a pattern the hook on the branch allows already is listed as answered.
An ask rule that nothing found runs is listed with no rule to suggest, and the form to add if the task needs it.
A program the instruction names comes first.
Other tools that prompted in earlier sessions are listed too; the hook answers only Bash calls.

### Automatic preflight (opt-in)

`kharos permissions auto preflight on` sets `preflight_auto: true`; it needs `permission_hook` on, and `kharos permissions auto preflight off` sets it back.
While it is off, the preflight only suggests.
While it is on, each launch does this before the routine is created:

1. It runs the preflight on the branch the profile launches from.
2. It plans the change to the hook with the suggested allow patterns and prefix rules, through the same plan as `kharos permissions hook diff`: never a broad rule, never one a deny rule covers; a merged rule and a prefix rule are applied as they are.
   It mirrors the organization's ask rules only with a remembered confirmation that still matches the managed settings, and never broad ones.
3. It writes that change as one commit on top of the launch branch, to a new branch `kharos/<id>` (`<id>` is the kharos session id), through the GitHub Git data API with your `gh`; no checkout is touched, and an existing branch is never overwritten.
4. The routine starts the session on `kharos/<id>`, and the instruction tells the session that the branch is the launch branch plus one hook commit, to work on a branch of its own, and to take that commit out (`git rebase --onto FETCH_HEAD <commit>` after `git fetch origin <base>`) before it opens a pull request against the launch branch.

When it finds nothing to apply, cannot read the branch, or cannot create the side branch, the session starts on the launch branch as usual, and the launch says why.
`kharos show <id>` lists what was applied, and `~/.local/state/kharos/preflight.jsonl` logs it for each launch.
`/kharos:close` deletes the side branch, only while its tip is still the commit kharos made; a side branch with other commits is kept, with the command to delete it.
`/kharos:doctor` shows whether automatic preflight is on.

## The unblock preset (opt-in)

The unblock preset makes the hook allow every permission prompt it receives in cloud sessions, of any tool, instead of denying the ones no rule allows, so no session waits on a person.
It also mirrors every Bash ask rule of the organization, broad ones included (as `--broad` does), so the log names the rule that matched where one did.
It is off by default, and these limits stay:

- kharos refuses it entirely when the organization's managed settings set `disableBypassPermissionsMode`, and when there is no readable copy of them; when bypass mode is disabled later, every change to the hook but `--no-unblock --unmirror` and `--uninstall` is refused.
- The organization's deny rules are never touched; Claude Code enforces them before any prompt.
- The hook still decides only in cloud sessions (`CLAUDE_CODE_REMOTE=true`).
- Every allow goes to the decision log with its tool and the rule that matched, or `unblock` when none did.

`kharos permissions unblock show` lists what it opens under the current managed settings, remote databases included (Amazon RDS, ElastiCache, DocumentDB, MongoDB Atlas connection strings, and the organization's ask rules for such hosts), and the fingerprint of those settings.
The person confirms it once with `kharos permissions unblock confirm --fingerprint <fp>`; the confirmation holds while the fingerprint matches, and is asked again, with what changed, when it does not.
Then `kharos permissions unblock <folder>` (the same as `kharos permissions hook diff --unblock <folder>`) shows the change, and `kharos permissions hook write --expect <token> --unblock <folder>` writes it; `--no-unblock` turns it off again.
`kharos permissions auto unblock on` turns on automatic preflight with the preset (`permission_unblock` and `preflight_auto`): each launch's side branch gets it, while the confirmation matches.

## What the doctor says

For each launch profile, `/kharos:doctor` reads `.claude/settings.json` on the branch the profile launches from, with the person's own `gh`, and reports which permission profile it is on: `standard`, `default` (no rules at all) or `custom`.
It warns when a launch would likely stall, or relies on something cloud sessions ignore:

- `ask` rules, which always prompt;
- broad allow rules, which auto mode drops;
- no narrow allow rule for Bash;
- `defaultMode` set to `bypassPermissions` or `dontAsk`.

It notes `defaultMode: "auto"` and `autoMode` settings, which a repository's settings cannot set.
When `gh` cannot read the file, the check is information only.

It also reads the local copy of the organization's managed settings, and warns, per profile, about the ask rules that would stop its cloud sessions (the ones the branch's hook does not mirror).
It warns while `permission_hook` or `permission_unblock` is on, says whether automatic preflight is on, marks a branch whose hook has the unblock preset, reports the hook on each branch (its rules, and whether the script and the rules file are usable), and warns when a branch has the hook while `permission_hook` is off.

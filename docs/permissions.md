# Permissions in cloud sessions

A cloud session that stops at a permission prompt waits until a person answers it on the session page.
Nobody sees that prompt unless something says so: kharos turns it into a `session.waiting_permission` event (see [states.md](states.md)).
By default kharos never answers a prompt: there is no documented way to answer one outside the session page, and it never uses the login.
The one exception is opt-in: [unblock all](#unblock-all), which a person turns on for a Claude account with one confirmation, answers prompts inside the session with the [permission hook](#the-permission-hook) on a side branch of each launch.
kharos never changes a repository's own `.claude/settings.json` or any branch the person works on.

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
- tools that always ask, such as `AskUserQuestion`, which kharos reports as `waiting_answer`;
- every command not allowed by a rule, when auto mode is not available.

In kharos tests, every prompt that stopped a cloud session came from a managed ask rule (the prompt records `reasonCode: "rule:policySettings"`), for local database clients such as `psql`, whatever the command line held.
Narrow repository allow rules did not stop those prompts, and neither did `autoMode` settings.
A repository `PermissionRequest` hook answered them with no person asked: it allowed the exact command it was given in every call, and a denial with a message let the session go on at once.
`/kharos:doctor` lists the managed ask rules from the local copy of the managed settings, and warns about the ones that would stop a profile's sessions.
No setting in the repository can allow everything: broad rules are dropped and no bypass mode exists.
What helps is narrow allow rules for the commands the work needs, which the repository's maintainers add to its `.claude/settings.json`, against repository ask rules and the classifier, and unblock all, against ask rules of any level.

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

## Unblock all

`/kharos:permissions` (in a shell, `kharos permissions unblock-all show`) frees every prompt kharos can free for this Claude account, in one step.
It lists, once, everything it frees and where each part stands, with one token for that exact change, and changes nothing until the person confirms all of it.
`kharos permissions unblock-all on --expect <token>` then turns the parts on, in this order:

1. The [unblock preset](#the-unblock-preset), confirmed for the organization's managed settings as they are now (their fingerprint).
2. Automatic unblock: `permission_hook`, `preflight_auto` and `permission_unblock` in this account's kharos configuration, so the side branch of each launch gets the preset, with the narrow rules the [preflight](#permission-preflight) suggests.
3. This account's sessions start in auto mode: `permissions.defaultMode: "auto"` in its own user settings, so launches need no approval prompt (see [Launch approval](setup.md#launch-approval)); every session of the account starts in auto mode then, not only launches.

Each part keeps its own guards: parts 1 and 2 are left out when the organization disables bypass mode, when no copy of its managed settings can be read (unless you state that the account has none, see [below](#no-copy-of-the-organizations-settings)), or when it allows managed hooks only, and part 3 when it turns auto mode off; the list says which part is left out and why, and the rest is still turned on.
A part that is on already is skipped, so running it again only finishes what is missing.
The parts are not offered one at a time: the one confirmation covers all of them.
The token holds only while the managed settings, the kharos configuration and the account's settings are what the list was made from; otherwise nothing changes and the list is shown again.
When a part fails, the parts after it are not touched, and the error says which parts are on.
`/kharos:permissions off` (`kharos permissions unblock-all show off`, then `off --expect <token>`) takes back what `on` turned on: it forgets the confirmation, puts `permission_hook`, `preflight_auto` and `permission_unblock` back as they were before, and sets the account's mode back to what it had.
A part that was on before `on`, such as an account already in auto mode, is left as it is.
`/kharos:permissions state` shows where it stands, and `/kharos:doctor` shows one `unblock all` line: on, partly on with what is missing, or off.
`/kharos:setup` offers it as the `unblock-all` permission mode, with the same list and token.

### No copy of the organization's settings

Claude Code keeps a copy of the organization's managed settings in `remote-settings.json` in the account's Claude config folder, and writes none when the organization has no managed settings for the account.
With no copy, kharos cannot tell an account that has none from one whose settings Claude Code has not downloaded on this machine yet, and kharos never fetches them itself (that would need the claude.ai login).
So parts 1 and 2 are not available, and `show` says why and the one check to make: open an interactive Claude Code session with this account, which downloads the settings when there are any, then show the list again.
If there is still no copy, `show` also offers a second token, for the same change with the statement "this account has no organization settings" (`kharos permissions unblock-all on --no-org-settings --expect <token>`; in setup, `--no-org-settings` with the `unblock-all` mode).
With it, kharos reads the organization's settings as empty (0 ask rules, 0 deny rules), with a fingerprint of the absent copy, so all three parts are available.
If a copy appears later, even an empty one, the fingerprint changes: kharos stops applying the preset and asks for the confirmation again, as for any change of the managed settings, and the statement ends as soon as kharos reads a copy, readable or not.
If that copy is removed later, the statement does not come back: the preset stays off until you confirm again, with or without the statement.
`unblock-all off` forgets the statement with the confirmation, and `/kharos:doctor` shows in its `managed policy` line whether there is a copy, no copy, or none by your statement.
Make the statement only when you know it is true: kharos cannot check it, and if the account does have organization settings, their rules are not known here.

## The permission hook

The permission hook is a documented `PermissionRequest` hook that runs inside the cloud session, from the files of the branch it starts on.
kharos never installs it on a branch the person works on: automatic preflight, part of unblock all, writes it to the side branch of each launch (see [below](#automatic-preflight)).
A branch that has it from an earlier kharos keeps it until its maintainers change or remove its files, and `/kharos:doctor` reports it.
The hook touches three files:

| File | What it holds |
|---|---|
| `.claude/settings.json` | one `PermissionRequest` entry, matcher `*`, that runs the script only when `CLAUDE_CODE_REMOTE` is `true`; every other key and hook stays |
| `.claude/hooks/kharos-permission.mjs` | the script, a copy of [`cloud/kharos-permission.mjs`](../cloud/kharos-permission.mjs); Node.js only, no dependency |
| `.claude/kharos-permissions.json` | the rules: `allow` patterns, `prefix` rules, `mirror` (mirrored organization ask rules), `unblock` for the preset, and `broad: true` when it holds broad rules |

The script decides only in a cloud session, where `CLAUDE_CODE_REMOTE` is `true`; on a person's machine it says nothing and the prompt shows as usual.
In a cloud session it answers each prompt, in this order:

1. A Bash call that is one simple command and matches an allow pattern word for word is allowed.
   An allow from the hook covers the whole call, so a command that is chained, piped, run in the background or redirected, that substitutes a command, expands a variable, has an unquoted wildcard, or sets a variable in front is never allowed, and neither is one over 600 characters.
2. The same for a mirrored organization rule, and then for a prefix rule.
3. With the unblock preset, anything else is allowed too.
4. Without it, anything else is denied, with a message that tells the session what to do instead.
   When an allow pattern names the program, the message names each allowed form, so the session sends the right command; in kharos tests the next call was the allowed form after every such denial.
   Otherwise it tells the session to go on without the call, or to stop and say what it needs.
   In a kharos test in a cloud session started by a routine, the hook answered each prompt within 0.2 s: the exact form ran, a chained call and a call with a variable in front were denied with the allowed form, and the next call was that form.

An allow pattern is a command whose words must match exactly, where a `*` word stands for exactly one word of any content: `psql -h 127.0.0.1 -p 5432 -U dev -d * -Atc *` allows `psql -h 127.0.0.1 -p 5432 -U dev -d app -Atc 'select 1'` and nothing longer, shorter or chained.
A prefix rule, `Bash(<program> <subcommands>:*)`, allows that program, or that subcommand of it, with any arguments, still as one simple command: `Bash(psql:*)` allows `psql -h 127.0.0.1 -c 'select 1'`, and `Bash(git push:*)` allows any `git push`, also with the program's known global options in front (`git --no-pager push`).
Its words are literal (no wildcard).
kharos never writes a pattern or prefix rule that a deny rule of the managed settings or of the repository covers, since a hook cannot approve what a deny rule refuses.

A broad pattern is one whose program is a wildcard (`* foo`), or a shell, an interpreter or a wrapper (`bash *`, `python3 *`, `env *`, `sudo *`, `xargs *` and the like).
Automatic preflight never writes one: it would allow any command in the repository's cloud sessions with no person asked, since auto mode drops such rules from settings, but a hook's allow counts whatever pattern produced it.
Only the unblock preset allows that much, and it says so before the person confirms it.

kharos reads only `permissions.ask`, `permissions.deny`, `disableBypassPermissionsMode` and `allowManagedHooksOnly` from the local copy of the organization's managed settings, `~/.claude/remote-settings.json` (under `CLAUDE_CONFIG_DIR` when that is set), which Claude Code writes when it fetches them; it never writes that file.
With no copy, or one it cannot read, the unblock preset is unavailable and kharos says so: it never guesses the rules.
Claude Code writes no copy for an account whose organization has no managed settings, so only the person can say that an absent copy means none: see [No copy of the organization's settings](#no-copy-of-the-organizations-settings).
When the organization sets `disableBypassPermissionsMode` after a hook with mirrored rules or the preset reached a branch, `/kharos:doctor` warns until they are gone, and automatic preflight refuses to build on that branch.
Deny rules are never copied, converted or changed.

## The unblock preset

The unblock preset makes the hook allow every permission prompt it receives in cloud sessions, of any tool, instead of denying the ones no rule allows, so no session waits on a person.
It also mirrors every Bash ask rule of the organization, broad ones included, so the log names the rule that matched where one did.
It is off by default, and these limits stay:

- kharos refuses it entirely when the organization's managed settings set `disableBypassPermissionsMode`, and when there is no readable copy of them; when bypass mode is disabled later, a launch no longer applies it.
- The organization's deny rules are never touched; Claude Code enforces them before any prompt.
- The hook still decides only in cloud sessions (`CLAUDE_CODE_REMOTE=true`).
- Every allow goes to the decision log with its tool and the rule that matched, or `unblock` when none did.

[Unblock all](#unblock-all) lists what it opens under the current managed settings, remote databases included (Amazon RDS, ElastiCache, DocumentDB, MongoDB Atlas connection strings, and the organization's ask rules for such hosts), and confirms it with the rest of what it frees.
The confirmation is kept in `org-confirmations.json` of the state folder with a fingerprint of the managed settings' ask rules, deny rules and `disableBypassPermissionsMode`; it holds while the fingerprint matches, and is asked again, with what changed, when it does not.
With automatic unblock (part 2 of unblock all), each launch's side branch gets the preset while the confirmation matches; when it does not, the launch says why, and the session starts with the narrow rules alone.

## The log of the hook's decisions

The hook runs in the cloud session, where kharos keeps no state, so kharos writes the log on this machine as it reads the session.
At launch, while `permission_hook` is on, kharos reads the hook's rules from the branch the session starts on.
Each `permission prompt` line kharos reads then goes through the same decision code the hook runs (for a line that carries the reason of the prompt instead of the command, with the command of the call it belongs to), and the decision goes to `~/.local/state/kharos/approvals.jsonl`: the time of the prompt, the kharos and cloud session ids, the tool, allow or deny, and the allow pattern or mirrored rule that matched, marked when it is broad.
Never the command, nor any other input or output of the call.
`kharos permissions approvals` lists the approvals; `--all` adds the denials, `--session k-0001` keeps one session.
Sessions kharos does not follow (started on claude.ai, for example) are not in that log.
The hook also returns a `systemMessage` with each approval, which Claude Code documents as shown to the user; in a kharos test it did not appear in the condensed run log, so kharos does not rely on it.

Limits:

- A managed setting `allowManagedHooksOnly` blocks repository hooks; then only a change of the managed settings helps.
  When the local copy of the managed settings sets it, `/kharos:doctor` warns, and a launch stores no rules, so kharos logs no decision the hook never made.
- The hook allows what an organization chose to have a person approve; agree on it with whoever owns those rules.

## Permission preflight

`kharos permissions preflight [--profile p] [--revision r] (--stdin | --file f)` reads the branch a launch starts on, through your own `gh`, and changes nothing.
`/kharos:run` runs it before each launch, with the instruction, and shows its output.
It lists the prompts the session is likely to hit, each as `likely prompt -> suggested narrow rule -> why`, then what answers them at launch: automatic preflight when unblock all is on, otherwise a pointer to `/kharos:permissions`.
It reads three sources:

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
When an option kharos does not know comes first, or no subcommand follows, the subcommand cannot be told apart from the options: the bare program (`Bash(git:*)`) is listed under `review before adding`, and never applied by automatic preflight.
A prefix rule allows any arguments of that program or subcommand, a width chosen on purpose so a session is not stopped by the next form of the same command.
Earlier prompts with the same prefix give one rule, and a repository pattern that a suggested prefix rule allows anyway is listed as covered by it.
Merged and prefix rules can widen what is allowed: earlier prompts `git push origin feature-x` and `git push origin main` give `Bash(git push:*)`, which allows any push, such as to another branch or with `--force`, and repository commands `psql -d app -c x` and `psql -d shop -c x` merge into `psql -d * -c *`.
Automatic preflight applies such a rule as it is.
A rule for every command (such as a bare `Bash` ask rule) does not make every line of every script a likely prompt: only earlier prompts count for it.
Each pattern goes through the hook's own filter: a broad pattern (a shell, an interpreter, a wrapper) or one a deny rule covers is listed as not suggested, with why, and a pattern the hook on the branch allows already is listed as answered.
An ask rule that nothing found runs is listed with no rule to suggest, and the form a narrow rule would take if the task needs it.
A program the instruction names comes first.
Other tools that prompted in earlier sessions are listed too; the hook answers only Bash calls.

### Automatic preflight

Automatic preflight is part 2 of [unblock all](#unblock-all) (`preflight_auto: true`, with `permission_hook` on).
While it is off, the preflight only suggests.
While it is on, each launch does this before the routine is created:

1. It runs the preflight on the branch the profile launches from.
2. It plans the change to the hook with the suggested allow patterns and prefix rules: never a broad rule, never one a deny rule covers; a merged rule and a prefix rule are applied as they are.
   With `permission_unblock` on and the confirmation of the unblock preset still matching the managed settings, it adds the preset, which mirrors the organization's Bash ask rules.
3. It writes that change as one commit on top of the launch branch, to a new branch `kharos/<id>` (`<id>` is the kharos session id), through the GitHub Git data API with your `gh`; no checkout is touched, and an existing branch is never overwritten.
4. The routine starts the session on `kharos/<id>`, and the instruction tells the session that the branch is the launch branch plus one hook commit, to work on a branch of its own, and to take that commit out (`git rebase --onto FETCH_HEAD <commit>` after `git fetch origin <base>`) before it opens a pull request against the launch branch.

When it finds nothing to apply, cannot read the branch, or cannot create the side branch, the session starts on the launch branch as usual, and the launch says why.
`kharos show <id>` lists what was applied, and `~/.local/state/kharos/preflight.jsonl` logs it for each launch.
`/kharos:close` deletes the side branch, only while its tip is still the commit kharos made; a side branch with other commits is kept, with the command to delete it.
`/kharos:doctor` shows whether automatic preflight is on.

## What the doctor says

For each launch profile, `/kharos:doctor` reads `.claude/settings.json` on the branch the profile launches from, with the person's own `gh`, and reports how many allow, ask and deny rules it has.
It warns when a launch would likely stall, or relies on something cloud sessions ignore:

- `ask` rules, which always prompt;
- broad allow rules, which auto mode drops;
- no narrow allow rule for Bash;
- `defaultMode` set to `bypassPermissions` or `dontAsk`.

It notes `defaultMode: "auto"` and `autoMode` settings, which a repository's settings cannot set.
When `gh` cannot read the file, the check is information only.

It also reads the local copy of the organization's managed settings, and warns, per profile, about the ask rules that would stop its cloud sessions (the ones the branch's hook does not mirror).
It warns while `permission_hook` is on, shows one `unblock all` line (on, partly on with what is missing, or off), says whether automatic preflight is on, marks a branch whose hook has the unblock preset, reports the hook on each branch (its rules, and whether the script and the rules file are usable), and warns when a branch has the hook while `permission_hook` is off.

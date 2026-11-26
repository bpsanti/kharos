# Setting up a repository

`/kharos:setup` takes a Claude account from zero to ready for one repository, once.
`/kharos:doctor` checks the same things later, and says the action for each gap.
Every fix goes through an official path: kharos never works around a missing permission.

## What `/kharos:setup` does

It shows one list of everything a launch needs, in the order each step depends on the one before, with its state and the one action that fixes it:

1. Account and plan: Claude Code, a claude.ai login on a plan with cloud sessions, the `RemoteTrigger` tool, and which account this is.
2. GitHub connection: whether your Claude account has GitHub connected; if not, `/web-setup` or https://claude.ai/connect-github.
3. Repository access: a first commit (setup offers one, and writes it only on a yes), the branch, and whether Claude reaches the repository.
4. Cloud environment: picked by name from the environments of your account.
5. Commit identity: how commits are authored (see below).
6. Permission prompts: every mode kharos has, each with what it does and its trade-off, the ones this account or organization rules out marked with why; you pick one, once.
7. Profile: written only when the steps above are settled, as the default profile when it is the first one.

Once per account, it also asks how many cloud sessions may be open at once (`watch.max_open`), with the question it asks anyway, or alone before the profile is written.
It offers 10 (the default), 5 or 20, and any number can be named.
The cap is kharos's own: each open session spends plan usage like any other session, the service publishes no limit on concurrent cloud sessions, and it caps runs started by hand at 30 per routine and 100 per account per hour.

It works on the first gap, checks again after you fix it, and asks only what it cannot settle itself.
Run again, it asks nothing it already knows.
It ends with a summary of at most six lines: ready or not, and the next action.

The environments and the GitHub check come from Claude Code itself.
Its bundled `/schedule` skill lists the account's cloud environments (with their names) when it loads, creates a first one when there is none, and says when Claude cannot reach the GitHub repository of the current folder.
`/kharos:setup` loads that skill only to read those lines, and passes them to `kharos setup --from-schedule`; it never shows you an `env_...` id.
Claude Code checks only the repository of the current folder, so for another repository the first launch is the access check (below), and the summary says so.

The permission mode is only recorded in the profile.
The repository's files change through `/kharos:permissions`, after you approve its diff, and the automatic modes only when you turn them on yourself; setup ends with that command as the next action.

## Commit identity

Cloud sessions push with the GitHub credential your Claude account has: the Claude GitHub App, or the `gh` token `/web-setup` sent.
Commits are authored as `Claude <noreply@anthropic.com>` unless the environment sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`.
To author them as you, open the environment selector on https://claude.ai/code, the settings of the environment, and add one `NAME=value` line for each under Environment variables, with an email of your GitHub account (or its noreply address).
kharos cannot read those variables, so it says this instead of checking it.

## Launch approval

Each launch asks for your approval before its routine is created and run.
Claude Code's `RemoteTrigger` tool asks on every create and run of a routine, ignores an allow rule for the whole tool on those calls (`--allowedTools RemoteTrigger` included), and offers no "always allow", so kharos cannot make that approval durable.
In auto mode, Claude Code's classifier reviews each such call instead of a person ([permission modes](https://code.claude.com/docs/en/permission-modes)).
In a kharos test, a headless `/kharos:run` in auto mode had both the create and the run approved by the classifier, and the session started; the classifier decides each call, so a launch it blocks stops there and says why.

So there are two ways past the prompt, and kharos never bypasses it:

- For the whole account: the first `/kharos:setup` asks once whether this Claude account should start its sessions in auto mode, with the diff of its user settings (`permissions.defaultMode: "auto"` in `CLAUDE_CONFIG_DIR/settings.json`, `~/.claude/settings.json` by default), and writes it only on your yes.
  Then launches need no approval prompt and headless ones need nothing extra; the side effect is that every session of that account starts in auto mode, not only launches.
  A folder whose `.claude/settings.json` or `.claude/settings.local.json` sets another `permissions.defaultMode` overrides the account's, so launches from that folder ask again.
  `kharos permissions account-mode diff off` undoes it, back to the mode the file had; the option is unavailable when the organization turns auto mode off (`permissions.disableAutoMode`).
- For one launch: `claude -p --permission-mode auto`.

`/kharos:doctor` says which applies to the account in use.

## One setup per Claude account

Profiles, environments and sessions belong to one Claude account.
With a `CLAUDE_CONFIG_DIR` other than `~/.claude`, kharos keeps that account's files under `accounts/<folder>-<hash>/` of its configuration and state folders; the default account keeps the folders kharos always used.
The first `/kharos:setup` on such an account moves its profiles (the ones it wrote, or launched with) and its sessions out of the files every account shared before, and asks once about any profile whose account it cannot tell.
Each profile also records a hash of the account that wrote it, so a launch or `/kharos:doctor` on another account says so plainly instead of firing at an environment that account cannot use.

## Creating a cloud environment

A cloud environment holds the network access level, the setup script, the environment variables and the network secrets of your cloud sessions ([cloud environments](https://code.claude.com/docs/en/cloud-environments)).
No CLI or API creates or edits one: you create it in the environment selector on https://claude.ai/code, once per account.
`/kharos:setup` prepares what to put in it:

| Field | What kharos gives you |
|---|---|
| Setup script | `tools/cloud/bootstrap.sh` of the repository on the profile's branch, verbatim, with any `# snapshot:` line it carries; when the repository has none, a minimal script that installs nothing. It is copied to the clipboard when a clipboard tool exists (`pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip`), and printed in full |
| Environment variables | the names the repository's files expect, with what they say each is for. Never a value: you type the values on the page |
| Network access | the level the repository's documents name (`Network access: Full`); otherwise Limited with "Allow package managers", where a new environment starts |

kharos reads these files with your own `gh`: the setup script, the scripts and Markdown documents it names by repository path, `.env.example` and `.env.sample` at the root, and the `*.env.example` files those documents name.
Variable names come from table rows that start with a name in backticks, sentences about environment variables, the example files, and variables the scripts read and never set.
What follows `=` is never kept.

Before creating one, look in the list `/kharos:setup` shows for an environment that already serves the repository: on Team and Enterprise, an owner can share one with the organization.

When you pick "a new environment", `/kharos:setup` runs `kharos env-guide --repo owner/name --copy --open`, which opens the page and puts the script on the clipboard.
Once you created it, setup lists your environments again, and you pick the new one by name.
When the repository ships `tools/cloud/bootstrap.sh`, setup asks once whether the picked environment runs it, and records your answer (`--confirmed`).
From a shell, `kharos env-wait --since <printed default>` waits for `/remote-env` to save a new default environment instead.

## What kharos knows about an environment

Environments belong to one account, and nothing shows what one holds: the list `/schedule` gives has names, ids and kinds, never the setup script or the variables.
An environment is known to fit a repository when you confirmed it (`--confirmed`, kept by account, repository and revision in `setups.json` of the state folder, with a digest of the setup script; when the script was absent or could not be read then, any script the repository ships later counts as changed) or when one of your routines used it on that repository.

## The checks

Lines marked `info` show only with `--verbose`, so every warning is something you can act on.
The last line says whether a launch is ready, and when Claude's access to a repository is not confirmed yet.

| Check | Fails when | Fix |
|---|---|---|
| `claude` | Claude Code is missing or older than 2.1.323 | `claude update` |
| `login` | not logged in, logged in with an API key or a cloud provider, or `ANTHROPIC_API_KEY` is set | `claude auth login` with a claude.ai account; unset `ANTHROPIC_API_KEY` |
| `plan` | the subscription is not Pro, Max, Team or Enterprise | change the plan |
| `remote tool` | the session has no `RemoteTrigger` tool | update Claude Code; on Team or Enterprise, an owner allows cloud sessions and scheduled tasks |
| `config` | no file, or the file cannot be read, is not valid JSON, or has a wrong field | no file: `/kharos:setup`; otherwise fix or move the file the message names, then run `/kharos:setup` |
| `repos`, `environments`, `setups`, `registry`, `watcher` | a kharos state file exists but cannot be read, is not valid JSON, or has the wrong shape | repair or move the file the message names |
| `repo` | the repository has no commit (fail), or this machine's git cannot read it (warning only: the cloud does not use local credentials) | an initial commit, which setup offers |
| `revision` | the branch or tag of the profile does not exist | set `revision` to an existing branch |
| `claude access` | the service answered `repo_access_denied` | see below |
| `environment` | warning, when the environment was not confirmed for the repository and either the repository ships `tools/cloud/bootstrap.sh` while the environment was only picked by name or used on other repositories, or the account has routines, none use it, and it was not picked by name; or when the setup script changed on the profile's revision since you confirmed ("the setup script changed on <revision>; paste it again"). With no routine yet, information only | `/kharos:setup`, which picks it by name and asks about the setup script; for a changed script, `kharos env-guide --profile <name> --copy`, paste it into the environment, and confirm it with `/kharos:setup` |
| `account files` | profiles or sessions of this account still sit in the files every account shared (warning) | `/kharos:setup` once on this account |
| `profile <name>` | the profile was set up on another Claude account (information, or a failure when named with `--profile`) | `/kharos:setup` on this account |
| `commits` | (information) how cloud commits are authored | see [Commit identity](#commit-identity) |
| `launch approval` | whether this account starts its sessions in auto mode, so launches need no approval prompt; a warning when the settings ask for auto mode and the organization turns it off | `/kharos:setup`, or `kharos permissions account-mode diff auto` and `off`; see [Launch approval](#launch-approval) |
| `permissions` | the repository's `.claude/settings.json` on the launch branch has `ask` rules, no narrow allow rule for Bash, broad allow rules that auto mode drops, or `defaultMode` `bypassPermissions` or `dontAsk`, which cloud sessions ignore (warning: a session would likely stop at a prompt nobody sees; information only when you chose to leave the rules as they are, or your GitHub login cannot change the repository's settings) | `/kharos:permissions` in a checkout, then commit and push; see [permissions.md](permissions.md) |
| `managed policy` | (information) the local copy of the organization's managed settings: how many ask and deny rules, and whether bypass mode is disabled | none |
| `managed ask rules` | organization ask rules that would stop the profile's cloud sessions at a prompt, which no repository rule outranks (warning) | ask the organization's administrator to narrow them, or use the opt-in permission hook; see [permissions.md](permissions.md) |
| `managed hooks only` | the managed settings set `allowManagedHooksOnly`, so no repository hook runs and the permission hook never answers a prompt (warning) | ask the organization's administrator to narrow the rules instead |
| `permission hook` | the opt-in permission hook is on (warning); per profile, what the branch's hook answers (broad rules marked), a missing or changed script or rules file, a hook on the branch while the setting is off, or mirrored organization ask rules while the organization disables bypass mode (warning) | `kharos permissions hook disable`; `/kharos:permissions hook` in a checkout |
| `limits` | (information) open sessions against `watch.max_open`, and fires in the last hour | wait, or close finished sessions |

## Claude's access to the repository

A cloud session clones the repository on the Claude side, with the Claude GitHub App or with a GitHub token sent by `/web-setup`; your local git credentials are not used.
kharos cannot see that access with your machine's tools; `/kharos:setup` reads it from Claude Code for the repository of the current folder, and records it.
For any other repository, the service checks it when a routine is created, before any session exists, and answers `HTTP 403` with `repo_access_denied` when it is missing.
kharos creates every routine disabled, so that check is free: a refused launch starts nothing and spends nothing.
The first launch in a repository is then also its access check, and `/kharos:doctor` remembers the answer.

When the answer is `repo_access_denied`, the fix is one of:

1. Install the Claude GitHub App with access to the repository: https://github.com/apps/claude/installations/new.
   If the app is installed on the account already, add the repository to it: https://github.com/settings/installations for a personal account, or `https://github.com/organizations/<org>/settings/installations` for an organization.
   In an organization, only an owner can install the app or change its repositories; other members can send a request from the same page.
2. Or run `/web-setup` in Claude Code, which sends your `gh` token to your Claude account; the cloud then reaches what `gh` reaches.

Then launch again.

## An empty repository

A cloud session cannot start from a repository with no commit.
`/kharos:setup` offers to create one (`README.md`, through `gh api`), and only does it when you say yes.
You can also push a first commit yourself.

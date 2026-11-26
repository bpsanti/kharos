# Setting up a repository

`/kharos:setup` writes a launch profile for one repository, and `/kharos:doctor` checks everything a launch depends on.
Each check that fails comes with its fix, and every fix goes through an official path: kharos never works around a missing permission.

## What `/kharos:setup` does

1. Picks the repository: the one you name, or the `origin` of the current folder when it is on GitHub.
2. Picks the cloud environment.
   The `RemoteTrigger` tool has no list of environments, so kharos reads your routines (`RemoteTrigger list`), offers the environment ids they use, most recent first, and says which one is known for the repository.
   When none fits, it offers the [assisted path](#creating-a-cloud-environment).
3. Writes the profile to `~/.config/kharos/config.json`.
   Without `--revision`, the profile follows the repository's default branch.
4. Runs `/kharos:doctor` for the profile.
5. If the repository has no commit, it asks whether it may create an initial commit with a `README.md`, and only writes on an explicit yes.

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

Before creating one, look in the selector for an environment that already serves the repository: on Team and Enterprise, an owner can share one with the organization, under "Organization".
kharos cannot list environments, so it cannot find a shared one for you.

kharos opens the page, then learns the new id from the `remote.defaultEnvironmentId` user setting: run `/remote-env` in Claude Code and pick the new environment.
That also makes it your default for `claude --cloud`.
Or paste its id, which `/schedule` shows.
The wait is bounded (10 minutes by default, `kharos env-wait --timeout`), and kharos writes the id into the profile only after you confirm it.

The same from a shell: `kharos env-guide --repo owner/name --copy --open`, `kharos env-wait --since <printed default>`, then `kharos setup ... --environment env_... --confirmed`.

## What kharos knows about an environment

Environments belong to one account, and nothing shows what one holds.
An environment is known to fit a repository when you confirmed it (`--confirmed`, kept by account, repository and revision in `setups.json` of the state folder, with a digest of the setup script; when the script was absent or could not be read then, any script the repository ships later counts as changed) or when one of your routines used it on that repository.

## The checks

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
| `environment` | warning, when you have not confirmed the environment for the repository and none of your routines uses it, or the repository ships `tools/cloud/bootstrap.sh` and your routines used the environment only on other repositories; or the setup script changed on the profile's revision since you confirmed ("the setup script changed on <revision>; paste it again") | check the id in `/schedule`; for a changed script, copy it with `kharos env-guide --profile <name> --copy`, paste it into the environment and confirm it with `/kharos:setup`; or take the [assisted path](#creating-a-cloud-environment) with `/kharos:setup` |
| `permissions` | the repository's `.claude/settings.json` on the launch branch has `ask` rules, no narrow allow rule for Bash, broad allow rules that auto mode drops, or `defaultMode` `bypassPermissions` or `dontAsk`, which cloud sessions ignore (warning: a session would likely stop at a prompt nobody sees) | `/kharos:permissions` in a checkout, then commit and push; see [permissions.md](permissions.md) |
| `managed policy` | (information) the local copy of the organization's managed settings: how many ask and deny rules, and whether bypass mode is disabled | none |
| `managed ask rules` | organization ask rules that would stop the profile's cloud sessions at a prompt, which no repository rule outranks (warning) | ask the organization's administrator to narrow them, or use the opt-in permission hook; see [permissions.md](permissions.md) |
| `managed hooks only` | the managed settings set `allowManagedHooksOnly`, so no repository hook runs and the permission hook never answers a prompt (warning) | ask the organization's administrator to narrow the rules instead |
| `permission hook` | the opt-in permission hook is on (warning); per profile, what the branch's hook answers (broad rules marked), a missing or changed script or rules file, a hook on the branch while the setting is off, or mirrored organization ask rules while the organization disables bypass mode (warning) | `kharos permissions hook disable`; `/kharos:permissions hook` in a checkout |
| `limits` | (information) open sessions against `watch.max_open`, and fires in the last hour | wait, or close finished sessions |

## Claude's access to the repository

A cloud session clones the repository on the Claude side, with the Claude GitHub App or with a GitHub token sent by `/web-setup`; your local git credentials are not used.
kharos cannot see that access from your machine.
The service checks it when a routine is created, before any session exists, and answers `HTTP 403` with `repo_access_denied` when it is missing.
kharos creates every routine disabled, so that check is free: a refused launch starts nothing and spends nothing.
The first launch in a repository is therefore also its access check, and `/kharos:doctor` remembers the answer.

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

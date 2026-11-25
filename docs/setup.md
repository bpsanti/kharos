# Setting up a repository

`/kharos:setup` writes a launch profile for one repository, and `/kharos:doctor` checks everything a launch depends on.
Each check that fails comes with its fix, and every fix goes through an official path: kharos never works around a missing permission.

## What `/kharos:setup` does

1. Picks the repository: the one you name, or the `origin` of the current folder when it is on GitHub.
2. Picks the cloud environment.
   The `RemoteTrigger` tool has no list of environments, so kharos reads your routines (`RemoteTrigger list`) and offers the environment ids they use, most recent first.
   With no routine yet, create or pick an environment on claude.ai/code and read its id in `/schedule`.
3. Writes the profile to `~/.config/kharos/config.json`.
   Without `--revision`, the profile follows the repository's default branch.
4. Runs `/kharos:doctor` for the profile.
5. If the repository has no commit, it asks whether it may create an initial commit with a `README.md`, and only writes on an explicit yes.

## The checks

| Check | Fails when | Fix |
|---|---|---|
| `claude` | Claude Code is missing or older than 2.1.323 | `claude update` |
| `login` | not logged in, logged in with an API key or a cloud provider, or `ANTHROPIC_API_KEY` is set | `claude auth login` with a claude.ai account; unset `ANTHROPIC_API_KEY` |
| `plan` | the subscription is not Pro, Max, Team or Enterprise | change the plan |
| `remote tool` | the session has no `RemoteTrigger` tool | update Claude Code; on Team or Enterprise, an owner allows cloud sessions and scheduled tasks |
| `config` | no file, or the file cannot be read, is not valid JSON, or has a wrong field | no file: `/kharos:setup`; otherwise fix or move the file the message names, then run `/kharos:setup` |
| `repos`, `environments`, `registry`, `watcher` | a kharos state file exists but cannot be read, is not valid JSON, or has the wrong shape | repair or move the file the message names |
| `repo` | the repository has no commit (fail), or this machine's git cannot read it (warning only: the cloud does not use local credentials) | an initial commit, which setup offers |
| `revision` | the branch or tag of the profile does not exist | set `revision` to an existing branch |
| `claude access` | the service answered `repo_access_denied` | see below |
| `environment` | the environment id is not used by any of your routines (warning) | check the id in `/schedule` |
| `permissions` | the repository's `.claude/settings.json` on the launch branch has `ask` rules, or no allow rule for Bash (warning: a session would likely stop at a prompt nobody sees) | `/kharos:permissions` in a checkout, then commit and push; see [permissions.md](permissions.md) |
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

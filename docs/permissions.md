# Permissions in cloud sessions

A cloud session that stops at a permission prompt waits until a person answers it on the session page.
Nobody sees that prompt unless something says so: the watcher turns it into a `session.waiting_permission` event (see [watcher.md](watcher.md)), and `/kharos:permissions` changes the repository rules that cause most prompts.
kharos never answers a prompt: there is no documented way to answer one outside the session page, and it never uses the login.

## Where the prompts come from

Each line below is from the Claude Code documentation, unless it says it comes from a kharos test.

- A cloud session on one repository reads the repository's `.claude/settings.json`, because the file is part of the clone.
  It does not read `~/.claude/settings.json` or `.claude/settings.local.json`: both stay on the person's machine ([settings](https://code.claude.com/docs/en/settings)).
  kharos profiles have one repository each, so their sessions read that file.
- A session that a routine starts begins in auto mode, unless auto mode is not available ([scheduled tasks](https://code.claude.com/docs/en/routines)).
  Every kharos launch is a routine run.
- In auto mode, actions that match an allow, ask or deny rule resolve at once; a classifier decides the rest ([permission modes](https://code.claude.com/docs/en/permission-modes)).
  - An `ask` rule always prompts, even in auto mode.
  - A `deny` rule always blocks, in every mode.
  - On entering auto mode, broad allow rules that grant arbitrary code execution are dropped, such as `Bash(*)`, wildcarded interpreters, package-manager run commands and `Agent`; narrow rules such as `Bash(npm test)` stay.
  - After the classifier blocks 3 actions in a row, or 20 in the session, a prompt appears in the run's session and waits until someone answers it; these numbers are not configurable.
- `defaultMode` values `auto` and `bypassPermissions` do not take effect from a repository's settings, and cloud sessions ignore `dontAsk` from settings files; they honor `acceptEdits`, and they pre-approve file edits in any mode.
- `permissions.denyInsteadOfPrompting`, which turns a prompt into a denial, is read only from user or managed settings, and a cloud session does not read the user's file.
- The `allowed_tools` list of a routine neither allows nor restricts anything, in two kharos tests.
  With `allowed_tools: ["Bash", "Read"]`, `Write` ran with no prompt; with `Bash` in the list, a Bash command that an `ask` rule of the repository covered still prompted.

So, for a kharos launch, the prompts that wait for a person come from `ask` rules in the repository's `.claude/settings.json`, from repeated classifier blocks, from tools that always ask (such as `AskUserQuestion`, which the watcher reports as `waiting_answer`), and from every command not allowed by a rule when auto mode is not available.

Not tested yet:

- Whether a bare `Bash` allow rule is dropped in auto mode as `Bash(*)` is (the documentation says the two are the same rule).
- Whether rules such as `Bash(npm run test *)` count as package-manager run commands, which auto mode drops.
- Whether allow rules wait for folder trust in a cloud session, as they do on a person's machine.
- Which mode a routine run uses when auto mode is not available.
- Whether a repository's `defaultMode: "acceptEdits"` changes how a routine run starts.

## Permission profiles

`/kharos:permissions [profile] [folder]` works on a local checkout of the repository.

1. It shows the rules of `.claude/settings.json`, which profile they match, and what in them would hold a session at a prompt.
2. With a profile, it shows the change as a diff.
3. It writes the file only after the person approves that exact diff, and never commits or pushes.

| Profile | Change |
|---|---|
| `default` | Nothing |
| `standard` | Adds allow rules for the file tools, read-only shell commands, git commands that read, commit and create a branch, and the build and test commands of the repository; keeps every `ask` and `deny` rule |
| `open` | Adds allow rules for every built-in tool, removes every `ask` rule, and keeps every `deny` rule |

Rules the person already has stay first, and every other key of the file stays as it is.
Neither profile allows `git push`: the auto mode classifier decides it, unless an `ask` rule asks for it.
Neither profile covers connector (MCP) tools.

`standard` allows:

- `Read`, `Glob`, `Grep`, `Edit`, `Write`;
- `Bash(ls *)`, `Bash(pwd)`, `Bash(cat *)`, `Bash(head *)`, `Bash(tail *)`, `Bash(wc *)`, `Bash(grep *)`, `Bash(rg *)`, `Bash(diff *)`, `Bash(which *)`;
- `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git show *)`, `Bash(git branch *)`, `Bash(git rev-parse *)`, `Bash(git fetch *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git switch -c *)`, `Bash(git checkout -b *)`;
- the build and test commands of what the repository holds at its root:

| Found | Rules |
|---|---|
| `package.json` | install (`npm ci`, or the install of pnpm, yarn or bun when its lockfile is there), `<pm> test *`, and `<pm> run <script> *` for each script named build, test, check, lint, typecheck, format, compile or verify (with a suffix such as `test:unit`, unless the name says deploy, release, publish, upload or push) |
| `Cargo.toml` | `cargo build`, `test`, `check`, `clippy`, `fmt` |
| `go.mod` | `go build`, `test`, `vet` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `pytest.ini`, `tox.ini` | `pytest *`, `python -m pytest *` |
| `Makefile` | `make <target> *` for each target with one of the names above |
| `gradlew` | `./gradlew build`, `test`, `check` |
| `pom.xml` | `mvn compile`, `test`, `verify`, `package` |

`open` allows `Bash`, `Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch` and `Agent`.
While auto mode is on, the broad ones among them are dropped (see above), so `open` mostly matters when auto mode is not available; removing the `ask` rules is what stops the prompts they cause.

The file must be plain JSON; kharos refuses to edit a file it cannot parse.
`write` takes the token that `diff` printed, and refuses when the file changed since, or when the token is for another profile.

## What the doctor says

For each launch profile, `/kharos:doctor` reads `.claude/settings.json` on the branch the profile launches from, with the person's own `gh`, and reports which permission profile it is on: `open`, `standard`, `default` (no rules at all) or `custom`.
It warns when a launch would likely stall: `ask` rules, which always prompt, or no allow rule for Bash.
It says so when `defaultMode` holds a value that cloud sessions do not apply.
When `gh` cannot read the file, the check is information only.

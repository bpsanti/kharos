# Permissions in cloud sessions

A cloud session that stops at a permission prompt waits until a person answers it on the session page.
Nobody sees that prompt unless something says so: the watcher turns it into a `session.waiting_permission` event (see [watcher.md](watcher.md)), and `/kharos:permissions` changes what in the repository causes most prompts.
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
  - On entering auto mode, broad allow rules that grant arbitrary code execution are dropped: `Bash(*)` (the same rule as `Bash`), rules that start with a wildcard, wildcarded interpreters such as `Bash(python*)`, a wrapper followed only by a wildcard such as `Bash(timeout *)`, package-manager run commands, and `Agent` and `Monitor` rules.
    Narrow rules such as `Bash(npm test)` stay, and resolve before the classifier.
  - After the classifier blocks 3 actions in a row, or 20 in the session, a prompt appears in the run's session and waits until someone answers it; these numbers are not configurable.
  - The classifier reads the repository's `CLAUDE.md` ([auto mode configuration](https://code.claude.com/docs/en/auto-mode-config)).
  - `autoMode` settings are read only from user settings, managed settings or `--settings`, never from a repository's `.claude/settings.json`.
- Cloud sessions have no bypass mode: the mode menu offers Accept edits, Plan and Auto, and `bypassPermissions` and `dontAsk` in settings files are ignored.
  `defaultMode: "auto"` does not take effect from a repository's settings either; cloud sessions honor `acceptEdits`, and they pre-approve file edits in any mode.
- `permissions.denyInsteadOfPrompting`, which turns a prompt into a denial, is read only from user or managed settings, and a cloud session does not read the user's file.
- The `allowed_tools` list of a routine neither allows nor restricts anything, in two kharos tests.
  With `allowed_tools: ["Bash", "Read"]`, `Write` ran with no prompt; with `Bash` in the list, a Bash command that an `ask` rule of the repository covered still prompted.

So, for a kharos launch, the prompts that wait for a person come from `ask` rules in the repository's `.claude/settings.json`, from repeated classifier blocks, from tools that always ask (such as `AskUserQuestion`, which the watcher reports as `waiting_answer`), and from every command not allowed by a rule when auto mode is not available.
No setting in the repository can allow everything: broad rules are dropped and no bypass mode exists.
What helps is narrow allow rules for the commands the work needs, and a `CLAUDE.md` that tells the classifier where the session runs, so it blocks less.

Not tested yet:

- Whether allow rules wait for folder trust in a cloud session, as they do on a person's machine.
- Which mode a routine run uses when auto mode is not available.
- Whether a repository's `defaultMode: "acceptEdits"` changes how a routine run starts.

## Permission profiles

`/kharos:permissions [default|standard|environment] [folder]` works on a local checkout of the repository.

1. It shows the rules of `.claude/settings.json`, which profile they match, what in them would hold a session at a prompt or does nothing in a cloud session, and whether `CLAUDE.md` has the environment note.
2. With a profile or `environment`, it shows the change as a diff.
3. It writes the file only after the person approves that exact diff, and never commits or pushes.

| Change | What it does |
|---|---|
| `default` | Nothing |
| `standard` | Adds narrow allow rules, which auto mode keeps, for the file tools, read-only shell commands, git commands that read, commit and create a branch, and the build, test and dev commands of the repository; keeps every `ask` and `deny` rule |
| `environment` | Adds a short paragraph at the end of `CLAUDE.md` that tells the auto mode classifier the session runs in an isolated, disposable cloud VM with local development services; the rest of the file does not change |

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
| `package.json` | install (`npm ci`, or the install of pnpm, yarn or bun when its lockfile is there), `<pm> test`, and `<pm> run <script>` for each script named build, test, check, lint, typecheck, format, compile, verify, dev, start or serve (with a suffix such as `test:unit`, unless the name says deploy, release, publish, upload or push); these are exact commands, since auto mode drops package-manager run rules with a wildcard |
| `Cargo.toml` | `cargo build`, `test`, `check`, `clippy`, `fmt` |
| `go.mod` | `go build`, `test`, `vet` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `pytest.ini`, `tox.ini` | `pytest *` |
| `Makefile` | `make <target> *` for each target with one of the names above |
| `gradlew` | `./gradlew build`, `test`, `check` |
| `pom.xml` | `mvn compile`, `test`, `verify`, `package` |

The environment note is:

```markdown
<!-- kharos:cloud-environment -->
## Cloud session environment

When this repository runs in a Claude Code cloud session, the session runs in an isolated, disposable cloud VM made for that task, and the VM is removed when the session ends.
Development services started in it (databases, caches, emulators) are local to that VM.
Running the repository's build, test and development commands there, and starting, seeding or resetting those local services, is expected work.
<!-- /kharos:cloud-environment -->
```

It says nothing about the repository's data or about what the session may push, since kharos cannot know either.
When `CLAUDE.md` is a link (to `AGENTS.md`, say), the note goes into the file it points to, which must be inside the checkout.

The settings file must be plain JSON; kharos refuses to edit a file it cannot parse.
`write` takes the token that `diff` printed, and refuses when the file changed since, or when the token is for another change.

## What the doctor says

For each launch profile, `/kharos:doctor` reads `.claude/settings.json` on the branch the profile launches from, with the person's own `gh`, and reports which permission profile it is on: `standard`, `default` (no rules at all) or `custom`.
It warns when a launch would likely stall, or relies on something cloud sessions ignore:

- `ask` rules, which always prompt;
- broad allow rules, which auto mode drops;
- no narrow allow rule for Bash;
- `defaultMode` set to `bypassPermissions` or `dontAsk`.

It notes `defaultMode: "auto"` and `autoMode` settings, which a repository's settings cannot set.
When `gh` cannot read the file, the check is information only.

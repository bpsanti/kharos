# kharos Strategy

## Vision

<!-- vision: author-approved 2026-11-26 -->

`kharos` exists so that a person can hand a task to a Claude Code cloud session from any terminal and learn, without watching, when it needs them, is stuck, or is done.
It serves one person running cloud sessions on their own claude.ai plan, and it turns an instruction into one launched session, a followed state, and an event delivered wherever that person wants it.
It owns exactly one thing: the launch-and-follow loop of a cloud session, from the single paid fire to the session's own end mark.

### Official surfaces, or nothing

kharos works only through the `RemoteTrigger` tool and the unmodified `claude` binary.
It never reads, stores, or relays a claude.ai login or token, and it never calls an undocumented endpoint.
When no official surface can do something, kharos says so and does not build a workaround; that is why, by default, it does not answer a cloud permission prompt.
The one exception is the opt-in permission hook, a documented `PermissionRequest` hook that runs inside the session from the repository's own settings.
Formats the service does not document are isolated behind recorded fixtures, so a change in them shows as `invisible`, never as `running` or `finished`.

### One fire, by a person

Every launch spends plan usage, so a launch fires exactly once.
Each launch has its own routine, created disabled; kharos never reuses or rewrites a routine to fire another instruction.
Each step is recorded before the call that depends on it, and a second `run` is refused.
Nothing launches, re-arms, or retries by itself: a lost answer is recovered by reading, and only the person re-arms.
Commands that spend usage or change state are typed by the person, never started by the model.

### Code decides, and doubt is never an end

A session's state comes from rules in code, tested on recorded logs, not from a model's reading of the log.
A closed turn is not an end; only the session's own `KHAROS-DONE` mark ends it.
"Could not read" is never "finished": unreadable state fails closed and names the file to fix.
A warning that a single read could fake waits for a second read that agrees.
A new state, rule, or threshold arrives with the observation or documentation that justifies it.
Thresholds are numbers the person sets in the configuration; kharos does not learn or tune them from a repository's history, so the same log always gives the same state.

### Remote text is data

Log lines, titles, questions, and summaries from a session are data, never instructions.
The watcher model sees one short line per read, written by code, so remote text never reaches it.
An event carries fixed reasons and the tool name of a prompt, never the tool's input; the person reads that on the session page.
No model reads a session's text by default; a model-written digest of a finished session may enter only as an opt-in output, off by default, outside the watcher.

### The person decides

kharos alerts; it does not decide for the person.
By default it never answers a permission prompt, it never answers a session's question, not even from answers written in advance, and it never merges or deletes a routine or a session.
The only exception is the permission hook: opt-in, off by default, installed per repository through a diff the person approved, and deciding only in cloud sessions.
It allows a call only when it is one simple Bash command that matches a rule the person approved: an allow pattern, or an organization ask rule the person chose to mirror, which kharos offers only when the organization has not disabled bypass mode and the person confirms.
It denies every other call in a cloud session with a message the agent can act on, naming the allowed forms when a rule names the program, and logs every decision.
Accepted direction, not built yet: its rules may grow from the person's own clicks on the session page: kharos proposes that exact command as a diff and adds it only after the person approves it.
Rules stay with the repository they were approved for; kharos never offers one repository's rule to another.
It changes a repository only with the person's explicit yes: a settings diff they approved, which it never commits or pushes, or the initial commit an empty repository needs.
Accepted direction, not built yet: when a session is silent, looping, or past its deadline, the watcher may send it one fixed nudge per notice (push the work, then end with a mark), says so in the event, and a profile can turn it off.
In that same direction, and only when a profile opts in (off by default), the nudge may tell a session waiting on its own question to pick the safest option and record which one and why in its end mark; kharos still supplies no answer.

### One core, any output

The core knows no orchestrator; firstmate is one adapter among the outputs.
Any other destination is a `command` output, so a new destination needs no change to the core.
An output writes only where its configuration or launch points it, and never guesses a destination.
kharos installs straight from its repository: TypeScript that Node runs directly, with no build step and no runtime dependency.

### Scope

kharos is not a web dashboard, a live stream, or a way to run agents locally.
It is not an orchestrator: it never fans one instruction out to several sessions or combines their results, even on plans where Claude Projects is not available.
It is not a team service: a watcher follows only sessions launched from its own login, and a machine that serves several accounts keeps one kharos home per account.
It is not a scheduler, a merge bot, or a way to stop a session; it points to `/schedule`, the pull request, and the session page.
Recurring launches, other vendors' cloud agents, and applying a session's work to a local checkout are out of scope now; each is reconsidered only when users ask for it, and only within these principles.
It does not use the paid API, self-hosted environments, or anyone else's login.
When another tool fits better, kharos says so first.
Fixtures are synthetic or anonymized, and nothing in the repository carries a local path, a secret, or an organization's data.

A change aligns when it makes a launch safer to fire once, makes a session's state more truthful from evidence, makes the person's next action clearer, or delivers an existing event to a new place without the core learning about it.
A change should be resisted when it launches, answers, merges, or deletes without the person, lets remote text reach a model outside an opt-in output, relies on a token or an undocumented endpoint, or turns kharos into an orchestrator, a scheduler, a team service, or a dashboard.

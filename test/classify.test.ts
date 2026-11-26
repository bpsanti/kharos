import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, normalizeError, sameErrorRun, type Verdict } from '../src/classify.ts';
import { DEFAULT_WATCH } from '../src/config.ts';
import { transition } from '../src/events.ts';
import { parseLog, type LogEvent } from '../src/logparse.ts';
import type { Session } from '../src/registry.ts';
import { latestMarks, sinceLastUser } from '../src/track.ts';
import { fixture } from './helpers.ts';

const BASE = Date.parse('2026-11-25T17:51:00Z');

/** A synthetic log: [seconds after BASE, kind, tool or null, text]. */
function log(rows: [number, string, string | null, string][]): LogEvent[] {
  return rows.map(([sec, kind, tool, text], seq) => {
    const ts = new Date(BASE + sec * 1000).toISOString();
    return { t: BASE + sec * 1000, ts, kind, tool, text, truncated: false, key: `${seq}`, seq };
  });
}

function at(events: LogEvent[], nowSec: number, over: Partial<Parameters<typeof classify>[0]> = {}): Verdict {
  return classify({ events, seenStart: true, startedAt: BASE, deadlineMin: 180, now: BASE + nowSec * 1000, watch: DEFAULT_WATCH, ...over });
}

const START: [number, string, string | null, string][] = [
  [0, 'user', null, 'Fix the typo. --- Protocol ... KHAROS-DONE {"status":"ok|failed","pr":"<url or null>"}'],
  [1, 'env[info]', null, 'Allocating sandbox'],
  [120, 'init', null, 'model=claude-sonnet-5-5 cwd=/home/user/repo'],
];

/** Replays a real log minute by minute, with the reads it had, and returns the states it went through. */
function replay(events: LogEvent[], stepSec: number, extraSec: number, over: Partial<Parameters<typeof classify>[0]> = {}): string[] {
  const t0 = events[0]!.t;
  const t1 = events[events.length - 1]!.t + extraSec * 1000;
  const seen: string[] = [];
  for (let now = t0; now <= t1; now += stepSec * 1000) {
    const v = classify({ events: events.filter((e) => e.t <= now), seenStart: true, startedAt: t0, deadlineMin: 180, now, watch: DEFAULT_WATCH, ...over });
    const label = v.notice ? `${v.state}/${v.notice}` : v.state;
    if (seen[seen.length - 1] !== label) seen.push(label);
  }
  return seen;
}

test('classify: a question, an answer, a background command and the end, read every 15 s', () => {
  const page = parseLog(fixture('log-question-background-done.txt'));
  assert.deepEqual(replay(page.events, 15, 120), ['provisioning', 'running', 'waiting_answer/waiting_answer', 'turn_closed', 'finished/finished']);
});

test('classify: the end mark inside the prompt is not an end', () => {
  const page = parseLog(fixture('log-question-background-done.txt'));
  const firstTurn = page.events.filter((e) => e.t <= Date.parse('2026-11-25T18:58:00Z'));
  assert.equal(at(firstTurn, 0, { now: Date.parse('2026-11-25T18:58:00Z'), startedAt: firstTurn[0]!.t }).state, 'running');
});

test('classify: a short session ends finished', () => {
  const page = parseLog(fixture('log-write-done.txt'));
  const now = page.events[page.events.length - 1]!.t + 5000;
  assert.equal(classify({ events: page.events, seenStart: true, startedAt: page.events[0]!.t, deadlineMin: 60, now, watch: DEFAULT_WATCH }).state, 'finished');
});

test('classify: a ten-minute foreground command is quiet, not silent', () => {
  const events = log([...START, [130, 'tool_use', 'Bash', '{"command":"cargo test","timeout":600000}'], [721, 'tool_result', null, 'test result: ok']]);
  assert.equal(at(events.slice(0, 4), 720).state, 'running'); // 591 s with no event
  assert.deepEqual(at(events.slice(0, 4), 130 + 16 * 60), { state: 'silent', notice: 'silent', reason: 'no new event for 16 min in an open turn' });
  assert.equal(at(events.slice(0, 4), 130 + 46 * 60).notice, 'silent_severe');
});

test('classify: a closed turn is not an end; with no background task it warns after unmarked_end_min', () => {
  const events = log([...START, [200, 'assistant', null, 'all done'], [201, 'result', null, 'success is_error=false turns=9 — all done']]);
  assert.deepEqual(at(events, 201 + 4 * 60), { state: 'turn_closed', notice: null, reason: 'turn closed' });
  assert.deepEqual(at(events, 201 + 6 * 60), { state: 'turn_closed', notice: 'quiet_unmarked', reason: 'turn closed without an end mark, quiet for 6 min; it started no background task' });
  const woke = log([...START, [200, 'assistant', null, 'waiting'], [201, 'result', null, 'success is_error=false'], [828, 'init', null, 'model=x']]);
  assert.equal(at(woke, 830).state, 'running');
});

test('classify: a turn that closed on a background task it started warns only after quiet_end_min', () => {
  for (const started of [
    [150, 'tool_use', 'Bash', '{"command":"cargo build","run_in_background":true}'],
    [150, 'tool_use', 'Monitor', '{"command":"tail -f build.log"}'],
    [150, 'tool_result', null, 'Async agent launched successfully. agentId: a1b2 (the agent works in the background; you will be notified when it completes)'],
    [150, 'tool_result', null, 'Command running in background with ID: b01. Output is being written to: /tmp/b01.output'],
  ] as [number, string, string | null, string][]) {
    const events = log([...START, started, [200, 'assistant', null, 'The server is still compiling'], [201, 'result', null, 'success is_error=false']]);
    assert.deepEqual(at(events, 201 + 10 * 60), { state: 'turn_closed', notice: null, reason: 'turn closed; a background task it started may wake it' }, started[3]);
    assert.equal(at(events, 201 + 41 * 60).notice, 'quiet_unmarked');
    assert.match(at(events, 201 + 41 * 60).reason, /a background task it started may still wake it$/);
  }
  // A foreground agent returns its report inside the turn, so nothing is left to wake it.
  const foreground = log([...START, [150, 'tool_use', 'Agent', '{"description":"Search the code","prompt":"..."}'], [180, 'tool_result', null, 'The parser lives in src/logparse.ts.'], [200, 'assistant', null, 'Found it'], [201, 'result', null, 'success is_error=false']]);
  assert.equal(at(foreground, 201 + 6 * 60).notice, 'quiet_unmarked');
  // A result that only mentions background work started none.
  const mention = log([...START, [150, 'tool_use', 'Agent', '{"description":"Check the server"}'], [180, 'tool_result', null, 'The dev server is running in the background on port 3000, launched in the background by the setup script.'], [200, 'assistant', null, 'ok'], [201, 'result', null, 'success is_error=false']]);
  assert.equal(at(mention, 201 + 6 * 60).notice, 'quiet_unmarked');
  // A task of an earlier turn does not count: a person's message since then started a new turn.
  const earlier = log([...START, [150, 'tool_use', 'Monitor', '{}'], [160, 'result', null, 'success'], [170, 'user', null, 'go on'], [200, 'assistant', null, 'ok'], [201, 'result', null, 'success']]);
  assert.equal(at(earlier, 201 + 6 * 60).notice, 'quiet_unmarked');
});

test('classify: repeated calls that succeed, or a hook that blocks one, are not a loop', () => {
  const events = log([
    ...START,
    [130, 'tool_use', 'Bash', '{"command":"tools/wait-ci.sh 3"}'],
    [131, 'tool_result', null, 'Error: blocked by hook: use the background form'],
    [140, 'tool_use', 'Bash', '{"command":"tools/wait-ci.sh 3"}'],
    [400, 'tool_result', null, 'checks: 5 pending'],
    [410, 'tool_use', 'Bash', '{"command":"tools/wait-ci.sh 3"}'],
    [700, 'tool_result', null, 'checks: 2 pending'],
    [710, 'tool_use', 'Bash', '{"command":"tools/wait-ci.sh 3"}'],
    [900, 'tool_result', null, 'checks: all green'],
  ]);
  assert.equal(at(events, 901).state, 'running');
});

test('classify: the same error four times in a row is a loop; other errors are not', () => {
  const rows: [number, string, string | null, string][] = [...START];
  for (let i = 0; i < 4; i++) {
    rows.push([200 + i * 10, 'tool_use', 'Bash', '{"command":"npm test"}']);
    rows.push([205 + i * 10, 'tool_result', null, `Error: exit code 1 at /home/user/repo/src/a${i}.ts:${10 + i}`]);
  }
  assert.equal(sameErrorRun(log(rows)), 4);
  assert.equal(at(log(rows), 250).state, 'looping');
  const different = rows.slice(0, 3 + 4).concat([[300, 'tool_use', 'Bash', '{}'], [301, 'tool_result', null, 'Error: module not found']]);
  assert.notEqual(at(log(different), 310).state, 'looping');
  assert.equal(normalizeError('exit code 2 at /a/b.ts:12 id 0123456789abcdef'), normalizeError('exit code 7 at /c/d.ts:99 id fedcba9876543210'));
});

test('classify: failure, permission, deadline, usage limit and provisioning', () => {
  assert.equal(at(log([[0, 'user', null, 'x'], [5, 'env[error]', null, 'Clone failed']]), 10).state, 'failed');
  assert.equal(at(log([...START, [300, 'assistant', null, 'KHAROS-DONE {"status":"failed","pr":null,"branch":null,"summary":"tests do not pass"}']]), 301).state, 'failed');
  const perm = log([...START, [130, 'tool_use', 'Bash', '{"command":"git push"}'], [131, 'permission_request', 'Bash', 'git push']]);
  assert.equal(at(perm, 400).state, 'waiting_permission');
  assert.equal(at(log([...START, [130, 'tool_use', 'Bash', '{}'], [131, 'permission_request', 'Bash', 'x'], [200, 'tool_result', null, 'ok']]), 210).state, 'running');
  assert.equal(at(log([...START, [130, 'tool_use', 'Bash', '{}']]), 181 * 60).state, 'overdue');
  assert.equal(at(log([...START, [130, 'result', null, 'error is_error=true — You\'ve hit your usage limit']]), 140).state, 'usage_limit');
  assert.equal(at(log([...START, [130, 'system[api_error]', null, 'rate_limit_error: usage limit reached']]), 140).state, 'usage_limit');
  assert.deepEqual(at(log(START.slice(0, 2)), 60), { state: 'provisioning', notice: null, reason: 'provisioning' });
  assert.equal(at(log(START.slice(0, 2)), 16 * 60).notice, 'provisioning_slow');
  // A page that starts in the middle of a session has no init line, and that does not mean provisioning.
  assert.equal(at(log([[0, 'tool_result', null, 'ok']]), 30, { seenStart: false }).state, 'running');
  assert.equal(at(log([...START, [130, 'tool_use', 'AskUserQuestion', '{"questions":[]}']]), 140).state, 'waiting_answer');
});

test('classify: a turn that ended with an error is a warning, and the usage limit wins over it', () => {
  assert.deepEqual(at(log([...START, [300, 'result', null, 'error_during_execution is_error=true']]), 301), { state: 'turn_closed', notice: 'turn_error', reason: 'turn ended with an error' });
  const limited = log([...START, [300, 'assistant', null, 'working'], [301, 'result', null, "error_during_execution is_error=true — You've hit your usage limit"]]);
  assert.equal(at(limited, 310).state, 'usage_limit');
});

test('classify: a usage limit the session writes about is its own text, not the plan limit', () => {
  const done = log([...START, [300, 'assistant', null, 'KHAROS-DONE {"status":"ok","pr":null,"branch":"limits","summary":"Add a per-user usage limit to the API"}'], [301, 'result', null, 'success is_error=false — KHAROS-DONE {"status":"ok","pr":null,"branch":"limits","summary":"Add a per-user usage limit to the API"}']]);
  assert.equal(at(done, 310).state, 'finished');
  const question = log([...START, [300, 'result', null, 'success is_error=false — KHAROS-QUESTION {"question":"Should the plan limit be per org? The usage limit reached today was per user."}']]);
  assert.equal(at(question, 310).state, 'waiting_answer');
  const prose = log([...START, [300, 'result', null, 'success is_error=false — documented what happens when the usage limit is reached']]);
  assert.equal(at(prose, 310).state, 'turn_closed');
});

test('classify: a message after an error wakes the session; it reads as running and can finish', () => {
  const errored: [number, string, string | null, string][] = [...START, [300, 'result', null, 'error_during_execution is_error=true']];
  const woken: [number, string, string | null, string][] = [...errored, [900, 'user', null, 'Try again with the other branch.'], [905, 'tool_use', 'Bash', '{"command":"git switch other"}']];
  assert.equal(at(log(woken), 910).state, 'running');
  const done: [number, string, string | null, string][] = [...woken, [950, 'tool_result', null, 'Switched'], [960, 'assistant', null, 'KHAROS-DONE {"status":"ok","pr":null,"branch":"other","summary":"done"}'], [961, 'result', null, 'success is_error=false']];
  assert.equal(at(log(done), 970).state, 'finished');
});

test('classify: an environment error counts only in the current turn and before the first init', () => {
  const late = log([...START, [200, 'env[error]', null, 'Lost connection to the runner'], [210, 'tool_use', 'Bash', '{}']]);
  assert.notEqual(at(late, 220).state, 'failed');
  const old = log([[0, 'user', null, 'x'], [5, 'env[error]', null, 'Clone failed'], [600, 'user', null, 'Try again.'], [610, 'init', null, 'model=x'], [620, 'tool_use', 'Bash', '{}']]);
  assert.equal(at(old, 630).state, 'running');
});

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'k-0001', title: 't', profile: 'p', account: 'a', repo: 'https://github.com/example/demo', revision: 'main', model: 'm', environment: 'env_1', deadline_min: 180,
    instruction_sha256: '', launched_by: null, trigger_id: 'trig_1', session_id: 'cse_1', url: 'https://claude.ai/code/session_1', created_at: new Date(BASE).toISOString(),
    fired_at: null, step: 'open', state: 'running', state_since: new Date(BASE).toISOString(), pending_state: null, last_event_at: null, last_read_at: null, reads: 0,
    read_failures: 0, closed_turns: 0, notice: null, last_notice: null, result: { status: null, pr: null, branch: null, summary: null, question: null },
    extra_outputs: [], pending_cursor: null, cursor_reads: 0, seen_start: true, runs_seen_empty_at: null, closed_at: null, error: null, ...over,
  };
}

test('events: one event per change, a reminder after renotify_min, and back when it clears', () => {
  const s = session();
  const silent: Verdict = { state: 'silent', notice: 'silent', reason: 'no new event for 16 min in an open turn' };
  const first = transition(s, silent, BASE + 60_000, 60, false);
  assert.deepEqual(first.map((e) => [e.event, e.class, e.previous_state]), [['session.silent', 'needs_you', 'running']]);
  assert.match(first[0]!.id, /^k-0001:silent:\d+$/);
  assert.equal(transition(s, silent, BASE + 120_000, 60, false).length, 0);
  assert.equal(transition(s, silent, BASE + 62 * 60_000, 60, false).length, 1);
  const severe = transition(s, { state: 'silent', notice: 'silent_severe', reason: 'r' }, BASE + 63 * 60_000, 60, false);
  assert.equal(severe[0]?.event, 'session.silent_severe');
  const back = transition(s, { state: 'running', notice: null, reason: 'running' }, BASE + 64 * 60_000, 60, false);
  assert.deepEqual(back.map((e) => [e.event, e.class, e.open_notice]), [['session.back', 'progress', 'session.silent_severe']]);
  assert.equal(transition(s, { state: 'running', notice: null, reason: 'running' }, BASE + 65 * 60_000, 60, false).length, 0);
});

test('events: a finish is said once, carries the summary, and tells whether a notice was open', () => {
  const s = session({ result: { status: 'ok', pr: 'https://github.com/example/demo/pull/3', branch: 'fix', summary: 'done\u0007 well', question: null } });
  transition(s, { state: 'waiting_answer', notice: 'waiting_answer', reason: 'q' }, BASE, 60, false);
  const fin = transition(s, { state: 'finished', notice: 'finished', reason: 'the session wrote its end mark' }, BASE + 1000, 60, false);
  assert.equal(fin[0]?.class, 'terminal');
  assert.equal(fin[0]?.summary, 'done well');
  assert.equal(fin[0]?.open_notice, 'session.waiting_answer');
  assert.equal(fin[0]?.pr, 'https://github.com/example/demo/pull/3');
  assert.equal(transition(s, { state: 'finished', notice: 'finished', reason: 'x' }, BASE + 99 * 60_000, 60, false).length, 0);
});

test('events: looping and usage limit count only when two reads agree', () => {
  const s = session();
  const loop: Verdict = { state: 'looping', notice: 'looping', reason: 'r' };
  assert.equal(transition(s, loop, BASE, 60, true).length, 0);
  assert.equal(s.state, 'running');
  assert.equal(transition(s, loop, BASE + 600_000, 60, true).length, 1);
  assert.equal(s.state, 'looping');
});

test('classify: a real permission prompt, with a parallel call answered, waits for the person', () => {
  const page = parseLog(fixture('log-permission-prompt.txt'));
  const prompt = page.events.find((e) => e.kind === 'permission prompt');
  assert.equal(prompt?.tool, 'Bash');
  const now = page.events[page.events.length - 1]!.t + 60_000;
  const v = classify({ events: page.events, seenStart: true, startedAt: page.events[0]!.t, deadlineMin: 30, now, watch: DEFAULT_WATCH });
  assert.equal(v.state, 'waiting_permission');
  // A message from a person queues behind the prompt; it does not answer it.
  const queued = log([[0, 'user', null, 'Skip that step.']]).map((e) => ({ ...e, t: now, ts: new Date(now).toISOString() }));
  assert.equal(classify({ events: [...page.events, ...queued], seenStart: true, startedAt: page.events[0]!.t, deadlineMin: 30, now, watch: DEFAULT_WATCH }).state, 'waiting_permission');
  // The model speaking again means the prompt was answered.
  const moved = [...page.events, { ...queued[0]!, kind: 'assistant', text: 'Skipped.' }];
  assert.notEqual(classify({ events: moved, seenStart: true, startedAt: page.events[0]!.t, deadlineMin: 30, now, watch: DEFAULT_WATCH }).state, 'waiting_permission');
});

test('log: kinds of several words, and MCP tool names', () => {
  const page = parseLog('[2026-11-25T20:20:35.572270Z] permission prompt Bash: {"command":"x"}\n[2026-11-25T20:20:36.000000Z] tool_use mcp__github__create_pull_request: {}\n[2026-11-25T20:20:37.000000Z] user: Mid: run');
  assert.deepEqual(page.events.map((e) => [e.kind, e.tool]), [['permission prompt', 'Bash'], ['tool_use', 'mcp__github__create_pull_request'], ['user', null]]);
  assert.equal(page.events[2]?.text, 'Mid: run');
});

test('classify: an end mark stands when pull request events wake the session and it closes again', () => {
  const done: [number, string, string | null, string][] = [
    ...START,
    [200, 'assistant', null, 'Opened the PR. KHAROS-DONE {"status":"ok","pr":"https://github.com/example/demo/pull/4","branch":"fix","summary":"fixed"}'],
    [201, 'result', null, 'success is_error=false'],
    [202, 'init', null, 'model=x'],
    [203, 'tool_use', 'mcp__github__pull_request_read', '{"method":"get_check_runs"}'],
  ];
  assert.equal(at(log(done), 210).state, 'running');
  const closed = log([...done, [205, 'tool_result', null, '{"total_count":3}'], [206, 'assistant', null, 'CI still running.'], [207, 'result', null, 'success is_error=false']]);
  assert.equal(at(closed, 300).state, 'finished');
});

test('classify: a tool call in the same turn after the end mark keeps the session running', () => {
  const rows: [number, string, string | null, string][] = [
    ...START,
    [200, 'assistant', null, 'KHAROS-DONE {"status":"ok","pr":null,"branch":"fix","summary":"fixed"}'],
    [201, 'tool_use', 'Bash', '{"command":"git push"}'],
  ];
  assert.equal(at(log(rows), 210).state, 'running');
  const closed = log([...rows, [205, 'tool_result', null, 'pushed'], [206, 'assistant', null, 'Pushed.'], [207, 'result', null, 'success is_error=false']]);
  assert.notEqual(at(closed, 300).state, 'finished');
});

test('classify: a question in a turn that events woke after the end mark is waiting for an answer', () => {
  const rows: [number, string, string | null, string][] = [
    ...START,
    [200, 'assistant', null, 'KHAROS-DONE {"status":"ok","pr":"https://github.com/example/demo/pull/4","branch":"fix","summary":"fixed"}'],
    [201, 'result', null, 'success is_error=false'],
    [202, 'init', null, 'model=x'],
    [203, 'assistant', null, 'KHAROS-QUESTION {"question":"CI fails on lint, should I fix it?"}'],
    [204, 'result', null, 'success is_error=false'],
  ];
  assert.equal(at(log(rows), 300).state, 'waiting_answer');
});

test('classify: a question stands when a Stop hook of the repository answers right after it', () => {
  const page = parseLog(fixture('log-stop-hook-question.txt'));
  const v = at(page.events, 0, { now: page.events[page.events.length - 1]!.t + 30_000, startedAt: page.events[0]!.t });
  assert.equal(v.state, 'waiting_answer');
  assert.match(latestMarks(page.events).question ?? '', /pre-push check refused it/);
});

test('classify: an end mark stands when a Stop hook makes the session push before its turn closes', () => {
  const page = parseLog(fixture('log-stop-hook-done.txt'));
  const events = page.events;
  assert.equal(at(events, 0, { now: events[events.length - 1]!.t + 30_000, startedAt: events[0]!.t }).state, 'finished');
  // While the push still runs, the turn is open: not an end yet.
  const pushing = events.slice(0, 7);
  assert.equal(pushing[pushing.length - 1]!.kind, 'tool_use');
  assert.equal(at(pushing, 0, { now: events[6]!.t + 5000, startedAt: events[0]!.t }).state, 'running');
});

test('sinceLastUser: hook feedback and task notifications are not a message from a person', () => {
  const events = log([
    [0, 'user', null, 'Do the work.'],
    [5, 'assistant', null, 'KHAROS-QUESTION {"question":"Which one?"}'],
    [6, 'user', null, 'Stop hook feedback: [command hook]: push first'],
    [7, 'user', null, '<task-notification> <task-id>b1</task-id> completed'],
    [8, 'user', null, 'SubagentStop hook feedback: [command hook]: more'],
  ]);
  assert.equal(sinceLastUser(events).length, 4);
  assert.equal(latestMarks(events).question, 'Which one?');
  const person = log([
    [0, 'assistant', null, 'KHAROS-QUESTION {"question":"Which one?"}'],
    [5, 'user', null, 'The second one. Stop hook feedback: is a phrase too'],
  ]);
  assert.equal(latestMarks(person).question, null);
});

test('classify: once the deadline notice was raised and closed, a session reopened past it is read as usual', () => {
  const events = log([...START, [130, 'tool_use', 'Bash', '{}']]);
  const s = session();
  assert.deepEqual(transition(s, at(events, 181 * 60), BASE + 181 * 60_000, 60, false).map((e) => e.event), ['session.overdue']);
  assert.equal(s.overdue_at, new Date(BASE + 181 * 60_000).toISOString());
  // The overdue notice is still open: the deadline still counts, so it is repeated every renotify_min.
  assert.equal(at(events, 181 * 60, { overdueRaised: false }).state, 'overdue');
  // It was raised, then closed (the session finished and a message woke it): the later checks apply.
  assert.deepEqual(at(events, 181 * 60, { overdueRaised: true }), { state: 'silent', notice: 'silent_severe', reason: 'no new event for 179 min in an open turn' });
  const closed = log([...START, [200, 'assistant', null, 'done'], [201, 'result', null, 'success is_error=false']]);
  assert.equal(at(closed, 201 + 6 * 60 + 181 * 60, { overdueRaised: true }).notice, 'quiet_unmarked');
});

test('classify: the deadline counts from the start it is given', () => {
  const events = log([...START, [130, 'tool_use', 'Bash', '{}']]);
  assert.equal(at(events, 181 * 60).state, 'overdue');
  assert.notEqual(at(events, 181 * 60, { startedAt: BASE + 60 * 60_000 }).state, 'overdue');
});

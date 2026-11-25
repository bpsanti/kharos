import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, normalizeError, sameErrorRun, type Verdict } from '../src/classify.ts';
import { DEFAULT_WATCH } from '../src/config.ts';
import { transition } from '../src/events.ts';
import { parseLog, type LogEvent } from '../src/logparse.ts';
import type { Session } from '../src/registry.ts';
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
  return classify({ events, seenStart: true, createdAt: BASE, deadlineMin: 180, now: BASE + nowSec * 1000, watch: DEFAULT_WATCH, ...over });
}

const START: [number, string, string | null, string][] = [
  [0, 'user', null, 'Fix the typo. --- Protocol ... NUVEM-DONE {"status":"ok|failed","pr":"<url or null>"}'],
  [1, 'env[info]', null, 'Allocating sandbox'],
  [120, 'init', null, 'model=claude-sonnet-5-5 cwd=/home/user/repo'],
];

/** Replays a real log minute by minute, with the reads it had, and returns the states it went through. */
function replay(events: LogEvent[], stepSec: number, extraSec: number, over: Partial<Parameters<typeof classify>[0]> = {}): string[] {
  const t0 = events[0]!.t;
  const t1 = events[events.length - 1]!.t + extraSec * 1000;
  const seen: string[] = [];
  for (let now = t0; now <= t1; now += stepSec * 1000) {
    const v = classify({ events: events.filter((e) => e.t <= now), seenStart: true, createdAt: t0, deadlineMin: 180, now, watch: DEFAULT_WATCH, ...over });
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
  assert.equal(at(firstTurn, 0, { now: Date.parse('2026-11-25T18:58:00Z'), createdAt: firstTurn[0]!.t }).state, 'running');
});

test('classify: a short session ends finished', () => {
  const page = parseLog(fixture('log-write-done.txt'));
  const now = page.events[page.events.length - 1]!.t + 5000;
  assert.equal(classify({ events: page.events, seenStart: true, createdAt: page.events[0]!.t, deadlineMin: 60, now, watch: DEFAULT_WATCH }).state, 'finished');
});

test('classify: a ten-minute foreground command is quiet, not silent', () => {
  const events = log([...START, [130, 'tool_use', 'Bash', '{"command":"cargo test","timeout":600000}'], [721, 'tool_result', null, 'test result: ok']]);
  assert.equal(at(events.slice(0, 4), 720).state, 'running'); // 591 s with no event
  assert.deepEqual(at(events.slice(0, 4), 130 + 16 * 60), { state: 'silent', notice: 'silent', reason: 'no new event for 16 min in an open turn' });
  assert.equal(at(events.slice(0, 4), 130 + 46 * 60).notice, 'silent_severe');
});

test('classify: a closed turn is not an end; it warns only after quiet_end_min', () => {
  const events = log([...START, [200, 'assistant', null, 'waiting for CI'], [201, 'result', null, 'success is_error=false turns=9 — waiting for CI']]);
  assert.deepEqual(at(events, 201 + 627), { state: 'turn_closed', notice: null, reason: 'turn closed' });
  assert.equal(at(events, 201 + 41 * 60).notice, 'quiet_unmarked');
  const woke = log([...START, [200, 'assistant', null, 'waiting'], [201, 'result', null, 'success is_error=false'], [828, 'init', null, 'model=x']]);
  assert.equal(at(woke, 830).state, 'running');
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
  assert.equal(at(log([...START, [300, 'result', null, 'error_during_execution is_error=true']]), 301).state, 'failed');
  assert.equal(at(log([[0, 'user', null, 'x'], [5, 'env[error]', null, 'Clone failed']]), 10).state, 'failed');
  assert.equal(at(log([...START, [300, 'assistant', null, 'NUVEM-DONE {"status":"failed","pr":null,"branch":null,"summary":"tests do not pass"}']]), 301).state, 'failed');
  const perm = log([...START, [130, 'tool_use', 'Bash', '{"command":"git push"}'], [131, 'permission_request', 'Bash', 'git push']]);
  assert.equal(at(perm, 400).state, 'waiting_permission');
  assert.equal(at(log([...START, [130, 'tool_use', 'Bash', '{}'], [131, 'permission_request', 'Bash', 'x'], [200, 'tool_result', null, 'ok']]), 210).state, 'running');
  assert.equal(at(log([...START, [130, 'tool_use', 'Bash', '{}']]), 181 * 60).state, 'overdue');
  assert.equal(at(log([...START, [130, 'result', null, 'error is_error=false — You\'ve hit your usage limit']]), 140).state, 'usage_limit');
  assert.deepEqual(at(log(START.slice(0, 2)), 60), { state: 'provisioning', notice: null, reason: 'provisioning' });
  assert.equal(at(log(START.slice(0, 2)), 16 * 60).notice, 'provisioning_slow');
  // A page that starts in the middle of a session has no init line, and that does not mean provisioning.
  assert.equal(at(log([[0, 'tool_result', null, 'ok']]), 30, { seenStart: false }).state, 'running');
  assert.equal(at(log([...START, [130, 'tool_use', 'AskUserQuestion', '{"questions":[]}']]), 140).state, 'waiting_answer');
});

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'n-0001', title: 't', profile: 'p', account: 'a', repo: 'https://github.com/example/demo', revision: 'main', model: 'm', environment: 'env_1', deadline_min: 180,
    instruction_sha256: '', launched_by: null, trigger_id: 'trig_1', session_id: 'cse_1', url: 'https://claude.ai/code/session_1', created_at: new Date(BASE).toISOString(),
    fired_at: null, step: 'open', state: 'running', state_since: new Date(BASE).toISOString(), pending_state: null, last_event_at: null, last_read_at: null, reads: 0,
    read_failures: 0, closed_turns: 0, notice: null, last_notice: null, result: { status: null, pr: null, branch: null, summary: null, question: null },
    extra_outputs: [], pending_cursor: null, cursor_reads: 0, seen_start: true, closed_at: null, error: null, ...over,
  };
}

test('events: one event per change, a reminder after renotify_min, and back when it clears', () => {
  const s = session();
  const silent: Verdict = { state: 'silent', notice: 'silent', reason: 'no new event for 16 min in an open turn' };
  const first = transition(s, silent, BASE + 60_000, 60, false);
  assert.deepEqual(first.map((e) => [e.event, e.class, e.previous_state]), [['session.silent', 'needs_you', 'running']]);
  assert.match(first[0]!.id, /^n-0001:silent:\d+$/);
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

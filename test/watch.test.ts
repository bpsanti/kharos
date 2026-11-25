import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { readAuthStatus } from '../src/account.ts';
import { readOutbox } from '../src/events.ts';
import { postToolUse, preToolUse, sessionStart, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { loadRegistry } from '../src/registry.ts';
import { due, formatReads, health, passEnd } from '../src/watch.ts';
import { fixture, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
const MIN = 60_000;

function h(ti: Record<string, unknown>, tool_response?: unknown, session = 'launcher'): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: session, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function openOne(sb: Sandbox): string {
  writeConfig(sb);
  const id = prepare(sb.paths, { instruction: 'Fix the typo.', claude_session: 'launcher', now: T0, env: sb.env, heads: () => HEADS_OK }).id;
  const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: TRIG } })));
  preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }));
  postToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }, response(200, { session_id: SID })));
  return id;
}

function readLog(sb: Sandbox, now: number, summary: string, extra: Record<string, unknown> = {}): string {
  const out = postToolUse(sb.ctx(now), h({ action: 'get_run_log', session_id: SID, ...extra }, response(200, { session_id: SID, next_cursor: null }, summary), 'watcher'));
  return (out?.hookSpecificOutput as any)?.updatedToolOutput?.summary ?? '';
}

const account = () => readAuthStatus(sandbox().env)?.account ?? null;

test('watch: a pass lists the due reads, and the watcher may not launch or change a kharos routine', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const r = due(sb.paths, { watcher: 'watcher', all: false, now: T0 + MIN, env: sb.env, account });
  assert.deepEqual(r.reads, [{ session: id, action: 'get_run_log', params: { session_id: SID } }]);
  assert.match(formatReads(r), /- action "get_run_log", session_id "cse_01TESTSESSIONAAAAAAAAAAA"/);
  const next = prepare(sb.paths, { instruction: 'Another fix.', claude_session: 'watcher', now: T0 + MIN, env: sb.env, heads: () => HEADS_OK }).id;
  const decision = (out: ReturnType<typeof preToolUse>) => (out?.hookSpecificOutput as any)?.permissionDecisionReason as string | undefined;
  assert.match(decision(preToolUse(sb.ctx(T0 + 2 * MIN), h({ action: 'create', body: { kharos_launch: next } }, undefined, 'watcher'))) ?? '', /runs \/kharos:watch/);
  assert.match(decision(preToolUse(sb.ctx(T0 + 2 * MIN), h({ action: 'update', trigger_id: TRIG, body: {} }, undefined, 'watcher'))) ?? '', /runs \/kharos:watch/);
  // Routines outside kharos pass untouched, even from the watcher session.
  assert.equal(preToolUse(sb.ctx(T0 + 2 * MIN), h({ action: 'run', trigger_id: 'trig_other' }, undefined, 'watcher')), null);
  assert.equal(preToolUse(sb.ctx(T0 + 2 * MIN), h({ action: 'update', trigger_id: 'trig_other', body: {} }, undefined, 'watcher')), null);
  assert.equal(preToolUse(sb.ctx(T0 + 2 * MIN), h({ action: 'get_run_log', session_id: SID }, undefined, 'watcher')), null);
});

test('watch: a session that stopped watching three intervals ago may launch again', () => {
  const sb = sandbox();
  openOne(sb);
  due(sb.paths, { watcher: 'launcher', all: false, now: T0 + MIN, env: sb.env, account });
  const id = prepare(sb.paths, { instruction: 'Another fix.', claude_session: 'launcher', now: T0 + 2 * MIN, env: sb.env, heads: () => HEADS_OK }).id;
  const create = (now: number) => (preToolUse(sb.ctx(now), h({ action: 'create', body: { kharos_launch: id } }))?.hookSpecificOutput as any).permissionDecision;
  assert.equal(create(T0 + 25 * MIN), 'deny');
  assert.equal(create(T0 + 32 * MIN), 'allow');
});

test('watch: an unreadable watcher file denies run and kharos create', () => {
  const sb = sandbox();
  writeConfig(sb);
  const id = prepare(sb.paths, { instruction: 'Fix the typo.', claude_session: 'launcher', now: T0, env: sb.env, heads: () => HEADS_OK }).id;
  const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: TRIG } })));
  fs.writeFileSync(sb.paths.watch, '[]');
  const ran = preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }))?.hookSpecificOutput as any;
  assert.equal(ran.permissionDecision, 'deny');
  assert.match(ran.permissionDecisionReason, /^kharos: state could not be read \(.*watch\.json\): .*Do not run again; show this to the person\.$/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'routine_created');
  const next = prepare(sb.paths, { instruction: 'Another fix.', claude_session: 'launcher', now: T0, env: sb.env, heads: () => HEADS_OK }).id;
  assert.equal((preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: next } }))?.hookSpecificOutput as any).permissionDecision, 'deny');
});

test('watch: reads follow the cadence, and a session in trouble is read every pass', () => {
  const sb = sandbox();
  openOne(sb);
  readLog(sb, T0 + 2 * MIN, fixture('log-foreground-command.txt'));
  const soon = (min: number) => due(sb.paths, { watcher: 'w', all: false, now: T0 + min * MIN, env: sb.env, account }).reads.length;
  assert.equal(soon(4), 0);
  assert.equal(soon(8), 1);
  // Past 20 minutes, every other pass; --all ignores the cadence.
  const recent = new Date(T0 + 29 * MIN).toISOString().replace('Z', '000Z');
  readLog(sb, T0 + 30 * MIN, fixture('log-foreground-command.txt') + `\n[${recent}] tool_use Bash: {"command":"npm test"}`);
  assert.equal(soon(38), 0);
  assert.equal(soon(46), 1);
  // Quiet for 16 minutes (the newest page repeats the last stored event): the open notice brings the reads back to every pass.
  readLog(sb, T0 + 46 * MIN, `(older events exist: pass next_cursor as cursor)\n[${recent}] tool_use Bash: {"command":"npm test"}`);
  assert.equal(loadRegistry(sb.paths).sessions['k-0001']?.notice?.event, 'session.silent');
  assert.equal(soon(52), 1);
  assert.equal(due(sb.paths, { watcher: null, all: true, now: T0 + 31 * MIN, env: sb.env, account }).reads.length, 1);
});

test('watch: the log read classifies, queues an event, and pass-end reports the change', () => {
  const sb = sandbox();
  const id = openOne(sb);
  due(sb.paths, { watcher: 'w', all: false, now: Date.parse('2026-11-25T19:01:00Z'), env: sb.env, account });
  const page = fixture('log-question-background-done.txt').split('\n').filter((l) => !l.startsWith('[') || l < '[2026-11-25T19:01:00').join('\n');
  const line = readLog(sb, Date.parse('2026-11-25T19:01:00Z'), page);
  assert.match(line, /^kharos: k-0001 waiting answer; \d+ new event\(s\).* Event: session\.waiting_answer\./);
  assert.match(passEnd(sb.paths, { watcher: 'w', now: Date.parse('2026-11-25T19:01:05Z') }), /^watch: k-0001 waiting answer \(waiting answer\)/);
  const events = readOutbox(sb.paths).map((x) => x.event.event);
  assert.deepEqual(events, ['session.opened', 'session.waiting_answer']);
  assert.equal(readOutbox(sb.paths)[1]?.event.question, 'Which word should I use in the summary?');
  due(sb.paths, { watcher: 'w', all: false, now: Date.parse('2026-11-25T19:04:00Z'), env: sb.env, account });
  readLog(sb, Date.parse('2026-11-25T19:04:00Z'), fixture('log-question-background-done.txt'));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'finished');
  assert.deepEqual(readOutbox(sb.paths).map((x) => x.event.event).slice(2), ['session.finished']);
  assert.equal(due(sb.paths, { watcher: 'w', all: false, now: Date.parse('2026-11-25T19:20:00Z'), env: sb.env, account }).open, 0);
  assert.match(passEnd(sb.paths, { watcher: 'w', now: Date.parse('2026-11-25T19:20:05Z') }), /nothing open/);
});

test('watch: a switched login makes the session invisible, never finished', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const r = due(sb.paths, { watcher: 'w', all: false, now: T0 + MIN, env: sb.env, account: () => 'sha256:another' });
  assert.equal(r.reads.length, 0);
  assert.equal(r.events[0]?.event, 'session.invisible');
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'invisible');
});

test('watch: two failed reads in a row make the session invisible', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const nf = response(404, { error: { type: 'not_found_error' } });
  postToolUse(sb.ctx(T0 + MIN), h({ action: 'get_run_log', session_id: SID }, nf));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'provisioning');
  postToolUse(sb.ctx(T0 + 11 * MIN), h({ action: 'get_run_log', session_id: SID }, nf));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'invisible');
});

test('watch: an archived run without an end mark is a terminal event', () => {
  const sb = sandbox();
  const id = openOne(sb);
  postToolUse(sb.ctx(T0 + MIN), h({ action: 'list_runs', trigger_id: TRIG }, response(200, { data: [{ id: SID, status: 'archived' }] })));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'ended_unmarked');
  assert.equal(readOutbox(sb.paths).at(-1)?.event.class, 'terminal');
});

test('watch: an empty log for a session that had events is a failed read', () => {
  const sb = sandbox();
  const id = openOne(sb);
  readLog(sb, T0 + MIN, fixture('log-foreground-command.txt'));
  assert.match(readLog(sb, T0 + 11 * MIN, ''), /log came back empty \(1 failed read/);
  readLog(sb, T0 + 21 * MIN, '');
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'invisible');
});

test('watch: a usage limit that closes the turn with an error counts after two reads', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const page = fixture('log-foreground-command.txt') + `\n[2026-11-25T19:05:00.000000Z] result: error_during_execution is_error=true — You've hit your usage limit`;
  readLog(sb, Date.parse('2026-11-25T19:05:10Z'), page);
  assert.notEqual(loadRegistry(sb.paths).sessions[id]?.state, 'usage_limit');
  readLog(sb, Date.parse('2026-11-25T19:15:10Z'), page);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'usage_limit');
  assert.equal(due(sb.paths, { watcher: 'w', all: false, now: Date.parse('2026-11-25T19:16:00Z'), env: sb.env, account }).open, 1);
});

test('watch: a page that does not reach the last read asks for older pages, two at most', () => {
  const sb = sandbox();
  const id = openOne(sb);
  readLog(sb, T0 + MIN, fixture('log-foreground-command.txt'));
  const older = '(older events exist: pass next_cursor as cursor)';
  const page = (cursor: string, ...lines: string[]) => response(200, { session_id: SID, next_cursor: cursor }, [older, ...lines].join('\n'));
  const read = (now: number, cursor: string | null, answer: Record<string, unknown>) =>
    (postToolUse(sb.ctx(now), h({ action: 'get_run_log', session_id: SID, ...(cursor ? { cursor } : {}) }, answer))?.hookSpecificOutput as any).updatedToolOutput.summary as string;
  assert.match(read(T0 + 20 * MIN, null, page('rl1.a.1', '[2026-11-25T23:00:00.000000Z] tool_use Bash: {"command":"ls"}')), /cursor "rl1\.a\.1"/);
  assert.deepEqual(due(sb.paths, { watcher: 'w', all: false, now: T0 + 21 * MIN, env: sb.env, account }).reads[0]?.params, { session_id: SID, cursor: 'rl1.a.1' });
  // The first older page still does not reach the stored events: one more.
  assert.match(read(T0 + 21 * MIN, 'rl1.a.1', page('rl1.a.2', '[2026-11-25T22:00:00.000000Z] tool_use Bash: {"command":"pwd"}')), /cursor "rl1\.a\.2"/);
  // The second older page does not reach them either, and that is the last one asked for.
  assert.doesNotMatch(read(T0 + 22 * MIN, 'rl1.a.2', page('rl1.a.3', '[2026-11-25T21:00:00.000000Z] tool_use Bash: {"command":"id"}')), /cursor/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.pending_cursor, null);
});

test('watch: an older page that reaches the stored events asks for nothing more', () => {
  const sb = sandbox();
  openOne(sb);
  const first = fixture('log-foreground-command.txt').split('\n');
  readLog(sb, T0 + MIN, first.join('\n'));
  const lastStored = first.filter((l) => l.startsWith('[')).at(-1) as string;
  const out = postToolUse(
    sb.ctx(T0 + 20 * MIN),
    h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: 'rl1.b.1' }, `(older events exist: pass next_cursor as cursor)\n${lastStored}\n[2026-11-25T23:00:00.000000Z] tool_use Bash: {"command":"ls"}`)),
  );
  assert.doesNotMatch((out?.hookSpecificOutput as any).updatedToolOutput.summary, /cursor/);
});

test('health: fails with open sessions and a stale heartbeat, and the session start says so', () => {
  const sb = sandbox();
  assert.equal(health(sb.paths, T0).ok, true);
  openOne(sb);
  assert.match(health(sb.paths, T0).line, /never ran/);
  assert.match((sessionStart(sb.ctx(T0), { hook_event_name: 'SessionStart' }) as any).systemMessage, /watcher never ran/);
  due(sb.paths, { watcher: 'w', all: false, now: T0, env: sb.env, account });
  assert.equal(health(sb.paths, T0 + 20 * MIN).ok, true);
  assert.equal(sessionStart(sb.ctx(T0 + 20 * MIN), { hook_event_name: 'SessionStart' }), null);
  assert.match(health(sb.paths, T0 + 40 * MIN).line, /no watcher heartbeat for 40 min/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOutbox } from '../src/events.ts';
import { postToolUse, preToolUse, sessionStart, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { health } from '../src/follow.ts';
import { isFollowed, loadRegistry } from '../src/registry.ts';
import { readsFor } from '../src/wait.ts';
import { takeLease } from '../src/lease.ts';
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
  const out = postToolUse(sb.ctx(now), h({ action: 'get_run_log', session_id: SID, ...extra }, response(200, { session_id: SID, next_cursor: null }, summary), 'reader'));
  return (out?.hookSpecificOutput as any)?.updatedToolOutput?.summary ?? '';
}

test('reads: a kharos reader may read, but never launch, fire or change a kharos routine', () => {
  const sb = sandbox();
  openOne(sb);
  const reader = (now: number) => ({ ...sb.ctx(now), env: { ...sb.env, KHAROS_ROLE: 'reader' } });
  const next = prepare(sb.paths, { instruction: 'Another fix.', claude_session: 'launcher', now: T0 + MIN, env: sb.env, heads: () => HEADS_OK }).id;
  const decision = (out: ReturnType<typeof preToolUse>) => (out?.hookSpecificOutput as any)?.permissionDecisionReason as string | undefined;
  assert.match(decision(preToolUse(reader(T0 + 2 * MIN), h({ action: 'create', body: { kharos_launch: next } }, undefined, 'reader'))) ?? '', /is a kharos reader, which only reads/);
  assert.match(decision(preToolUse(reader(T0 + 2 * MIN), h({ action: 'update', trigger_id: TRIG, body: {} }, undefined, 'reader'))) ?? '', /is a kharos reader, which only reads/);
  assert.match(decision(preToolUse(reader(T0 + 2 * MIN), h({ action: 'run', trigger_id: TRIG }, undefined, 'reader'))) ?? '', /is a kharos reader, which only reads/);
  // Routines outside kharos pass untouched, even from a reader, and so do reads.
  assert.equal(preToolUse(reader(T0 + 2 * MIN), h({ action: 'run', trigger_id: 'trig_other' }, undefined, 'reader')), null);
  assert.equal(preToolUse(reader(T0 + 2 * MIN), h({ action: 'update', trigger_id: 'trig_other', body: {} }, undefined, 'reader')), null);
  assert.equal(preToolUse(reader(T0 + 2 * MIN), h({ action: 'get_run_log', session_id: SID }, undefined, 'reader')), null);
  // Any other session launches as before.
  assert.equal((preToolUse(sb.ctx(T0 + 2 * MIN), h({ action: 'create', body: { kharos_launch: next } }))?.hookSpecificOutput as any).permissionDecision, 'allow');
});

test('reads: list_runs while the session id is unknown, the log once it is known, and list_runs every sixth read', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.deepEqual(readsFor({ ...s, step: 'firing', session_id: null }), [{ session: id, action: 'list_runs', params: { trigger_id: TRIG } }]);
  assert.deepEqual(readsFor({ ...s, reads: 0 }), [{ session: id, action: 'get_run_log', params: { session_id: SID } }]);
  assert.deepEqual(readsFor({ ...s, reads: 5 }).map((r) => r.action), ['get_run_log', 'list_runs']);
  assert.deepEqual(readsFor({ ...s, trigger_id: null }), []);
});

test('health: fails while an open session has no live follower, and the session start says so', () => {
  const sb = sandbox();
  assert.equal(health(sb.paths, T0).ok, true);
  const id = openOne(sb);
  // Right after the fire, its follower may still be starting.
  assert.equal(health(sb.paths, T0 + 30_000).ok, true);
  const h1 = health(sb.paths, T0 + MIN);
  assert.equal(h1.ok, false);
  assert.match(h1.line, /^kharos: 1 open session\(s\) with no follower: k-0001 "Fix the typo\."\. The next turn end .* kharos follow <id> --detach starts one now\.$/);
  assert.match((sessionStart(sb.ctx(T0 + MIN), { hook_event_name: 'SessionStart' }) as any).systemMessage, /with no follower/);
  assert.ok(takeLease(sb.paths, id, T0 + MIN));
  assert.deepEqual(health(sb.paths, T0 + MIN), { ok: true, line: 'kharos: 1 open session(s), each read by a follower' });
  assert.equal(sessionStart(sb.ctx(T0 + MIN), { hook_event_name: 'SessionStart' }), null);
});

test('reads: a log read classifies and queues an event', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const page = fixture('log-question-background-done.txt').split('\n').filter((l) => !l.startsWith('[') || l < '[2026-11-25T19:01:00').join('\n');
  const line = readLog(sb, Date.parse('2026-11-25T19:01:00Z'), page);
  assert.match(line, /^kharos: k-0001 waiting answer; \d+ new event\(s\).* Event: session\.waiting_answer\./);
  const events = readOutbox(sb.paths).map((x) => x.event.event);
  assert.deepEqual(events, ['session.opened', 'session.waiting_answer']);
  assert.equal(readOutbox(sb.paths)[1]?.event.question, 'Which word should I use in the summary?');
  readLog(sb, Date.parse('2026-11-25T19:04:00Z'), fixture('log-question-background-done.txt'));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'finished');
  assert.deepEqual(readOutbox(sb.paths).map((x) => x.event.event).slice(2), ['session.finished']);
  assert.equal(Object.values(loadRegistry(sb.paths).sessions).filter(isFollowed).length, 0);
});

test('reads: two failed reads in a row make the session invisible', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const nf = response(404, { error: { type: 'not_found_error' } });
  postToolUse(sb.ctx(T0 + MIN), h({ action: 'get_run_log', session_id: SID }, nf));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'provisioning');
  postToolUse(sb.ctx(T0 + 11 * MIN), h({ action: 'get_run_log', session_id: SID }, nf));
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'invisible');
});

const archived = () => response(200, { data: [{ id: SID, status: 'archived' }] });

test('reads: an archived run without an end mark is a terminal event at its next log read', () => {
  const sb = sandbox();
  const id = openOne(sb);
  postToolUse(sb.ctx(Date.parse('2026-11-25T19:02:00Z')), h({ action: 'list_runs', trigger_id: TRIG }, archived(), 'reader'));
  assert.notEqual(loadRegistry(sb.paths).sessions[id]?.state, 'ended_unmarked');
  assert.match(readLog(sb, Date.parse('2026-11-25T19:02:01Z'), fixture('log-foreground-command.txt')), /archived without an end mark/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'ended_unmarked');
  assert.equal(readOutbox(sb.paths).at(-1)?.event.event, 'session.ended_unmarked');
  assert.equal(readOutbox(sb.paths).at(-1)?.event.class, 'terminal');
});

test('reads: an archive check answered before the log that carries KHAROS-DONE still ends the session finished', () => {
  const sb = sandbox();
  const id = openOne(sb);
  // One reader made both calls of a sixth read, and the archive check's answer reached the hook first.
  const at = Date.parse('2026-11-25T19:04:00Z');
  postToolUse(sb.ctx(at), h({ action: 'list_runs', trigger_id: TRIG }, archived(), 'reader'));
  readLog(sb, at, fixture('log-question-background-done.txt'));
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.state, 'finished');
  assert.equal(s.result.summary, 'BANANA AVOCADO');
  const events = readOutbox(sb.paths).map((x) => x.event.event);
  assert.ok(events.includes('session.finished'));
  assert.ok(!events.includes('session.ended_unmarked'));
});

test('reads: an empty log for a session that had events is a failed read', () => {
  const sb = sandbox();
  const id = openOne(sb);
  readLog(sb, T0 + MIN, fixture('log-foreground-command.txt'));
  assert.match(readLog(sb, T0 + 11 * MIN, ''), /log came back empty \(1 failed read/);
  readLog(sb, T0 + 21 * MIN, '');
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'invisible');
});

test('reads: a usage limit that closes the turn with an error counts after two reads', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const page = fixture('log-foreground-command.txt') + `\n[2026-11-25T19:05:00.000000Z] result: error_during_execution is_error=true — You've hit your usage limit`;
  readLog(sb, Date.parse('2026-11-25T19:05:10Z'), page);
  assert.notEqual(loadRegistry(sb.paths).sessions[id]?.state, 'usage_limit');
  readLog(sb, Date.parse('2026-11-25T19:15:10Z'), page);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.state, 'usage_limit');
  assert.ok(isFollowed(loadRegistry(sb.paths).sessions[id]!), 'a usage limit is not an end');
});

test('reads: a page that does not reach the last read asks for older pages, two at most', () => {
  const sb = sandbox();
  const id = openOne(sb);
  readLog(sb, T0 + MIN, fixture('log-foreground-command.txt'));
  const older = '(older events exist: pass next_cursor as cursor)';
  const page = (cursor: string, ...lines: string[]) => response(200, { session_id: SID, next_cursor: cursor }, [older, ...lines].join('\n'));
  const read = (now: number, cursor: string | null, answer: Record<string, unknown>) =>
    (postToolUse(sb.ctx(now), h({ action: 'get_run_log', session_id: SID, ...(cursor ? { cursor } : {}) }, answer))?.hookSpecificOutput as any).updatedToolOutput.summary as string;
  assert.match(read(T0 + 20 * MIN, null, page('rl1.a.1', '[2026-11-25T23:00:00.000000Z] tool_use Bash: {"command":"ls"}')), /cursor "rl1\.a\.1"/);
  assert.deepEqual(readsFor(loadRegistry(sb.paths).sessions[id]!)[0]?.params, { session_id: SID, cursor: 'rl1.a.1' });
  // The first older page still does not reach the stored events: one more.
  assert.match(read(T0 + 21 * MIN, 'rl1.a.1', page('rl1.a.2', '[2026-11-25T22:00:00.000000Z] tool_use Bash: {"command":"pwd"}')), /cursor "rl1\.a\.2"/);
  // The second older page does not reach them either, and that is the last one asked for.
  assert.doesNotMatch(read(T0 + 22 * MIN, 'rl1.a.2', page('rl1.a.3', '[2026-11-25T21:00:00.000000Z] tool_use Bash: {"command":"id"}')), /cursor/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.pending_cursor, null);
});

test('reads: an older page that reaches the stored events asks for nothing more', () => {
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

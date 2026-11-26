// A session whose branch had the permission hook at launch: the hook answers each prompt right away,
// so a prompt alerts only when the next read still finds it open. The log is one recorded with the hook.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOutbox } from '../src/events.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { loadRegistry, updateRegistry, type Session } from '../src/registry.ts';
import { wait, type Reader } from '../src/wait.ts';
import { isDue } from '../src/watch.ts';
import { fixture, HEADS_OK, response, sandbox, writeConfig, type Sandbox } from './helpers.ts';

const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
const MIN = 60_000;
const at = (time: string) => Date.parse(`2026-11-26T${time}Z`);
const LOG = fixture('log-permission-hook.txt');
const LAUNCH = at('03:25:50');

function h(ti: Record<string, unknown>, tool_response?: unknown, session = 'launcher'): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: session, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function openOne(sb: Sandbox, { hook }: { hook: boolean }): string {
  writeConfig(sb);
  const id = prepare(sb.paths, { instruction: 'Check the database.', claude_session: 'launcher', now: LAUNCH, env: sb.env, heads: () => HEADS_OK }).id;
  const pre = preToolUse(sb.ctx(LAUNCH), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(LAUNCH), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: TRIG } })));
  preToolUse(sb.ctx(LAUNCH), h({ action: 'run', trigger_id: TRIG }));
  postToolUse(sb.ctx(LAUNCH), h({ action: 'run', trigger_id: TRIG }, response(200, { session_id: SID })));
  // The tests read hours after the launch: no deadline gets in the way.
  updateRegistry(sb.paths, (reg) => {
    const s = reg.sessions[id]!;
    s.deadline_min = 24 * 60;
    if (hook) s.permission_hook = { allow: ['psql -h 127.0.0.1 -p 5470 -U dev -d postgres -Atc *'], mirror: [] };
  });
  return id;
}

/** The lines of the recorded log written by `time`. */
function pageAt(time: string): string {
  return LOG.split('\n')
    .filter((l) => !l.startsWith('[') || Date.parse(l.slice(1, l.indexOf(']'))) <= at(time))
    .join('\n');
}

function read(sb: Sandbox, time: string, page = pageAt(time), cursor: string | null = null, next: string | null = null): void {
  const ti = { action: 'get_run_log', session_id: SID, ...(cursor ? { cursor } : {}) };
  postToolUse(sb.ctx(at(time)), h(ti, response(200, { session_id: SID, next_cursor: next }, page), 'watcher'));
}

const events = (sb: Sandbox) => readOutbox(sb.paths).map((x) => x.event.event).filter((e) => e !== 'session.opened');
const session = (sb: Sandbox, id: string): Session => loadRegistry(sb.paths).sessions[id]!;

// The first prompt of the log is at 03:26:02.835 and its result at 03:26:03.000; the second prompt is at
// 03:26:03.889 and its refusal at 03:26:03.931.
const FIRST_OPEN = '03:26:02.900';
const SECOND_OPEN = '03:26:03.900';

test('hook alert: a prompt the hook answered before the next read raises no alert', () => {
  const sb = sandbox();
  const id = openOne(sb, { hook: true });
  read(sb, FIRST_OPEN);
  assert.deepEqual(events(sb), []);
  assert.notEqual(session(sb, id).state, 'waiting_permission');
  read(sb, '03:26:03.500');
  assert.deepEqual(events(sb), []);
  assert.equal(session(sb, id).state, 'running');
  assert.equal(session(sb, id).pending_state, null);
});

test('hook alert: a different prompt open on the next read starts its own wait', () => {
  const sb = sandbox();
  openOne(sb, { hook: true });
  read(sb, FIRST_OPEN);
  read(sb, SECOND_OPEN);
  assert.deepEqual(events(sb), []);
  read(sb, '03:26:04.000');
  assert.deepEqual(events(sb), []);
});

test('hook alert: a prompt still open on the next read alerts once, and comes back when it is answered', () => {
  const sb = sandbox();
  const id = openOne(sb, { hook: true });
  read(sb, FIRST_OPEN);
  read(sb, '03:26:20', pageAt(FIRST_OPEN));
  assert.deepEqual(events(sb), ['session.waiting_permission']);
  assert.equal(session(sb, id).state, 'waiting_permission');
  read(sb, '03:27:00', pageAt(FIRST_OPEN));
  read(sb, '03:28:00', pageAt(FIRST_OPEN));
  assert.deepEqual(events(sb), ['session.waiting_permission']);
  // Reported again after renotify_min (60 min by default), on the first read past it.
  read(sb, '04:27:00', pageAt(FIRST_OPEN));
  assert.deepEqual(events(sb), ['session.waiting_permission', 'session.waiting_permission']);
  read(sb, '04:28:00', `${pageAt(FIRST_OPEN)}\n[2026-11-26T04:27:59.000000Z] assistant: The call went through.`);
  assert.deepEqual(events(sb), ['session.waiting_permission', 'session.waiting_permission', 'session.back']);
});

test('hook alert: without the hook the first read that sees the prompt alerts', () => {
  const sb = sandbox();
  openOne(sb, { hook: false });
  read(sb, FIRST_OPEN);
  assert.deepEqual(events(sb), ['session.waiting_permission']);
});

test('hook alert: an older page read between two reads does not confirm a prompt', () => {
  const sb = sandbox();
  openOne(sb, { hook: true });
  // The newest page does not reach the stored events, so an older page is read next.
  read(sb, '03:26:01', '[2026-11-26T03:26:00.010192Z] init: model=claude-haiku-5-5 cwd=/home/user/demo');
  const newest = `(older events exist)\n${pageAt(FIRST_OPEN).split('\n').filter((l) => /\] (?:tool_use|permission prompt) /.test(l)).join('\n')}`;
  read(sb, '03:26:02.900', newest, null, 'older');
  read(sb, '03:26:08', '[2026-11-26T03:26:01.000000Z] assistant: Looking at the database.', 'older');
  assert.deepEqual(events(sb), []);
  read(sb, '03:26:20', newest);
  assert.deepEqual(events(sb), ['session.waiting_permission']);
});

test('hook alert: the watcher reads a session with a prompt waiting to be confirmed on its next pass', () => {
  const sb = sandbox();
  const id = openOne(sb, { hook: true });
  // Old enough to be read every second pass only.
  updateRegistry(sb.paths, (reg) => {
    reg.sessions[id]!.created_at = '2026-11-26T02:00:00.000Z';
  });
  read(sb, FIRST_OPEN);
  assert.equal(isDue(session(sb, id), at(FIRST_OPEN) + 6 * MIN, 10), true);
  read(sb, '03:26:03.500');
  assert.equal(isDue(session(sb, id), at('03:26:03.500') + 6 * MIN, 10), false);
});

/** A follower on a clock of its own; `pages` gives the page of each read in turn, the last one for good. */
function follow(sb: Sandbox, pages: string[]) {
  let t = at('03:26:02.900');
  let reads = 0;
  const reader: Reader = async (_paths, r, _env, now) => {
    if (r.action === 'get_run_log') {
      const page = pages[Math.min(reads++, pages.length - 1)]!;
      postToolUse(sb.ctx(now), h({ action: 'get_run_log', ...r.params }, response(200, { session_id: SID, next_cursor: null }, page), 'reader'));
    } else {
      postToolUse(sb.ctx(now), h({ action: 'list_runs', ...r.params }, response(200, { data: [{ id: SID, status: 'running' }] }), 'reader'));
    }
    return { ok: true, cost_usd: 0, error: null };
  };
  return wait(sb.paths, {
    id: 'k-0001',
    since: null,
    maxMs: 3 * MIN,
    minIntervalMs: 15_000,
    maxIntervalMs: 60_000,
    env: sb.env,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    read: reader,
    account: () => session(sb, 'k-0001').account,
  });
}

test('hook alert: a follower is not woken for a prompt the hook resolves', async () => {
  const sb = sandbox();
  openOne(sb, { hook: true });
  const o = await follow(sb, [pageAt(FIRST_OPEN), pageAt('03:26:03.500')]);
  assert.equal(o.changed, false);
  assert.equal(o.key, 'ok');
  assert.deepEqual(events(sb), []);
});

test('hook alert: a follower is woken by a prompt the next read still finds open', async () => {
  const sb = sandbox();
  openOne(sb, { hook: true });
  const o = await follow(sb, [pageAt(FIRST_OPEN)]);
  assert.equal(o.changed, true);
  assert.equal(o.state, 'waiting_permission');
  assert.deepEqual(o.permission, { tool: 'Bash' });
  assert.equal(o.reads, 2);
  assert.equal(o.waited_s, 15);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classify } from '../src/classify.ts';
import { DEFAULT_WATCH } from '../src/config.ts';
import { readOutbox, type KharosEvent } from '../src/events.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { parseLog } from '../src/logparse.ts';
import { statusLine } from '../src/outputs/firstmate.ts';
import { deliver } from '../src/outputs/index.ts';
import { loadRegistry } from '../src/registry.ts';
import { fixture, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
const MIN = 60_000;

function h(ti: Record<string, unknown>, tool_response?: unknown, session = 'launcher'): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: session, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function openOne(sb: Sandbox, now: number): string {
  writeConfig(sb);
  const id = prepare(sb.paths, { instruction: 'Check the database.', claude_session: 'launcher', now, env: sb.env, heads: () => HEADS_OK }).id;
  const pre = preToolUse(sb.ctx(now), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(now), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: TRIG } })));
  preToolUse(sb.ctx(now), h({ action: 'run', trigger_id: TRIG }));
  postToolUse(sb.ctx(now), h({ action: 'run', trigger_id: TRIG }, response(200, { session_id: SID })));
  return id;
}

/** The fixture cut at an instant, as a read at that instant would see it. */
function pageUntil(name: string, iso: string): string {
  const until = Date.parse(iso);
  return fixture(name)
    .split('\n')
    .filter((l) => {
      const m = l.match(/^\[([^\]]+)\]/);
      return !m || Date.parse(m[1] as string) <= until;
    })
    .join('\n');
}

function read(sb: Sandbox, now: number, summary: string): void {
  postToolUse(sb.ctx(now), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, summary), 'watcher'));
}

function permissionEvents(sb: Sandbox): KharosEvent[] {
  return readOutbox(sb.paths).map((x) => x.event).filter((e) => e.event === 'session.waiting_permission' || e.event === 'session.back');
}

test('permission: the classifier names the tool of a real prompt', () => {
  const page = parseLog(fixture('log-permission-prompt.txt'));
  const now = page.events[page.events.length - 1]!.t + 4 * MIN;
  const v = classify({ events: page.events, seenStart: true, createdAt: page.events[0]!.t, deadlineMin: 30, now, watch: DEFAULT_WATCH });
  assert.equal(v.state, 'waiting_permission');
  assert.equal(v.reason, 'permission request for Bash with no answer for 5 min');
  assert.equal(v.permission?.tool, 'Bash');
  assert.doesNotMatch(JSON.stringify(v), /kharos-probe/);
});

test('permission: one alert per prompt with the session link, a new alert for a new prompt, and back when it moves on', async () => {
  const sb = sandbox();
  const start = Date.parse('2026-11-25T21:00:00Z');
  const id = openOne(sb, start);
  const file = 'log-permission-two-prompts.txt';

  read(sb, Date.parse('2026-11-25T21:04:00Z'), pageUntil(file, '2026-11-25T21:04:00Z'));
  let evs = permissionEvents(sb);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.event, 'session.waiting_permission');
  assert.equal(evs[0]?.class, 'needs_you');
  assert.equal(evs[0]?.url, 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA');
  assert.deepEqual(evs[0]?.permission, { tool: 'Bash' });
  assert.equal(evs[0]?.reason, 'permission request for Bash with no answer for 4 min');

  // The same prompt on the next passes: no new alert.
  read(sb, Date.parse('2026-11-25T21:08:00Z'), pageUntil(file, '2026-11-25T21:08:00Z'));
  read(sb, Date.parse('2026-11-25T21:11:00Z'), pageUntil(file, '2026-11-25T21:11:00Z'));
  assert.equal(permissionEvents(sb).length, 1);

  // Answered, and a second prompt opened before the next read: a new alert right away.
  read(sb, Date.parse('2026-11-25T21:14:00Z'), pageUntil(file, '2026-11-25T21:14:00Z'));
  evs = permissionEvents(sb);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[1]?.permission, { tool: 'Bash' });
  assert.doesNotMatch(JSON.stringify(readOutbox(sb.paths)), /s3cr3t|ghp_|psql|git push|db\.example/);

  // The session moved on: the notice clears once.
  read(sb, Date.parse('2026-11-25T21:21:00Z'), pageUntil(file, '2026-11-25T21:21:00Z'));
  evs = permissionEvents(sb);
  assert.deepEqual(evs.map((e) => e.event), ['session.waiting_permission', 'session.waiting_permission', 'session.back']);
  assert.equal(evs[2]?.permission, undefined);
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.permission, null);
  assert.equal(s.notice, null);

  // Delivered through the configured outputs like every other needs_you event.
  writeConfig(sb, { outputs: [{ type: 'file', path: '{state}/events.jsonl', events: ['needs_you'] }] });
  await deliver({ paths: sb.paths, env: sb.env, now: Date.parse('2026-11-25T21:21:00Z'), platform: 'aix', inHook: false });
  const lines = fs.readFileSync(path.join(sb.paths.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as KharosEvent);
  assert.deepEqual(lines.map((e) => [e.permission?.tool, e.url]), [['Bash', 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA'], ['Bash', 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA']]);
  assert.doesNotMatch(fs.readFileSync(path.join(sb.paths.state, 'events.jsonl'), 'utf8'), /s3cr3t|ghp_|psql|git push|db\.example/);
});

test('permission: a prompt still open after renotify_min is reported again', () => {
  const sb = sandbox();
  openOne(sb, Date.parse('2026-11-25T21:00:00Z'));
  const file = 'log-permission-two-prompts.txt';
  const page = pageUntil(file, '2026-11-25T21:10:00Z');
  read(sb, Date.parse('2026-11-25T21:04:00Z'), page);
  read(sb, Date.parse('2026-11-25T22:03:00Z'), page);
  assert.equal(permissionEvents(sb).length, 1);
  read(sb, Date.parse('2026-11-25T22:05:00Z'), page);
  assert.equal(permissionEvents(sb).length, 2);
});

test('permission: the firstmate line and the Slack text name the tool and link the session', async () => {
  const ev: KharosEvent = {
    schema: 'kharos.event.v1', id: 'k-0001:waiting_permission:1', event: 'session.waiting_permission', class: 'needs_you', session: 'k-0001',
    title: 'check the db', state: 'waiting_permission', previous_state: 'running', since: '2026-11-25T21:00:07Z', at: '2026-11-25T21:04:00Z',
    url: 'https://claude.ai/code/session_01X', repo: 'example/demo', pr: null, branch: null, reason: 'permission request for Bash with no answer for 4 min', open_notice: null,
    permission: { tool: 'Bash' },
  };
  assert.equal(
    statusLine(ev, 'shared', Date.parse('2026-11-25T21:04:00Z'), null),
    'blocked [key=kharos-k-0001] [at=1795640640]: kharos k-0001 waiting permission: permission request for Bash with no answer for 4 min https://claude.ai/code/session_01X',
  );
  const sb = sandbox();
  writeConfig(sb, { outputs: [{ type: 'slack' }] });
  const { enqueue } = await import('../src/events.ts');
  enqueue(sb.paths, [ev]);
  const posts: string[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    posts.push(String(init.body));
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  await deliver({ paths: sb.paths, env: { ...sb.env, CLAUDE_PLUGIN_OPTION_SLACK_WEBHOOK: 'https://hooks.slack.com/services/T0/B0/x' }, now: T0, platform: 'aix', inHook: true, fetch: fakeFetch });
  const text = JSON.parse(posts[0]!).text as string;
  assert.match(text, /waiting permission: permission request for Bash with no answer for 4 min/);
  assert.match(text, /https:\/\/claude\.ai\/code\/session_01X$/);
});

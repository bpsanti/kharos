import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classify } from '../src/classify.ts';
import { DEFAULT_WATCH } from '../src/config.ts';
import { readOutbox, type KharosEvent } from '../src/events.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import type { Forge } from '../src/forge.ts';
import { parseLog, type LogEvent } from '../src/logparse.ts';
import { categorize, categoryText, NO_RULES, type AskRules } from '../src/permission-request.ts';
import { preflight } from '../src/permissions.ts';
import { recentRepoRules, recordRepoRules, REPO_RULES_TTL_MS } from '../src/repo.ts';
import { statusLine } from '../src/outputs/firstmate.ts';
import { deliver } from '../src/outputs/index.ts';
import { loadRegistry, updateRegistry } from '../src/registry.ts';
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
  const v = classify({ events: page.events, seenStart: true, startedAt: page.events[0]!.t, deadlineMin: 30, now, watch: DEFAULT_WATCH });
  assert.equal(v.state, 'waiting_permission');
  assert.equal(v.reason, 'permission request for Bash (a reason kharos cannot tell) with no answer for 5 min');
  assert.equal(v.permission?.category, 'unknown');
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
  assert.deepEqual(evs[0]?.permission, { tool: 'Bash', category: 'unknown' });
  assert.equal(evs[0]?.reason, 'permission request for Bash (a reason kharos cannot tell) with no answer for 4 min');

  // The same prompt on the next passes: no new alert.
  read(sb, Date.parse('2026-11-25T21:08:00Z'), pageUntil(file, '2026-11-25T21:08:00Z'));
  read(sb, Date.parse('2026-11-25T21:11:00Z'), pageUntil(file, '2026-11-25T21:11:00Z'));
  assert.equal(permissionEvents(sb).length, 1);

  // Answered, and a second prompt opened before the next read: a new alert right away.
  read(sb, Date.parse('2026-11-25T21:14:00Z'), pageUntil(file, '2026-11-25T21:14:00Z'));
  evs = permissionEvents(sb);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[1]?.permission, { tool: 'Bash', category: 'unknown' });
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
  writeConfig(sb, { outputs: [{ type: 'file', path: '{state}/out.jsonl', events: ['needs_you'] }] });
  await deliver({ paths: sb.paths, env: sb.env, now: Date.parse('2026-11-25T21:21:00Z'), platform: 'aix', inHook: false });
  const lines = fs.readFileSync(path.join(sb.paths.state, 'out.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as KharosEvent);
  assert.deepEqual(lines.map((e) => [e.permission?.tool, e.url]), [['Bash', 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA'], ['Bash', 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA']]);
  assert.doesNotMatch(fs.readFileSync(path.join(sb.paths.state, 'out.jsonl'), 'utf8'), /s3cr3t|ghp_|psql|git push|db\.example/);
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

test('permission: an open prompt recorded before the permission field existed is not reported again before renotify_min', () => {
  const sb = sandbox();
  const id = openOne(sb, Date.parse('2026-11-25T21:00:00Z'));
  const page = pageUntil('log-permission-two-prompts.txt', '2026-11-25T21:10:00Z');
  read(sb, Date.parse('2026-11-25T21:04:00Z'), page);
  assert.equal(permissionEvents(sb).length, 1);
  updateRegistry(sb.paths, (reg) => {
    delete reg.sessions[id]!.permission;
  });
  read(sb, Date.parse('2026-11-25T21:06:00Z'), page);
  assert.equal(permissionEvents(sb).length, 1);
  assert.equal(loadRegistry(sb.paths).sessions[id]!.permission?.tool, 'Bash');
});

test('permission: the firstmate line and the Slack text name the tool and link the session', async () => {
  const ev: KharosEvent = {
    schema: 'kharos.event.v1', id: 'k-0001:waiting_permission:1', event: 'session.waiting_permission', class: 'needs_you', session: 'k-0001',
    title: 'check the db', state: 'waiting_permission', previous_state: 'running', since: '2026-11-25T21:00:07Z', at: '2026-11-25T21:04:00Z',
    url: 'https://claude.ai/code/session_01X', repo: 'example/demo', pr: null, branch: null, reason: 'permission request for Bash with no answer for 4 min', open_notice: null,
    permission: { tool: 'Bash', category: 'org_ask_rule' },
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

function ev(kind: string, tool: string | null, text: string, i: number): LogEvent {
  const ts = new Date(T0 + i * 1000).toISOString();
  return { t: T0 + i * 1000, ts, kind, tool, text, truncated: false, key: `${ts}|${kind}`, seq: i };
}

function promptAfter(before: LogEvent[], tool: string, input: Record<string, unknown>): { events: LogEvent[]; index: number } {
  const events = [...before, ev('tool_use', tool, JSON.stringify(input), before.length), ev('permission prompt', tool, JSON.stringify(input), before.length + 1)];
  return { events, index: events.length - 1 };
}

test('permission: the category comes from the ask rules, the classifier blocks, then Claude Code checks', () => {
  const rules = { org: ['Bash(psql:*)', 'WebFetch'], repo: ['Bash(git push:*)', 'Bash(make deploy)'] };
  const cat = (tool: string, input: Record<string, unknown>, before: LogEvent[] = [], r: AskRules = rules) => {
    const p = promptAfter(before, tool, input);
    return categorize(p.events, p.index, r);
  };
  // An ask rule matches past the assignments in front and in any part of a compound command.
  assert.equal(cat('Bash', { command: "PGPASSWORD=x psql -h db -c 'select 1'" }), 'org_ask_rule');
  assert.equal(cat('Bash', { command: 'cd /tmp && psql -c "select 1"' }), 'org_ask_rule');
  assert.equal(cat('WebFetch', { url: 'https://example.com' }), 'org_ask_rule');
  assert.equal(cat('Bash', { command: 'git push origin HEAD:work' }), 'repo_ask_rule');
  assert.equal(cat('Bash', { command: 'make deploy' }), 'repo_ask_rule');
  // The organization's rule is above the repository's.
  assert.equal(cat('Bash', { command: 'git push' }, [], { org: ['Bash(git:*)'], repo: ['Bash(git push:*)'] }), 'org_ask_rule');
  // After blocked calls in a row, the prompt is the classifier's.
  const blocked = (i: number) => [ev('tool_use', 'Bash', '{"command":"curl x"}', i), ev('tool_result', null, 'ERROR: Permission for this action was denied by the auto mode classifier', i + 1)];
  assert.equal(cat('Bash', { command: 'curl y' }, [...blocked(0), ...blocked(2)]), 'classifier_block');
  assert.equal(cat('Bash', { command: 'curl y' }, [...blocked(0), ev('tool_result', null, 'ok', 2), ...blocked(3)]), 'unknown', 'one block is not a row');
  // Claude Code's own checks: text it cannot check, and protected files.
  assert.equal(cat('Bash', { command: 'echo $(date)' }), 'claude_code_check');
  assert.equal(cat('Bash', { command: 'grep --"include"=x foo' }), 'claude_code_check');
  assert.equal(cat('Bash', { command: "printf $'\\x41'" }), 'claude_code_check');
  assert.equal(cat('Write', { file_path: '/home/user/demo/.git/config', content: 'x' }), 'claude_code_check');
  assert.equal(cat('Edit', { file_path: '/home/user/demo/.claude/settings.json' }), 'claude_code_check');
  assert.equal(cat('Read', { file_path: '/home/user/$HOME/x' }), 'claude_code_check');
  // Nothing explains it, or no rule could be read.
  assert.equal(cat('Bash', { command: 'ls -la' }), 'unknown');
  assert.equal(cat('Bash', { command: 'psql -c "select 1"' }, [], NO_RULES), 'unknown');
  assert.equal(cat('Write', { file_path: '/home/user/demo/src/a.ts' }), 'unknown');
  // A line the service cut: a whole command still matches, a cut one does not.
  const cut = [ev('permission prompt', 'Bash', '{"command":"psql -c 1","description":"a very long… [+200 chars]', 0)];
  assert.equal(categorize(cut, 0, rules), 'org_ask_rule');
  const cutCommand = [ev('permission prompt', 'Bash', '{"command":"psql -c \'select… [+200 chars]', 0)];
  assert.equal(categorize(cutCommand, 0, rules), 'unknown');
  assert.equal(categoryText(undefined), 'a reason kharos cannot tell');
});

test('permission: an alert names the category of the organization or the repository rule, and never the command', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.claude', 'remote-settings.json'), JSON.stringify({ permissions: { ask: ['Bash(psql:*)'] } }));
  const start = Date.parse('2026-11-25T21:00:00Z');
  // The launch preflight read the repository's ask rules on the branch, so the launch keeps them.
  writeConfig(sb);
  const out = preflight(sb.paths, { dir: null, instruction: 'Check the database.', forge: { snapshot: () => ({ ok: true, snapshot: { label: 'example/demo@main', paths: ['.claude/settings.json'], files: new Map([['.claude/settings.json', '{"permissions":{"ask":["Bash(git push:*)"]}}']]), unreadable: new Set(), base: null } }) } as unknown as Forge, now: start }, sb.env);
  assert.match(out, /git push|prompt/);
  const id = openOne(sb, start);
  assert.deepEqual(loadRegistry(sb.paths).sessions[id]?.repo_ask, ['Bash(git push:*)']);

  const file = 'log-permission-two-prompts.txt';
  read(sb, Date.parse('2026-11-25T21:04:00Z'), pageUntil(file, '2026-11-25T21:04:00Z'));
  read(sb, Date.parse('2026-11-25T21:14:00Z'), pageUntil(file, '2026-11-25T21:14:00Z'));
  const evs = permissionEvents(sb).filter((e) => e.event === 'session.waiting_permission');
  assert.deepEqual(evs.map((e) => e.permission), [{ tool: 'Bash', category: 'org_ask_rule' }, { tool: 'Bash', category: 'repo_ask_rule' }]);
  assert.match(evs[0]!.reason, /^permission request for Bash \(an ask rule of the organization\) with no answer for 4 min$/);
  assert.match(evs[1]!.reason, /\(an ask rule of the repository\)/);
  assert.doesNotMatch(JSON.stringify(readOutbox(sb.paths)), /s3cr3t|ghp_|psql|git push|db\.example/);
  const line = statusLine(evs[0]!, 'shared', start, null);
  assert.match(line ?? '', /permission request for Bash \(an ask rule of the organization\)/);
});

test('permission: an old reading of the repository rules is not used, and none is kept when the branch cannot be read', () => {
  const sb = sandbox();
  recordRepoRules(sb.paths, 'https://github.com/example/demo', 'main', ['Bash(git push:*)'], T0 - REPO_RULES_TTL_MS - 1);
  assert.equal(recentRepoRules(sb.paths, 'https://github.com/example/demo', 'main', T0), null);
  recordRepoRules(sb.paths, 'example/demo', 'main', ['Bash(git push:*)'], T0);
  assert.deepEqual(recentRepoRules(sb.paths, 'https://github.com/example/demo', 'main', T0 + 1000), ['Bash(git push:*)']);
  assert.equal(recentRepoRules(sb.paths, 'https://github.com/example/demo', 'other', T0 + 1000), null);
});

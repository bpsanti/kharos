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
import { redact, REQUEST_MAX, summarizeRequest } from '../src/permission-request.ts';
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

test('permission: redaction takes out environment assignments, credentials and tokens', () => {
  assert.equal(redact("PGPASSWORD=s3cr3t psql -h db -c 'select 1'"), "PGPASSWORD=… psql -h db -c 'select 1'");
  assert.equal(redact('export TOKEN="a b c" && env API_KEY=xyz make deploy'), 'export TOKEN=… && env API_KEY=… make deploy');
  assert.equal(redact('cd app; DEBUG=1 FOO=bar npm test'), 'cd app; DEBUG=… FOO=… npm test');
  assert.equal(redact('git push https://bot:hunter2@github.com/o/r.git'), 'git push https://…@github.com/o/r.git');
  assert.equal(redact('curl -H "Authorization: Bearer abc.def.ghi" https://api.example.test/v1/x?token=abc&b=2'), 'curl -H "Authorization: …" https://api.example.test/v1/x?…');
  assert.equal(redact('mysql --password=hunter2 --user app'), 'mysql --password=… --user app');
  assert.equal(redact('gh secret set X --body ghp_abcdefghijklmnopqrstuvwxyz0123'), 'gh secret set X --body …');
  assert.equal(redact('echo aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgc2VjcmV0MTIz'), 'echo …');
  // What is not a secret stays readable.
  assert.equal(redact('git commit --author "A <a@example.test>" -m "fix the panel limit"'), 'git commit --author "A <a@example.test>" -m "fix the panel limit"');
  assert.equal(redact('cat src/components/settings/permissions/profile_editor.tsx'), 'cat src/components/settings/permissions/profile_editor.tsx');
});

test('permission: the summary reads only the fields that name the action, and is capped', () => {
  assert.equal(summarizeRequest('Bash', '{"command":"cat .kharos-probe/ask.txt","description":"Print it"}'), 'cat .kharos-probe/ask.txt');
  assert.equal(summarizeRequest('Write', '{"file_path":"/home/user/demo/notes.md","content":"PGPASSWORD=x"}'), '/home/user/demo/notes.md');
  assert.equal(summarizeRequest('Grep', '{"pattern":"TODO","path":"src"}'), 'TODO in src');
  assert.equal(summarizeRequest('WebFetch', '{"url":"https://example.test/a?key=1","prompt":"read"}'), 'https://example.test/a?…');
  assert.equal(summarizeRequest('mcp__github__create_issue', '{"owner":"o","repo":"r","body":"secret text"}'), 'input fields: owner, repo, body');
  // The service cuts a long event: the field is read up to the cut, and the cut shows.
  const cut = `{"command":"PGPASSWORD=abc psql -c '${'x'.repeat(980)}… [+2048 chars]`;
  const s = summarizeRequest('Bash', cut);
  assert.ok(s.startsWith("PGPASSWORD=… psql -c 'xxx"), s);
  assert.ok(s.length <= REQUEST_MAX);
  assert.ok(s.endsWith('…'));
  assert.equal(summarizeRequest('Bash', 'not json'), '');
  // Control characters never reach a notice.
  assert.equal(summarizeRequest('Bash', '{"command":"echo a\\u001b[31m\\nb"}'), 'echo a [31m b');
});

test('permission: the classifier names the tool and the request of a real prompt', () => {
  const page = parseLog(fixture('log-permission-prompt.txt'));
  const now = page.events[page.events.length - 1]!.t + 4 * MIN;
  const v = classify({ events: page.events, seenStart: true, createdAt: page.events[0]!.t, deadlineMin: 30, now, watch: DEFAULT_WATCH });
  assert.equal(v.state, 'waiting_permission');
  assert.equal(v.reason, 'permission request for Bash with no answer for 5 min');
  assert.equal(v.permission?.tool, 'Bash');
  assert.equal(v.permission?.request, 'cat .kharos-probe/ask.txt');
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
  assert.deepEqual(evs[0]?.permission, { tool: 'Bash', request: "PGPASSWORD=… psql -h db.example.test -U app -c 'select count(*) from farms'" });
  assert.equal(evs[0]?.reason, 'permission request for Bash with no answer for 4 min');

  // The same prompt on the next passes: no new alert.
  read(sb, Date.parse('2026-11-25T21:08:00Z'), pageUntil(file, '2026-11-25T21:08:00Z'));
  read(sb, Date.parse('2026-11-25T21:11:00Z'), pageUntil(file, '2026-11-25T21:11:00Z'));
  assert.equal(permissionEvents(sb).length, 1);

  // Answered, and a second prompt opened before the next read: a new alert right away.
  read(sb, Date.parse('2026-11-25T21:14:00Z'), pageUntil(file, '2026-11-25T21:14:00Z'));
  evs = permissionEvents(sb);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[1]?.permission, { tool: 'Bash', request: 'git push https://…@github.com/example/demo.git HEAD:work' });
  assert.doesNotMatch(JSON.stringify(readOutbox(sb.paths)), /s3cr3t|ghp_/);

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
  assert.deepEqual(lines.map((e) => e.permission?.request), ["PGPASSWORD=… psql -h db.example.test -U app -c 'select count(*) from farms'", 'git push https://…@github.com/example/demo.git HEAD:work']);
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

test('permission: the firstmate line and the Slack text name the tool and the request', async () => {
  const ev: KharosEvent = {
    schema: 'kharos.event.v1', id: 'k-0001:waiting_permission:1', event: 'session.waiting_permission', class: 'needs_you', session: 'k-0001',
    title: 'check the db', state: 'waiting_permission', previous_state: 'running', since: '2026-11-25T21:00:07Z', at: '2026-11-25T21:04:00Z',
    url: 'https://claude.ai/code/session_01X', repo: 'example/demo', pr: null, branch: null, reason: 'permission request for Bash with no answer for 4 min', open_notice: null,
    permission: { tool: 'Bash', request: 'echo <!channel> && PGPASSWORD=… psql' },
  };
  assert.equal(
    statusLine(ev, 'shared', Date.parse('2026-11-25T21:04:00Z'), null),
    'blocked [key=kharos-k-0001] [at=1795640640]: kharos k-0001 waiting permission: permission request for Bash with no answer for 4 min (Bash: echo <!channel> && PGPASSWORD=… psql) https://claude.ai/code/session_01X',
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
  assert.match(text, /asks for Bash: echo &lt;!channel&gt; &amp;&amp; PGPASSWORD=… psql/);
  assert.match(text, /https:\/\/claude\.ai\/code\/session_01X$/);
});

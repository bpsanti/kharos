import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { launchOutputs, parseArgs } from '../src/cli.ts';
import { enqueue, readOutbox, type NuvemEvent } from '../src/events.ts';
import { checkTarget, statusLine, writeStatus } from '../src/outputs/firstmate.ts';
import { deliver, loadUndelivered, matches, MAX_ATTEMPTS, type SendCtx } from '../src/outputs/index.ts';
import { sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

function event(over: Partial<NuvemEvent> = {}): NuvemEvent {
  return {
    schema: 'nuvem.event.v1', id: 'n-0001:waiting_permission:1795632264', event: 'session.waiting_permission', class: 'needs_you', session: 'n-0001',
    title: 'fix the typo', state: 'waiting_permission', previous_state: 'running', since: '2026-11-25T18:40:00Z', at: '2026-11-25T18:44:10Z',
    url: 'https://claude.ai/code/session_01X', repo: 'example/demo', pr: null, branch: null, reason: 'permission request with no answer for 4 min', open_notice: null, ...over,
  };
}

function ctx(sb: Sandbox, over: Partial<SendCtx> = {}): SendCtx {
  return { paths: sb.paths, env: sb.env, now: T0, platform: 'aix', inHook: true, ...over };
}

/** A firstmate home with one task status file and a ledger script that records its call. */
function fmHome(sb: Sandbox, ledger = true): { home: string; status: string } {
  const home = path.join(sb.dir, 'fm');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const status = path.join(home, 'state', 'task.status');
  fs.writeFileSync(status, '');
  if (ledger) fs.writeFileSync(path.join(home, 'config', 'fleet-ledger'), '');
  fs.writeFileSync(path.join(home, 'bin', 'fm-fleet-ledger.sh'), `#!/bin/sh\necho "$@" >> "${home}/ledger-calls"\n`, { mode: 0o755 });
  return { home, status };
}

test('outputs: event filters take classes, names, short names and *', () => {
  const ev = event();
  assert.ok(matches(['*'], ev));
  assert.ok(matches(['needs_you'], ev));
  assert.ok(matches(['session.waiting_permission'], ev));
  assert.ok(matches(['waiting_permission'], ev));
  assert.ok(!matches(['terminal', 'progress'], ev));
});

test('outputs: file and command receive each event once', async () => {
  const sb = sandbox();
  const script = path.join(sb.dir, 'receiver.sh');
  fs.writeFileSync(script, `#!/bin/sh\ncat >> "${sb.dir}/received.jsonl"\n`, { mode: 0o755 });
  writeConfig(sb, { outputs: [{ type: 'file', path: '{state}/events.jsonl' }, { type: 'command', argv: [script], events: ['needs_you'] }] });
  enqueue(sb.paths, [event(), event({ id: 'n-0001:opened:1', event: 'session.opened', class: 'progress' })]);
  const r = await deliver(ctx(sb));
  assert.deepEqual([r.sent, r.failed], [3, 0]);
  assert.equal(fs.readFileSync(path.join(sb.paths.state, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
  const got = fs.readFileSync(`${sb.dir}/received.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(got.map((e) => e.event), ['session.waiting_permission']);
  assert.equal(readOutbox(sb.paths).length, 0);
  assert.equal((await deliver(ctx(sb))).sent, 0);
});

test('outputs: a failing output is tried again, five times at most, and then shown', async () => {
  const sb = sandbox();
  writeConfig(sb, { outputs: [{ type: 'command', argv: ['/bin/sh', '-c', 'exit 3'] }, { type: 'file', path: '{state}/events.jsonl' }] });
  enqueue(sb.paths, [event()]);
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const r = await deliver(ctx(sb));
    assert.equal(r.failed, 1);
    assert.equal(readOutbox(sb.paths).length, 1);
  }
  const last = await deliver(ctx(sb));
  assert.equal(last.gaveUp.length, 1);
  assert.match(last.gaveUp[0]!.error, /exited with 3/);
  assert.equal(readOutbox(sb.paths).length, 0);
  assert.equal(loadUndelivered(sb.paths).length, 1);
  // The file output got it on the first try, and only once.
  assert.equal(fs.readFileSync(path.join(sb.paths.state, 'events.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('outputs: a command that hangs is stopped at its deadline', async () => {
  const sb = sandbox();
  writeConfig(sb, { outputs: [{ type: 'command', argv: ['/bin/sleep', '5'], timeout_s: 1 }] });
  enqueue(sb.paths, [event()]);
  const started = Date.now();
  const r = await deliver(ctx(sb));
  assert.equal(r.failed, 1);
  assert.ok(Date.now() - started < 4000);
});

test('outputs: Slack posts to the webhook from the hook, and waits for a hook when the secret is not here', async () => {
  const sb = sandbox();
  writeConfig(sb, { outputs: [{ type: 'slack' }] });
  enqueue(sb.paths, [event()]);
  const posts: { url: string; body: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: String(init.body) });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const outside = await deliver(ctx(sb, { inHook: false, fetch: fakeFetch }));
  assert.deepEqual([outside.sent, outside.failed, posts.length], [0, 0, 0]);
  assert.equal(readOutbox(sb.paths).length, 1);
  const env = { ...sb.env, CLAUDE_PLUGIN_OPTION_SLACK_WEBHOOK: 'https://hooks.slack.com/services/T0/B0/x' };
  const inside = await deliver(ctx(sb, { env, fetch: fakeFetch }));
  assert.equal(inside.sent, 1);
  assert.equal(posts[0]?.url, 'https://hooks.slack.com/services/T0/B0/x');
  assert.match(JSON.parse(posts[0]!.body).text, /nuvem n-0001: waiting permission/);
  enqueue(sb.paths, [event({ id: 'other' })]);
  const bad = await deliver(ctx(sb, { env: { ...sb.env, CLAUDE_PLUGIN_OPTION_SLACK_WEBHOOK: 'https://example.com/x' }, fetch: fakeFetch }));
  assert.equal(bad.failed, 1);
});

test('outputs: the notification output fails cleanly where there is no notifier', async () => {
  const sb = sandbox();
  writeConfig(sb, { outputs: [{ type: 'notification' }] });
  enqueue(sb.paths, [event()]);
  assert.equal((await deliver(ctx(sb))).failed, 1);
});

test('firstmate: the verb map of the shared mode never writes done or failed', () => {
  const now = Date.parse('2026-11-25T18:44:10Z');
  const line = (over: Partial<NuvemEvent>) => statusLine(event(over), 'shared', now, null);
  assert.equal(line({ event: 'session.opened', class: 'progress' }), 'working [at=1795632250]: nuvem n-0001 cloud session opened (fix the typo) https://claude.ai/code/session_01X');
  assert.equal(line({}), 'blocked [key=nuvem-n-0001] [at=1795632250]: nuvem n-0001 waiting permission: permission request with no answer for 4 min https://claude.ai/code/session_01X');
  assert.match(line({ event: 'session.waiting_answer', question: 'Which title?' }) ?? '', /^needs-decision \[key=nuvem-n-0001\] \[at=\d+\]: nuvem n-0001 asks: Which title\?/);
  assert.match(line({ event: 'session.back', state: 'running' }) ?? '', /^resolved \[key=nuvem-n-0001\] \[at=\d+\]: nuvem n-0001 is back to running$/);
  assert.match(line({ event: 'session.finished', pr: 'https://github.com/example/demo/pull/4' }) ?? '', /^note \[at=\d+\]: nuvem n-0001 finished PR https:\/\/github\.com\/example\/demo\/pull\/4$/);
  assert.match(line({ event: 'session.finished', open_notice: 'session.silent' }) ?? '', /^resolved \[key=nuvem-n-0001\]/);
  for (const e of ['session.failed', 'session.ended_unmarked', 'session.silent', 'session.looping', 'session.overdue', 'session.usage_limit', 'session.invisible', 'session.quiet_unmarked'] as const) {
    assert.match(line({ event: e }) ?? '', /^blocked \[key=nuvem-n-0001\]/, e);
  }
});

test('firstmate: the dedicated mode writes done only with a session sheet', () => {
  const sheet = 'FIM faltou=nada: nothing ;; refiz=nada: nothing ;; esperei=ci: 5 min of checks';
  assert.match(statusLine(event({ event: 'session.finished', summary: 'fixed' }), 'dedicated', T0, sheet) ?? '', /^done \[at=\d+\]: nuvem n-0001 finished: fixed no PR FIM faltou=nada/);
  assert.match(statusLine(event({ event: 'session.finished' }), 'dedicated', T0, null) ?? '', /^blocked \[key=nuvem-n-0001\] .*finished without the session sheet/);
  assert.match(statusLine(event({ event: 'session.failed' }), 'dedicated', T0, null) ?? '', /^failed \[at=/);
});

test('firstmate: writes one line to the given file only, calls the ledger, and refuses other paths', () => {
  const sb = sandbox();
  const { home, status } = fmHome(sb);
  writeStatus({ status_file: status, home, mode: 'shared' }, event(), T0, null);
  assert.equal(fs.readFileSync(status, 'utf8').trim().split('\n').length, 1);
  assert.match(fs.readFileSync(path.join(home, 'ledger-calls'), 'utf8'), /^appended .*\/config .*\/state\/task\.status$/m);
  assert.match(checkTarget({ status_file: path.join(home, 'state', 'missing.status'), home, mode: 'shared' }) ?? '', /never creates/);
  fs.writeFileSync(path.join(home, 'backlog.md'), '');
  assert.match(checkTarget({ status_file: path.join(home, 'backlog.md'), home, mode: 'shared' }) ?? '', /<home>\/state\/<task>\.status/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'state')), ['task.status']);
});

test('firstmate: a launch takes the adapter as an extra output, and dedicated asks for the sheet', () => {
  const sb = sandbox();
  const { home, status } = fmHome(sb, false);
  const shared = launchOutputs(parseArgs(['--output', 'firstmate', '--status-file', status, '--firstmate-home', home]));
  assert.equal(shared.outputs[0]?.type, 'firstmate');
  assert.deepEqual(shared.footer, []);
  const dedicated = launchOutputs(parseArgs(['--output', 'firstmate', '--status-file', status, '--firstmate-home', home, '--firstmate-mode', 'dedicated']));
  assert.match(dedicated.footer[0] ?? '', /"sheet"/);
  assert.throws(() => launchOutputs(parseArgs(['--output', 'firstmate', '--status-file', path.join(home, 'nope.status'), '--firstmate-home', home])), /never creates/);
  assert.throws(() => launchOutputs(parseArgs(['--output', 'slack'])), /only "firstmate"/);
});

test('firstmate: the extra output of a launch receives that launch\'s events', async () => {
  const sb = sandbox();
  const { home, status } = fmHome(sb, false);
  writeConfig(sb);
  const { prepare } = await import('../src/launch.ts');
  const { HEADS_OK } = await import('./helpers.ts');
  const extra = launchOutputs(parseArgs(['--output', 'firstmate', '--status-file', status, '--firstmate-home', home]));
  const s = prepare(sb.paths, { instruction: 'x', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_OK, extra_outputs: extra.outputs });
  enqueue(sb.paths, [event({ session: s.id, event: 'session.opened', class: 'progress' }), event({ session: 'n-0099', id: 'other' })]);
  const r = await deliver(ctx(sb));
  assert.equal(r.sent, 1);
  assert.match(fs.readFileSync(status, 'utf8'), /^working \[at=\d+\]: nuvem n-0001 cloud session opened/);
});

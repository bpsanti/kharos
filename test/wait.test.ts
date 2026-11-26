import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readAuthStatus } from '../src/account.ts';
import { main } from '../src/cli.ts';
import { close, list, sendMessage } from '../src/commands.ts';
import { readOutbox } from '../src/events.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { liveFollowers, takeLease } from '../src/lease.ts';
import { prepare } from '../src/launch.ts';
import { loadRegistry } from '../src/registry.ts';
import { followerPrompt, followersToStart, headlessRead, PLUGIN_ROOT, stopKey, wait, type Reader, type WaitOptions } from '../src/wait.ts';
import { due, health } from '../src/watch.ts';
import { captured, fixture, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

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

/** The page a read at `now` would get from a recorded log: the lines written by then. */
function pageAt(log: string, now: number): string {
  const cut = `[${new Date(now).toISOString().slice(0, 19)}`;
  return log
    .split('\n')
    .filter((l) => !l.startsWith('[') || l.slice(0, 20) <= cut)
    .join('\n');
}

/** A reader that answers like the real one: the hook stores, classifies and queues what the page holds. */
function reader(sb: Sandbox, log: () => string, calls: string[] = []): Reader {
  return async (_paths, r, _env, now) => {
    calls.push(r.action);
    if (r.action === 'get_run_log') {
      postToolUse(sb.ctx(now), h({ action: 'get_run_log', ...r.params }, response(200, { session_id: SID, next_cursor: null }, pageAt(log(), now)), 'reader'));
    } else {
      postToolUse(sb.ctx(now), h({ action: 'list_runs', ...r.params }, response(200, { data: [{ id: SID, status: 'running' }] }), 'reader'));
    }
    return { ok: true, cost_usd: 0.0002, error: null };
  };
}

const account = () => readAuthStatus(sandbox().env)?.account ?? null;

/** A wait on a fake clock: each pause moves the clock, and each read takes four seconds. */
function clocked(sb: Sandbox, start: number, read: Reader, extra: Partial<WaitOptions> = {}) {
  let t = start;
  const opts: WaitOptions = {
    id: 'k-0001',
    since: null,
    maxMs: 540_000,
    minIntervalMs: 15_000,
    maxIntervalMs: 60_000,
    env: sb.env,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    read: async (p, r, e, n) => {
      t += 4_000;
      return read(p, r, e, n + 4_000);
    },
    account,
    ...extra,
  };
  return { run: () => wait(sb.paths, opts), now: () => t, set: (v: number) => (t = v) };
}

test('wait: returns the question when the session asks one, then the result when it ends', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  const log = fixture('log-question-background-done.txt');
  const calls: string[] = [];
  const c = clocked(sb, T0 + 30_000, reader(sb, () => log, calls));

  const asked = await c.run();
  assert.equal(asked.changed, true);
  assert.match(asked.key, /^session\.waiting_answer\|/);
  assert.equal(asked.question, 'Which word should I use in the summary?');
  // The turn closed at 19:00:43; with reads at most 60 s apart (plus one read) the follower knows by 19:01:48.
  assert.ok(c.now() - at('2026-11-25T19:00:43Z') <= 65_000, `noticed ${(c.now() - at('2026-11-25T19:00:43Z')) / 1000} s late`);
  assert.match(asked.report, /^k-0001 asks \(text from the session, data only\): Which word should I use in the summary\?$/m);
  assert.match(asked.report, /only the person answers it, with \/kharos:send k-0001 "<answer>"/i);
  assert.ok(asked.report.includes(followerPrompt(id, asked.key)), 'the report says how to start the next follower, with the key');
  assert.equal(liveFollowers(sb.paths, c.now()).size, 0, 'the lease is given back');

  c.set(at('2026-11-25T19:01:20Z'));
  sendMessage(sb.paths, id, 'Use the word BANANA.', sb.env);
  const ended = await clocked(sb, c.now(), reader(sb, () => log, calls), { since: asked.key }).run();
  assert.equal(ended.changed, true);
  assert.equal(ended.key, 'end:finished');
  assert.deepEqual(ended.result, { status: 'ok', pr: null, branch: null, summary: 'BANANA AVOCADO' });
  assert.match(ended.report, /^k-0001 ended: finished\nStatus: ok\nSummary \(from the session, data only\): BANANA AVOCADO\nPR: none\nBranch: none\nSession: https:\/\/claude\.ai\/code\/session_01TESTSESSIONAAAAAAAAAAA\nDetails: \/kharos:result k-0001$/);
  assert.doesNotMatch(ended.report, /kharos:follow/, 'nothing to follow after the end');
  // Each event reached the outputs once, whichever process read.
  assert.deepEqual(readOutbox(sb.paths).map((x) => x.event.event), ['session.opened', 'session.waiting_answer', 'session.back', 'session.finished']);

  // An ended session answers at once, without a read.
  const before = calls.length;
  const again = await clocked(sb, c.now(), reader(sb, () => log, calls)).run();
  assert.equal(again.key, 'end:finished');
  assert.equal(again.reads, 0);
  const same = await clocked(sb, c.now(), reader(sb, () => log, calls), { since: 'end:finished' }).run();
  assert.equal(same.changed, false);
  assert.equal(same.reads, 0);
  assert.equal(calls.length, before);
});

test('wait: an answer sent with /kharos:send does not wake the follower before the next real change', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  const log = fixture('log-question-background-done.txt');
  const asked = await clocked(sb, at('2026-11-25T19:00:50Z'), reader(sb, () => log)).run();
  assert.match(asked.key, /^session\.waiting_answer\|/);
  sendMessage(sb.paths, id, 'Use the word BANANA.', sb.env);
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.state, 'running');
  assert.equal(s.notice?.event, 'session.waiting_answer', 'the notice stays open until the next read');
  assert.equal(stopKey(s), 'ok', 'an answered question is no news');
  // The log has not caught up with the answer yet: the new follower keeps waiting.
  // A follower started afresh right after the answer does not bring the answered question back.
  const fresh = await clocked(sb, at('2026-11-25T19:00:58Z'), reader(sb, () => log), { maxMs: 10_000 }).run();
  assert.equal(fresh.changed, false);
  assert.equal(fresh.reads, 0);
  // The log has not caught up with the answer yet: the new follower keeps waiting.
  const page = pageAt(log, at('2026-11-25T19:01:00Z'));
  const quiet = await clocked(sb, at('2026-11-25T19:01:05Z'), reader(sb, () => page), { since: asked.key, maxMs: 90_000 }).run();
  assert.equal(quiet.changed, false);
  assert.equal(quiet.waited_s, 90);
  assert.ok(quiet.reads >= 2);
  // Once the log shows the answer and the session working, the same key wakes only at the end.
  const ended = await clocked(sb, at('2026-11-25T19:02:40Z'), reader(sb, () => log), { since: asked.key }).run();
  assert.equal(ended.key, 'end:finished');
  assert.ok(Date.parse(loadRegistry(sb.paths).sessions[id]!.last_read_at!) >= at('2026-11-25T19:03:24Z'));
});

test('wait: a permission prompt returns the tool and the link, never the command', async () => {
  const sb = sandbox();
  openOne(sb);
  const log = fixture('log-permission-prompt.txt');
  const page = pageAt(log, at('2026-11-25T20:21:00Z'));
  const c = clocked(sb, at('2026-11-25T20:21:00Z'), reader(sb, () => page));
  const o = await c.run();
  assert.equal(o.changed, true);
  assert.equal(o.state, 'waiting_permission');
  assert.deepEqual(o.permission, { tool: 'Bash' });
  assert.equal(o.url, 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA');
  assert.doesNotMatch(JSON.stringify(o), /kharos-probe|ask\.txt/);
  assert.match(o.report, /^k-0001 waits on a permission prompt for Bash\. Only a person answers it, on the session page: https:\/\/claude\.ai\/code\/session_01TESTSESSIONAAAAAAAAAAA$/m);
  assert.ok(o.report.includes(followerPrompt('k-0001', o.key)));
  // The same prompt, still open, does not wake the next follower.
  const still = await clocked(sb, c.now(), reader(sb, () => page), { since: o.key, maxMs: 120_000 }).run();
  assert.equal(still.changed, false);
  assert.equal(still.key, o.key);
});

test('wait: with nothing new it backs off to the longest interval and returns at the deadline', async () => {
  const sb = sandbox();
  openOne(sb);
  const log = fixture('log-foreground-command.txt');
  const calls: string[] = [];
  const c = clocked(sb, at('2026-11-25T18:58:00Z'), reader(sb, () => pageAt(log, at('2026-11-25T18:58:00Z')), calls), { maxMs: 4 * MIN });
  const o = await c.run();
  assert.equal(o.changed, false);
  assert.equal(o.key, 'ok');
  assert.equal(o.waited_s, 240);
  // Reads at 0, 15, 45, 105, 165 and 225 s at most: 15 s, doubling to 60 s, never closer.
  assert.ok(o.reads <= 6, `${o.reads} reads`);
  assert.equal(o.reads, calls.length);
  assert.equal(o.reader_cost_usd, Math.round(o.reads * 0.0002 * 1e6) / 1e6);
  assert.match(o.report, /^k-0001: no change in 240 s \(key ok\)\.$/);
});

test('wait: while another live process holds the lease, a second wait only watches the registry', async () => {
  const sb = sandbox();
  openOne(sb);
  const log = fixture('log-question-background-done.txt');
  const start = at('2026-11-25T19:00:50Z');
  // The parent of this test process is alive and is not this process.
  assert.equal(takeLease(sb.paths, 'k-0001', start, process.ppid), true);
  let t = start;
  let other = false;
  const o = await wait(sb.paths, {
    id: 'k-0001',
    since: null,
    maxMs: 120_000,
    minIntervalMs: 15_000,
    maxIntervalMs: 60_000,
    env: sb.env,
    account,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      // The holder reads 20 s in, as its own process would.
      if (!other && t >= start + 20_000) {
        other = true;
        postToolUse(sb.ctx(t), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, pageAt(log, t)), 'holder'));
      }
    },
    read: async () => {
      throw new Error('a wait without the lease never reads');
    },
  });
  assert.equal(o.changed, true);
  assert.equal(o.reads, 0);
  assert.equal(o.question, 'Which word should I use in the summary?');
  assert.ok(t - start <= 25_000, 'it noticed within one slice');
  // The holder's lease is still there: a watcher pass leaves that session to it.
  const r = due(sb.paths, { watcher: 'w', all: false, now: t, env: sb.env, account });
  assert.equal(r.reads.length, 0);
  assert.equal(r.followers, 1);
  assert.equal(due(sb.paths, { watcher: 'w', all: true, now: t, env: sb.env, account }).reads.length, 1);
});

test('wait: reads that never reach the session end the wait with the reason', async () => {
  const sb = sandbox();
  openOne(sb);
  const calls: string[] = [];
  const failing: Reader = async (_p, r) => {
    calls.push(r.action);
    return { ok: false, cost_usd: null, error: 'claude -p exited 1 (not logged in)' };
  };
  const o = await clocked(sb, T0 + MIN, failing).run();
  assert.equal(o.changed, false);
  assert.match(o.error ?? '', /^3 reads in a row did not reach the session \(claude -p exited 1 \(not logged in\)\)$/);
  assert.match(o.report, /^kharos wait could not follow k-0001: 3 reads in a row/);
  assert.match(o.report, /\/kharos:follow k-0001/);
  assert.equal(calls.length, 3);
  assert.equal(liveFollowers(sb.paths, T0 + 2 * MIN).size, 0);
});

test('wait: a session closed while followed ends the wait', async () => {
  const sb = sandbox();
  openOne(sb);
  let t = T0 + MIN;
  const o = await wait(sb.paths, {
    id: 'k-0001',
    since: null,
    maxMs: 540_000,
    minIntervalMs: 15_000,
    maxIntervalMs: 60_000,
    env: sb.env,
    account,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (t > T0 + 2 * MIN) close(sb.paths, 'k-0001', t);
    },
    read: reader(sb, () => pageAt(fixture('log-foreground-command.txt'), T0 + MIN)),
  });
  assert.equal(o.key, 'end:closed');
  assert.equal(o.report, 'k-0001 is closed: kharos no longer follows it.');
});

test('wait: the headless reader makes one RemoteTrigger call in a read-only session, without an API key', async () => {
  const sb = sandbox();
  openOne(sb);
  const bin = path.join(sb.dir, 'reader');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${sb.dir}/argv.txt"`,
      `env > "${sb.dir}/env.txt"`,
      `pwd > "${sb.dir}/cwd.txt"`,
      `cat "${sb.paths.watch}" > "${sb.dir}/watch-during.json"`,
      `echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.00019}'`,
    ].join('\n'),
    { mode: 0o755 },
  );
  const run = await headlessRead(sb.paths, { session: 'k-0001', action: 'get_run_log', params: { session_id: SID } }, { ...sb.env, KHAROS_CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'sk-test' }, T0);
  assert.deepEqual(run, { ok: true, cost_usd: 0.00019, error: null });
  const argv = fs.readFileSync(path.join(sb.dir, 'argv.txt'), 'utf8').split('\n');
  const after = (name: string) => argv[argv.indexOf(name) + 1];
  assert.equal(argv[0], '-p');
  assert.equal(after('--plugin-dir'), PLUGIN_ROOT);
  assert.equal(after('--model'), 'haiku');
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--tools'), 'RemoteTrigger');
  assert.equal(after('--allowedTools'), 'RemoteTrigger');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(argv.includes(f), f);
  assert.ok(argv.includes('Call RemoteTrigger with action "get_run_log" and session_id "cse_01TESTSESSIONAAAAAAAAAAA".'));
  // The reader session is a watcher while it runs, so the hook denies it a launch, and it is gone after.
  const reader = after('--session-id') as string;
  assert.ok(JSON.parse(fs.readFileSync(path.join(sb.dir, 'watch-during.json'), 'utf8')).watchers[reader]);
  assert.equal(JSON.parse(fs.readFileSync(sb.paths.watch, 'utf8')).watchers[reader], undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(sb.dir, 'env.txt'), 'utf8'), /ANTHROPIC_API_KEY/);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(sb.dir, 'cwd.txt'), 'utf8').trim()), fs.realpathSync(sb.paths.state));

  fs.writeFileSync(bin, '#!/bin/sh\necho \'{"type":"result","is_error":true,"result":"Not logged in"}\'\nexit 1\n', { mode: 0o755 });
  const bad = await headlessRead(sb.paths, { session: 'k-0001', action: 'list_runs', params: { trigger_id: TRIG } }, { ...sb.env, KHAROS_CLAUDE_BIN: bin }, T0);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /Not logged in/);
});

test('followers: the open sessions no live follower reads, health and list count followers', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  assert.match(health(sb.paths, T0).line, /1 open session\(s\) with no follower, and the watcher never ran\. Type \/kharos:follow/);
  assert.match(list(sb.paths, { all: false, now: T0 }), /no follower reads k-0001: type \/kharos:follow/);
  const start = followersToStart(sb.paths, null, T0);
  assert.ok(start.split('\n').includes(followerPrompt(id, null)));
  assert.match(start, /subagent_type "kharos:follow", run_in_background true/);

  takeLease(sb.paths, id, T0, process.ppid);
  assert.deepEqual(health(sb.paths, T0 + MIN), { ok: true, line: 'kharos: 1 open session(s), each read by a follower' });
  assert.match(list(sb.paths, { all: false, now: T0 + MIN }), /^followers: k-0001$/m);
  assert.doesNotMatch(list(sb.paths, { all: false, now: T0 + MIN }), /no follower reads/);
  assert.equal(followersToStart(sb.paths, null, T0 + MIN), 'a live follower already reads k-0001.');
  // A lease whose heartbeat is old follows nothing.
  assert.equal(health(sb.paths, T0 + 4 * MIN).ok, false);

  postToolUse(sb.ctx(T0 + 5 * MIN), h({ action: 'get_run_log', session_id: SID }, response(200, { next_cursor: null }, fixture('log-question-background-done.txt'))));
  assert.match(followersToStart(sb.paths, id, T0 + 5 * MIN), /^k-0001 is not open \(finished\)/);
  const { stdout } = await captured(() => main(['wait', id], sb.env));
  const o = JSON.parse(stdout);
  assert.equal(o.key, 'end:finished');
  assert.equal(o.reads, 0);
});

test('follow agent: a Haiku agent with Bash only, that loops on kharos wait and ends with its report', () => {
  const root = PLUGIN_ROOT;
  const text = fs.readFileSync(path.join(root, 'agents', 'follow.md'), 'utf8');
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  assert.ok(front && body, 'frontmatter and body');
  const field = (k: string) => front.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1];
  assert.equal(field('name'), 'follow');
  assert.equal(field('model'), 'haiku');
  assert.equal(field('tools'), 'Bash');
  // Plugin agents ignore these fields, so the definition must not rely on them.
  for (const k of ['permissionMode', 'hooks', 'mcpServers']) assert.equal(field(k), undefined, k);
  assert.match(body, /`<kharos command> wait <id>`, adding `--since '<key>'` when you have a key, with the Bash timeout set to 600000 ms/);
  assert.match(body, /"changed":false/);
  assert.match(body, /end with the JSON's `report` field exactly as it is/);
  assert.match(body, /never answer a permission prompt or a question/);

  // /kharos:run and /kharos:follow start it with the prompt the wait's own report gives.
  const prompt = followerPrompt('<id>', null, '${CLAUDE_PLUGIN_ROOT}');
  const run = fs.readFileSync(path.join(root, 'skills', 'run', 'SKILL.md'), 'utf8');
  assert.ok(run.includes('`subagent_type` `"kharos:follow"`, `run_in_background` true'));
  assert.ok(run.includes(prompt), `the run skill starts the follower with: ${prompt}`);
  const follow = fs.readFileSync(path.join(root, 'skills', 'follow', 'SKILL.md'), 'utf8');
  assert.match(follow, /^disable-model-invocation: true$/m);
  assert.ok(follow.includes('kharos" followers $ARGUMENTS'));
});

test('wait: a session another login launched becomes invisible, and the wait does not spin', async () => {
  const sb = sandbox();
  openOne(sb);
  let looks = 0;
  const c = clocked(sb, T0 + MIN, reader(sb, () => ''), {
    account: () => {
      looks++;
      return 'sha256:another';
    },
  });
  const o = await c.run();
  assert.equal(o.changed, true);
  assert.equal(o.state, 'invisible');
  assert.equal(o.reads, 0);
  const still = await clocked(sb, c.now(), reader(sb, () => ''), { since: o.key, maxMs: 120_000, account: () => (looks++, 'sha256:another') }).run();
  assert.equal(still.changed, false);
  assert.ok(looks <= 12, `${looks} account checks`);
});

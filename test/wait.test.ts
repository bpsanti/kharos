import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readAuthStatus } from '../src/account.ts';
import { main } from '../src/cli.ts';
import { close, CommandError, followerProblems, list, result, sendMessage, show } from '../src/commands.ts';
import { runDoctor, type DoctorDeps } from '../src/doctor.ts';
import { enqueue, readOutbox } from '../src/events.ts';
import { endProbe } from '../src/body.ts';
import { followLoop } from '../src/follow.ts';
import { deliver } from '../src/outputs/index.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { followerReport, HANDOVER_MS, liveFollowers, releaseLease, takeLease } from '../src/lease.ts';
import { prepare } from '../src/launch.ts';
import { activeCount, loadRegistry, updateRegistry } from '../src/registry.ts';
import { acknowledge, followersToStart, headlessRead, PLUGIN_ROOT, stopKey, wait, type Reader, type WaitOptions } from '../src/wait.ts';
import { health } from '../src/follow.ts';
import { captured, fixture, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const KHAROS = `/bin/sh "${path.join(PLUGIN_ROOT, 'scripts', 'kharos')}"`;

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
  return async (_paths, rs, _env, now) => {
    for (const r of rs) {
      calls.push(r.action);
      if (r.action === 'get_run_log') {
        postToolUse(sb.ctx(now), h({ action: 'get_run_log', ...r.params }, response(200, { session_id: SID, next_cursor: null }, pageAt(log(), now)), 'reader'));
      } else {
        postToolUse(sb.ctx(now), h({ action: 'list_runs', ...r.params }, response(200, { data: [{ id: SID, status: 'running' }] }), 'reader'));
      }
    }
    return { ok: true, cost_usd: 0.0002 * rs.length, error: null };
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
    read: async (p, r, e, n, ms) => {
      t += 4_000;
      return read(p, r, e, n + 4_000, ms);
    },
    account,
    ...extra,
  };
  // As the CLI does: the outcome is printed, and the alerts in it are acknowledged.
  const run = async () => {
    const o = await wait(sb.paths, opts);
    acknowledge(sb.paths, o, 'agent', t);
    return o;
  };
  return { run, now: () => t, set: (v: number) => (t = v) };
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
  assert.ok(asked.report.includes(`with this prompt: The kharos command is: ${KHAROS}. The session id is k-0001. The key is '${asked.key}'.`), 'the report says how to start the next follower, with the key');
  // The lease is handed over to the next follower, which the report says to start: the session counts as followed until it starts.
  assert.deepEqual(followerReport(sb.paths, c.now()).map((f) => [f.id, f.state]), [['k-0001', 'handover']]);
  assert.equal(liveFollowers(sb.paths, c.now() + HANDOVER_MS).size, 0, 'a handover nobody takes runs out');

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
  assert.deepEqual(o.permission, { tool: 'Bash', category: 'unknown' });
  assert.equal(o.url, 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA');
  assert.doesNotMatch(JSON.stringify(o), /kharos-probe|ask\.txt/);
  assert.match(o.report, /^k-0001 waits on a permission prompt for Bash, from a reason kharos cannot tell\. Only a person answers it, on the session page: https:\/\/claude\.ai\/code\/session_01TESTSESSIONAAAAAAAAAAA$/m);
  assert.ok(o.report.includes(`with this prompt: The kharos command is: ${KHAROS}. The session id is k-0001. The key is '${o.key}'.`));
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
  // Log reads at 0, 15, 45, 105, 165 and 225 s at most: 15 s, doubling to 60 s, counted from when each read
  // began, never closer; the sixth also checks list_runs.
  const logReads = calls.filter((a) => a === 'get_run_log').length;
  assert.ok(logReads <= 6, `${logReads} log reads`);
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
});

test('wait: reads that never reach the session end the wait with the reason', async () => {
  const sb = sandbox();
  openOne(sb);
  const calls: string[] = [];
  const failing: Reader = async (_p, rs) => {
    calls.push(...rs.map((r) => r.action));
    return { ok: false, cost_usd: null, error: 'claude -p exited 1 (not logged in)' };
  };
  const o = await clocked(sb, T0 + MIN, failing).run();
  assert.equal(o.changed, false);
  assert.match(o.error ?? '', /^3 reads in a row did not reach the session \(claude -p exited 1 \(not logged in\)\)$/);
  assert.match(o.report, /^kharos wait could not follow k-0001: 3 reads in a row/);
  assert.match(o.report, /kharos follow k-0001 --detach does now\./);
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
      if (t > T0 + 2 * MIN) close(sb.paths, 'k-0001', t, null, { stopped: true });
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
      `echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.00019}'`,
    ].join('\n'),
    { mode: 0o755 },
  );
  const run = await headlessRead(sb.paths, [{ session: 'k-0001', action: 'get_run_log', params: { session_id: SID } }], { ...sb.env, KHAROS_CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'sk-test' }, T0, 50_000);
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
  // The reader runs as a kharos reader, so its hook denies it a launch, a fire or a change of a kharos routine.
  assert.match(after('--session-id') ?? '', /^[0-9a-f-]{36}$/);
  const childEnv = fs.readFileSync(path.join(sb.dir, 'env.txt'), 'utf8');
  assert.match(childEnv, /^KHAROS_ROLE=reader$/m);
  assert.doesNotMatch(childEnv, /ANTHROPIC_API_KEY/);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(sb.dir, 'cwd.txt'), 'utf8').trim()), fs.realpathSync(sb.paths.state));

  fs.writeFileSync(bin, '#!/bin/sh\necho \'{"type":"result","is_error":true,"result":"Not logged in"}\'\nexit 1\n', { mode: 0o755 });
  const bad = await headlessRead(sb.paths, [{ session: 'k-0001', action: 'list_runs', params: { trigger_id: TRIG } }], { ...sb.env, KHAROS_CLAUDE_BIN: bin }, T0, 50_000);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /Not logged in/);
});

test('followers: the open sessions no live follower reads, health and list count followers', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  // Within a minute of the fire, the follower may still be starting: no one is told to start another.
  assert.doesNotMatch(list(sb.paths, { all: false, now: T0 + 30_000 }), /no follower reads/);
  assert.equal(health(sb.paths, T0 + 30_000).ok, true);
  assert.match(health(sb.paths, T0 + MIN).line, /^kharos: 1 open session\(s\) with no follower: k-0001 "Fix the typo\."\. The next turn end/);
  assert.match(list(sb.paths, { all: false, now: T0 + MIN }), /no follower reads k-0001: the next turn end of a Claude Code session with kharos starts a follower process for each, or kharos follow <id> --detach does now\./);
  const start = followersToStart(sb.paths, null, T0);
  assert.ok(start.split('\n').includes(`The kharos command is: ${KHAROS}. The session id is ${id}.`));
  assert.match(start, /subagent_type "kharos:follow", run_in_background true/);

  takeLease(sb.paths, id, T0, process.ppid);
  assert.deepEqual(health(sb.paths, T0 + MIN), { ok: true, line: 'kharos: 1 open session(s), each read by a follower' });
  assert.match(list(sb.paths, { all: false, now: T0 + MIN }), /^followers: k-0001 \(pid \d+, heartbeat 60 s ago\)$/m);
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

test('follow agent: its definition declares a Haiku agent with Bash only', () => {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'follow.md'), 'utf8');
  const [, front] = text.match(/^---\n([\s\S]*?)\n---\n/) ?? [];
  assert.ok(front, 'frontmatter');
  const field = (k: string) => front.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1];
  assert.equal(field('name'), 'follow');
  assert.equal(field('model'), 'haiku');
  assert.equal(field('tools'), 'Bash');
  // Plugin agents ignore these fields, so the definition must not rely on them.
  for (const k of ['permissionMode', 'hooks', 'mcpServers']) assert.equal(field(k), undefined, k);
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

test('wait: a follower holds the lease from its first look, before its first read is due', async () => {
  const sb = sandbox();
  openOne(sb);
  const log = fixture('log-foreground-command.txt');
  const readAt = at('2026-11-25T18:58:00Z');
  postToolUse(sb.ctx(readAt), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, pageAt(log, readAt)), 'other'));
  const seen: boolean[] = [];
  let t = readAt + 2_000;
  const o = await wait(sb.paths, {
    id: 'k-0001',
    since: null,
    maxMs: 10_000,
    minIntervalMs: 15_000,
    maxIntervalMs: 60_000,
    env: sb.env,
    account,
    now: () => t,
    sleep: async (ms) => {
      seen.push(liveFollowers(sb.paths, t).has('k-0001'));
      t += ms;
    },
    read: async () => {
      throw new Error('no read is due within this wait');
    },
  });
  assert.equal(o.changed, false);
  assert.ok(seen.length > 0);
  assert.deepEqual(seen, seen.map(() => true), 'kharos followers, list and health see the follower while it sleeps');
  assert.equal(followerReport(sb.paths, t)[0]?.state, 'handover', 'the lease is handed over to the next wait');
  assert.equal(liveFollowers(sb.paths, t + HANDOVER_MS).size, 0);
});

test('wait: a slow reader is stopped at the deadline, so the wait never outlasts --max', async () => {
  const sb = sandbox();
  openOne(sb);
  const log = fixture('log-foreground-command.txt');
  const start = at('2026-11-25T18:58:00Z');
  const timeouts: number[] = [];
  let t = start;
  const land = reader(sb, () => pageAt(log, start));
  const o = await wait(sb.paths, {
    id: 'k-0001',
    since: null,
    maxMs: 70_000,
    minIntervalMs: 15_000,
    maxIntervalMs: 60_000,
    env: sb.env,
    account,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    // Each read takes all the time it is given.
    read: async (p, r, e, _n, ms) => {
      timeouts.push(ms);
      t += ms;
      return land(p, r, e, t, ms);
    },
  });
  assert.equal(o.changed, false);
  assert.ok(t - start <= 70_000, `the wait ran ${(t - start) / 1000} s`);
  assert.equal(o.waited_s, 70);
  assert.equal(timeouts[0], 50_000);
  assert.ok(timeouts.length >= 2 && timeouts.slice(1).every((ms) => ms <= 20_000), `timeouts ${timeouts.join(', ')}`);
  assert.equal(liveFollowers(sb.paths, t + HANDOVER_MS).size, 0);
});

const doctorDeps: DoctorDeps = {
  claudeVersion: () => '2.1.332 (Claude Code)',
  auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', account: 'sha256:x' }),
  heads: () => HEADS_OK,
  ownerType: () => 'User',
  settings: () => ({ status: 'absent' }),
  hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
  managedPolicy: () => ({ status: 'absent', file: '/home/person/.claude/remote-settings.json' }),
  setupScript: () => ({ status: 'absent' }),
  repoRole: () => 'admin',
};

test('followers: a heartbeat that stopped is flagged by list and the doctor, as stuck or as stopped', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  takeLease(sb.paths, id, T0, process.pid, 'shell');
  assert.match(list(sb.paths, { all: false, now: T0 + 20_000 }), new RegExp(`^followers: k-0001 \\(process ${process.pid}, heartbeat 20 s ago\\)$`, 'm'));
  assert.deepEqual(followerProblems(sb.paths, T0 + 20_000), []);

  // Its process still runs, but it has not beaten for 5 min: stuck.
  const stuck = list(sb.paths, { all: false, now: T0 + 5 * MIN });
  assert.match(stuck, new RegExp(`^follower heartbeat stale: the follower of k-0001 \\(process ${process.pid}\\) has not beaten for 5 min while its process still runs: it looks stuck\\. Stop it \\(kill ${process.pid}\\)`, 'm'));
  assert.match(stuck, /no follower reads k-0001/);
  const checks = runDoctor(sb.paths, { now: T0 + 5 * MIN, env: sb.env }, doctorDeps);
  const c = checks.find((x) => x.name === 'follower k-0001');
  assert.equal(c?.level, 'warn');
  assert.match(c?.detail ?? '', /looks stuck/);

  // Its process ended without handing the lease over: stopped.
  const dead = spawnSync('true').pid as number;
  takeLease(sb.paths, id, T0 + 6 * MIN, dead, 'shell');
  assert.equal(followerProblems(sb.paths, T0 + 6 * MIN)[0]?.state, 'gone');
  assert.match(list(sb.paths, { all: false, now: T0 + 6 * MIN }), new RegExp(`^follower heartbeat stopped: the follower of k-0001 \\(process ${dead}\\) stopped 0 min ago without handing over`, 'm'));

  // A handover is a follower starting again, not a problem.
  releaseLease(sb.paths, id, dead, T0 + 6 * MIN);
  assert.deepEqual(followerProblems(sb.paths, T0 + 6 * MIN), []);
  assert.match(list(sb.paths, { all: false, now: T0 + 6 * MIN }), /^followers: k-0001 \(starting again\)$/m);
  // A session that is not open is never flagged.
  updateRegistry(sb.paths, (reg) => {
    reg.sessions[id]!.step = 'closed';
  });
  takeLease(sb.paths, id, T0, process.pid, 'shell');
  assert.deepEqual(followerProblems(sb.paths, T0 + 9 * MIN), []);
});

function journal(sb: Sandbox): Record<string, any>[] {
  return fs.readFileSync(sb.paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('journal: every event goes to events.jsonl with no output, then its delivered mark', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  // writeConfig gives no output at all: the journal still has the event.
  let lines = journal(sb);
  assert.deepEqual(lines.map((l) => [l.schema, l.event]), [['kharos.event.v1', 'session.opened']]);
  await deliver({ paths: sb.paths, env: sb.env, now: T0, platform: 'aix', inHook: false });
  lines = journal(sb);
  assert.deepEqual(lines.at(-1), { schema: 'kharos.mark.v1', mark: 'delivered', event: lines[0]!.id, session: id, at: lines.at(-1)!.at, outputs: [], gave_up: [] });
  // A file output on the journal's path writes nothing twice.
  writeConfig(sb, { outputs: [{ type: 'file', path: '{state}/events.jsonl', events: ['*'] }, { type: 'file', path: '{state}/copy.jsonl' }] });
  enqueue(sb.paths, [{ ...(lines[0] as any), id: 'k-0001:opened:2' }]);
  await deliver({ paths: sb.paths, env: sb.env, now: T0, platform: 'aix', inHook: false });
  lines = journal(sb);
  assert.equal(lines.filter((l) => l.id === 'k-0001:opened:2').length, 1);
  assert.deepEqual(lines.at(-1)?.outputs, ['config:0:file', 'config:1:file']);
  assert.equal(fs.readFileSync(path.join(sb.paths.state, 'copy.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('wait: a restarted follower sends the alerts no follower handed on, once, and they are marked acknowledged', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  // The prompt is answered at 20:22:10, and the session goes on.
  const log = fixture('log-permission-prompt.txt').trimEnd() + '\n[2026-11-25T20:22:10.000000Z] tool_result: probe text\n[2026-11-25T20:22:12.000000Z] assistant: step 2 ran\n';
  // Nobody follows: the watcher reads a permission prompt, and later the session moves on.
  const watcherRead = (now: number) => postToolUse(sb.ctx(now), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, pageAt(log, now)), 'reader'));
  watcherRead(at('2026-11-25T20:21:00Z'));
  watcherRead(at('2026-11-25T20:22:30Z'));
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.notice, null, 'the prompt is answered: nothing is open any more');
  assert.deepEqual(s.unacked?.map((a) => a.event), ['session.waiting_permission']);

  // A follower starts again: its first wait returns at once with that alert, though nothing is open now.
  const c = clocked(sb, at('2026-11-25T20:23:00Z'), reader(sb, () => pageAt(log, at('2026-11-25T20:22:30Z'))));
  const o = await c.run();
  assert.equal(o.changed, true);
  assert.equal(o.reads, 0);
  assert.equal(o.key, 'ok');
  assert.deepEqual(o.alerts?.map((a) => a.event), ['session.waiting_permission']);
  const report = o.report.split('\n');
  assert.match(report[0]!, /^k-0001 is .* now: https:\/\/claude\.ai\/code\/session_/);
  assert.match(report[1]!, /^Raised earlier, while no follower handed it on \(1\): 20:21 UTC waiting permission: permission request for Bash \(a reason kharos cannot tell\)/);
  assert.match(report.at(-1)!, /^To keep following k-0001, start the kharos:follow agent again/);
  assert.doesNotMatch(o.report, /kharos-probe|ask\.txt/);

  // Acknowledged once printed: the next wait does not send it again.
  assert.deepEqual(loadRegistry(sb.paths).sessions[id]!.unacked, []);
  const marks = journal(sb).filter((l) => l.schema === 'kharos.mark.v1' && l.mark === 'acknowledged');
  assert.deepEqual(marks.map((m) => [m.event, m.session, m.by]), [[o.alerts![0]!.id, id, 'agent']]);
  const next = await clocked(sb, c.now(), reader(sb, () => pageAt(log, at('2026-11-25T20:22:30Z'))), { since: o.key, maxMs: 30_000 }).run();
  assert.equal(next.changed, false);
  assert.equal(next.alerts, undefined);
});

test('follow: the shell loop acknowledges what it printed, as the shell follower', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  postToolUse(sb.ctx(at('2026-11-25T20:21:00Z')), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, pageAt(fixture('log-permission-prompt.txt'), at('2026-11-25T20:21:00Z'))), 'reader'));
  const alert = loadRegistry(sb.paths).sessions[id]!.unacked![0]!;
  const lines: string[] = [];
  const end = { kharos: 'wait', id, changed: true, key: 'end:finished', state: 'finished', notice: null, url: null, waited_s: 0, reads: 0, reader_cost_usd: 0, report: '' } as const;
  const code = await followLoop(sb.paths, {
    id,
    env: sb.env,
    write: (l) => lines.push(l),
    wait: async () => ({ ...end, alerts: [alert] }),
    deliver: async () => ({ sent: 0, failed: 0, gaveUp: [], skipped: false, configError: null }),
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(loadRegistry(sb.paths).sessions[id]!.unacked, []);
  assert.equal(journal(sb).find((l) => l.mark === 'acknowledged')?.by, 'shell');
});

/** A log line `sec` seconds after T0. */
function line(sec: number, text: string): string {
  return `[${new Date(T0 + sec * 1000).toISOString()}] ${text}`;
}

/**
 * A session that built in the background, closed its turn while the build ran, woke when it ended, and
 * closed its last turn with its report but without the end mark.
 */
const UNMARKED = [
  line(1, 'user: Fix the typo. --- Protocol ... KHAROS-DONE {"status":"ok|failed"}'),
  line(5, 'init: model=claude-opus-5-5 cwd=/home/user/demo'),
  line(30, 'tool_use Bash: {"command":"npm run build","run_in_background":true}'),
  line(31, 'tool_result: Command running in background with ID: b01. Output is being written to: /tmp/b01.output. You will be notified when it completes.'),
  line(35, 'assistant: Building in the background.'),
  line(36, 'result: success is_error=false turns=2 duration=30s — Building in the background.'),
  line(210, 'user: <task-notification> <task-id>b01</task-id> <tool-use-id>toolu_01</tool-use-id> <output-file>/tmp/b01.output</output-file> <status>completed</status> <summary>Background command "build" completed (exit code 0)</summary> </task-notification>'),
  line(212, 'init: model=claude-opus-5-5 cwd=/home/user/demo'),
  line(220, 'assistant: [thinking]'),
  line(222, 'assistant: The build passes and the typo is fixed in README.md.'),
  line(223, 'result: success is_error=false turns=3 duration=10s — The build passes and the typo is fixed in README.md.'),
].join('\n');
const LAST_RESULT = T0 + 223_000;

/** A recorded send: the session's log grows by what `reply` returns, from the time of the send. */
function sender(sent: string[], grow: (text: string, sec: number) => void, now: () => number) {
  return (_p: unknown, _id: string, text: string) => {
    sent.push(text);
    grow(text, Math.round((now() - T0) / 1000));
  };
}

test('wait: a turn closed without the end mark, with nothing left to wake it, is asked about once, and the session ends when it answers with KHAROS-DONE', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  let log = UNMARKED;
  const sent: string[] = [];
  let sentAt = 0;
  const clock = { now: () => 0 };
  const send = sender(sent, (text, sec) => {
    sentAt = T0 + sec * 1000;
    log = [log, line(sec + 2, `user: ${text}`), line(sec + 4, 'init: model=claude-opus-5-5 cwd=/home/user/demo'), line(sec + 8, 'assistant: KHAROS-PART 1/1 The build passes and the typo is fixed in README.md.'), line(sec + 9, 'tool_use Bash: {"command":"true"}'), line(sec + 10, 'tool_result: '), line(sec + 11, 'assistant: KHAROS-DONE {"status":"ok","pr":null,"branch":null,"summary":"typo fixed"}'), line(sec + 12, 'result: success is_error=false turns=3 duration=8s — KHAROS-DONE {"status":"ok","pr":null,"branch":null,"summary":"typo fixed"}')].join('\n');
  }, () => clock.now());
  const c = clocked(sb, T0 + 30_000, reader(sb, () => log), { send, maxMs: 12 * MIN });
  clock.now = c.now;
  const o = await c.run();
  // The first turn closed while its build ran, so its quiet then asked nothing; the last one is asked
  // about once it is quiet for unmarked_end_min (5), within one read at most 60 s apart.
  assert.deepEqual(sent, [endProbe()]);
  assert.ok(sentAt - LAST_RESULT > 5 * MIN && sentAt - LAST_RESULT <= 5 * MIN + 65_000, `asked ${(sentAt - LAST_RESULT) / 1000} s after the turn closed`);
  assert.match(endProbe(), /^kharos: your turn closed without the end mark\. If you have finished, send your final report in KHAROS-PART messages, then the KHAROS-DONE line as your last message\. If not, go on with your work\.$/);
  // Its answer is read soon after, and the end is the session's own.
  assert.equal(o.key, 'end:finished');
  assert.deepEqual(o.result, { status: 'ok', pr: null, branch: null, summary: 'typo fixed' });
  assert.ok(c.now() - sentAt <= 30_000, `answer read ${(c.now() - sentAt) / 1000} s after the question`);
  const events = journal(sb).filter((e) => e.schema === 'kharos.event.v1' && e.event !== 'session.opened');
  assert.deepEqual(events.map((e) => [e.event, e.class]), [['session.end_asked', 'progress'], ['session.finished', 'terminal']]);
  assert.equal(events[0]!.reason, 'its turn closed without the end mark, with nothing left that could wake it: kharos asked it whether it finished');
  assert.match(result(sb.paths, id, sb.env), /^final report, 1 of 1 part\(s\) in the log \(from the session, data only\):\n--- part 1\/1\nThe build passes and the typo is fixed in README\.md\.$/m);
  assert.equal(activeCount(loadRegistry(sb.paths), c.now()), 0);
});

test('wait: a session that gives no answer stays turn_closed with a warning, is asked only once, and is closed at its deadline with a terminal event', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  const sent: string[] = [];
  const clock = { now: () => 0 };
  const send = sender(sent, () => {}, () => clock.now());
  const c = clocked(sb, T0 + 30_000, reader(sb, () => UNMARKED), { send, maxMs: 20 * MIN });
  clock.now = c.now;
  const o = await c.run();
  assert.equal(o.state, 'turn_closed');
  assert.equal(o.notice, 'session.quiet_unmarked');
  assert.match(journal(sb).find((e) => e.event === 'session.quiet_unmarked')!.reason, /^turn closed without the end mark: kharos asked the session whether it finished at \d\d:\d\d UTC, and no answer came$/);
  // Later waits do not ask again, and it holds its slot: it may still be working on something kharos cannot see.
  const later = await clocked(sb, c.now(), reader(sb, () => UNMARKED), { send, since: o.key }).run();
  assert.equal(later.changed, false);
  assert.equal(sent.length, 1);
  assert.equal(activeCount(loadRegistry(sb.paths), later.waited_s * 1000 + c.now()), 1);
  assert.match(show(sb.paths, id), /^kharos asked it at \d\d:\d\d UTC whether it finished, after its turn closed without the end mark; it ends only with KHAROS-DONE$/m);
  assert.match(list(sb.paths, { all: false, now: c.now() }), /^k-0001  turn closed /m);
  // At its deadline it is closed, on a read after the warning, and the follower stops.
  updateRegistry(sb.paths, (reg) => {
    reg.sessions[id]!.deadline_min = 20;
  });
  postToolUse(sb.ctx(T0 + 21 * MIN), h({ action: 'get_run_log', session_id: SID }, response(200, { next_cursor: null }, UNMARKED), 'reader'));
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.step, 'closed');
  assert.equal(sent.length, 1);
  const ended = journal(sb).filter((e) => e.event === 'session.deadline_closed');
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.class, 'terminal');
  assert.match(ended[0]!.reason, /^closed at its deadline: .*; its last message \(from the session, data only\): The build passes and the typo is fixed in README\.md\.$/);
  const closed = await clocked(sb, T0 + 21 * MIN, reader(sb, () => UNMARKED), { send, since: o.key }).run();
  assert.equal(closed.key, 'end:closed');
  assert.match(closed.report, /^k-0001 was closed at its deadline: /);
  assert.doesNotMatch(closed.report, /Raised earlier/);
});

test('wait: a question that does not go through is kept with its reason, and the warning says so', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  let tries = 0;
  const send = () => {
    tries++;
    throw new CommandError('not sent: the session is not reachable');
  };
  const o = await clocked(sb, T0 + 30_000, reader(sb, () => UNMARKED), { send, maxMs: 20 * MIN }).run();
  assert.equal(tries, 1);
  assert.equal(o.notice, 'session.quiet_unmarked');
  assert.equal(loadRegistry(sb.paths).sessions[id]!.end_probe?.error, 'not sent: the session is not reachable');
  const asked = journal(sb).find((e) => e.event === 'session.end_asked')!;
  assert.equal(asked.reason, 'its turn closed without the end mark, and kharos could not ask it whether it finished (not sent: the session is not reachable)');
  assert.match(journal(sb).find((e) => e.event === 'session.quiet_unmarked')!.reason, /kharos could not send it the question whether it finished at \d\d:\d\d UTC$/);
  assert.match(show(sb.paths, id), /^kharos tried to ask it at \d\d:\d\d UTC whether it finished, after its turn closed without the end mark, and the message did not go through: not sent: the session is not reachable$/m);
});

test('wait: a session that goes on with its work after the question is running, and its next quiet turn is a new one to ask about', async () => {
  const sb = sandbox();
  openOne(sb);
  let log = UNMARKED;
  const sent: string[] = [];
  const clock = { now: () => 0 };
  // The first question is answered with more work; the second, about the turn that work closed, with words only.
  const send = sender(sent, (text, sec) => {
    const answer =
      sent.length === 1
        ? [line(sec + 8, 'tool_use Bash: {"command":"npm test"}'), line(sec + 60, 'tool_result: all green'), line(sec + 62, 'assistant: Tests pass too.'), line(sec + 63, 'result: success is_error=false turns=2 duration=60s — Tests pass too.')]
        : [line(sec + 8, 'assistant: Still checking.'), line(sec + 9, 'result: success is_error=false turns=1 duration=1s — Still checking.')];
    log = [log, line(sec + 2, `user: ${text}`), line(sec + 4, 'init: model=claude-opus-5-5 cwd=/home/user/demo'), ...answer].join('\n');
  }, () => clock.now());
  const c = clocked(sb, T0 + 30_000, reader(sb, () => log), { send, maxMs: 25 * MIN });
  clock.now = c.now;
  const o = await c.run();
  assert.equal(sent.length, 2, 'one question per quiet period');
  // An answer with no work and no end mark is not asked about again: the turn stays closed, with the warning.
  assert.equal(o.notice, 'session.quiet_unmarked');
  assert.match(journal(sb).find((e) => e.event === 'session.quiet_unmarked')!.reason, /and it answered with no end mark and no work$/);
  const kinds = journal(sb).filter((e) => e.schema === 'kharos.event.v1' && e.event === 'session.end_asked');
  assert.equal(kinds.length, 2);
});

test('close: a closing session whose turn closes without the end mark is not asked, and keeps its slot until its deadline', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  close(sb.paths, id, T0 + 60_000);
  const sent: string[] = [];
  const send = sender(sent, () => {}, () => 0);
  await clocked(sb, T0 + 70_000, reader(sb, () => UNMARKED), { send }).run();
  assert.deepEqual(sent, []);
  assert.equal(loadRegistry(sb.paths).sessions[id]!.step, 'open');
  assert.equal(activeCount(loadRegistry(sb.paths), T0 + 15 * MIN), 1);
  assert.equal(journal(sb).some((e) => e.event === 'session.end_asked' || e.event === 'session.quiet_unmarked'), false);
});

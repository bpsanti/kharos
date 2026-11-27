import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { takeLease } from '../src/lease.ts';
import { loadRegistry } from '../src/registry.ts';
import { headlessRead, onGrid, readerAsk, readerGroup, readInRound, ROUND_MAX_SESSIONS, roundTimeout, type Read, type Reader } from '../src/round.ts';
import { wait, type WaitOptions, type WaitOutcome } from '../src/wait.ts';
import { HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const MIN = 60_000;
const STEP = 15_000;

function h(ti: Record<string, unknown>, tool_response?: unknown, session = 'launcher'): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: session, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

const trig = (n: number) => `trig_01TESTROUTINE${String(n).padStart(2, '0')}AAAAAAAAA`;
const sid = (n: number) => `cse_01TESTSESSION${String(n).padStart(2, '0')}AAAAAAAAA`;

/** Opens `n` launches, k-0001 to k-000n, each with its own routine and session. */
function openMany(sb: Sandbox, n: number, watch: Record<string, unknown> = {}): string[] {
  writeConfig(sb, { watch: { max_open: 20, ...watch } });
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = prepare(sb.paths, { instruction: `Fix typo ${i}.`, claude_session: 'launcher', now: T0, env: sb.env, heads: () => HEADS_OK }).id;
    const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }));
    postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: trig(i) } })));
    preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: trig(i) }));
    postToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: trig(i) }, response(200, { session_id: sid(i) })));
    ids.push(id);
  }
  return ids;
}

/** A session that started and works, with nothing a person must see. */
function page(n: number): string {
  return [`[${new Date(T0 + 5_000).toISOString()}] init: model=claude-opus-5-5 cwd=/home/user/demo`, `[${new Date(T0 + 10_000).toISOString()}] assistant: Working on typo ${n}.`].join('\n');
}

/**
 * A clock that moves only when every task waits: each pause is a timer, and the earliest one fires once
 * nothing else can run. Several waits then share it as several follower processes share the real one.
 */
function virtualClock(start: number) {
  let t = start;
  let seq = 0;
  const timers: { at: number; seq: number; fire: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((fire) => timers.push({ at: t + Math.max(0, ms), seq: seq++, fire }));
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  async function run<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
    let finished = false;
    const all = Promise.all(tasks.map((f) => f())).finally(() => {
      finished = true;
    });
    all.catch(() => {});
    while (!finished) {
      await settle();
      if (finished) break;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers.shift();
      if (!next) throw new Error('every task waits on something that never comes');
      t = Math.max(t, next.at);
      next.fire();
    }
    return all;
  }
  return { now: () => t, sleep, run };
}

interface Call {
  at: number;
  sessions: string[];
  reads: Read[];
  configDir: string | undefined;
}

/**
 * A reader that answers like the real one, in one process for all the round's reads: the hook stores and
 * classifies each answer. `answer` may change the answer of a read, or skip it (null).
 */
function roundReader(sb: Sandbox, clock: ReturnType<typeof virtualClock>, calls: Call[], answer: (r: Read, round: number) => unknown | null = () => undefined): Reader {
  return async (_paths, reads, env, now) => {
    const round = calls.length;
    calls.push({ at: now, sessions: [...new Set(reads.map((r) => r.session))], reads, configDir: env.CLAUDE_CONFIG_DIR });
    await clock.sleep(4_000);
    for (const r of reads) {
      const n = Number(r.session.slice(2));
      const custom = answer(r, round);
      if (custom === null) continue;
      const fallback = r.action === 'get_run_log' ? response(200, { session_id: r.params.session_id, next_cursor: null }, page(n)) : response(200, { data: [{ id: sid(n), status: 'running' }] });
      postToolUse(sb.ctx(clock.now()), h({ action: r.action, ...r.params }, custom ?? fallback, 'reader'));
    }
    return { ok: true, cost_usd: 0.0003 * reads.length, error: null };
  };
}

/** One follower's wait per session, all on the same clock, each holding its session's lease as its process would. */
async function followAll(sb: Sandbox, ids: string[], clock: ReturnType<typeof virtualClock>, read: Reader, extra: (id: string) => Partial<WaitOptions> = () => ({})): Promise<WaitOutcome[]> {
  for (const id of ids) takeLease(sb.paths, id, clock.now(), process.pid, 'shell');
  const account = loadRegistry(sb.paths).sessions[ids[0]!]!.account;
  return clock.run(
    ids.map((id) => () =>
      wait(sb.paths, {
        id,
        since: 'ok',
        maxMs: 2 * MIN,
        minIntervalMs: STEP,
        maxIntervalMs: MIN,
        env: sb.env,
        now: clock.now,
        sleep: clock.sleep,
        read,
        account: () => account,
        follower: 'shell',
        ...extra(id),
      }),
    ),
  );
}

const START = onGrid(T0 + MIN, STEP) + 3_000;

test('round: the followers due at the same moment read in one reader process, and each gets its share of the cost', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 3);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  const out = await followAll(sb, ids, clock, roundReader(sb, clock, calls));
  // Every round read all three sessions, in one process each time.
  assert.ok(calls.length >= 3, `${calls.length} rounds`);
  for (const c of calls) assert.deepEqual(c.sessions, ids);
  // After the first read, each round is on the grid the followers share, and the next is counted from it.
  for (const c of calls.slice(1)) assert.equal((c.at - 2_000) % STEP, 0, `a round at ${(c.at - START) / 1000} s`);
  const reg = loadRegistry(sb.paths).sessions;
  for (const id of ids) {
    assert.equal(reg[id]!.state, 'running');
    assert.equal(reg[id]!.read_failures, 0);
  }
  for (const o of out) {
    assert.equal(o.changed, false);
    assert.equal(o.error, undefined);
    // The round's cost, split by reads: each follower pays for its own.
    assert.equal(o.reader_cost_usd, Math.round(o.reads * 0.0003 * 1e6) / 1e6);
  }
  assert.equal(out.reduce((n, o) => n + o.reads, 0), calls.reduce((n, c) => n + c.reads.length, 0));
});

test('round: a failed or malformed answer for one session is recorded for it alone, and it is read again next round', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 3);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  // Each session's read_failures after each round.
  const failures: Record<string, number>[] = [];
  const read = roundReader(sb, clock, calls, (r, round) => {
    if (round !== 0 || r.action !== 'get_run_log') return undefined;
    if (r.session === 'k-0002') return response(500, { error: { type: 'api_error', message: 'Internal error' } });
    if (r.session === 'k-0003') return 'not an answer the tool gives';
    return undefined;
  });
  const recording: Reader = async (p, reads, env, now, ms) => {
    const run = await read(p, reads, env, now, ms);
    const reg = loadRegistry(sb.paths).sessions;
    failures.push(Object.fromEntries(ids.map((id) => [id, reg[id]!.read_failures])));
    return run;
  };
  const out = await followAll(sb, ids, clock, recording);
  // The first round: only k-0002 and k-0003 failed, and k-0001 read well.
  assert.deepEqual(calls[0]?.sessions, ids);
  assert.deepEqual(failures[0], { 'k-0001': 0, 'k-0002': 1, 'k-0003': 1 });
  assert.equal(loadRegistry(sb.paths).sessions['k-0001']!.state, 'running');
  // A failed read backs off as a read with nothing new does: the two are read again together, in a later
  // round, and then read well.
  const again = calls.findIndex((c, i) => i > 0 && c.sessions.includes('k-0002'));
  assert.ok(again > 0);
  assert.ok(calls[again]!.sessions.includes('k-0003'));
  assert.deepEqual(failures[again], { 'k-0001': 0, 'k-0002': 0, 'k-0003': 0 });
  for (const o of out) assert.equal(o.error, undefined);
});

test('round: a session the reader made no call for is a failed read for that session only, retried in the next round', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 3);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  // The reader skips k-0002 in every round: its follower gives up after three, and the others go on.
  const read = roundReader(sb, clock, calls, (r) => (r.session === 'k-0002' ? null : undefined));
  const out = await followAll(sb, ids, clock, read);
  const byId = Object.fromEntries(out.map((o) => [o.id, o]));
  assert.match(byId['k-0002']!.error ?? '', /^3 reads in a row did not reach the session \(the reader made no RemoteTrigger call for k-0002\)$/);
  assert.equal(byId['k-0001']!.error, undefined);
  assert.equal(byId['k-0003']!.error, undefined);
  // Its retries went with the others' rounds, not in processes of their own.
  const withIt = calls.filter((c) => c.sessions.includes('k-0002'));
  assert.equal(withIt.length, 3);
  for (const c of withIt) assert.deepEqual([...c.sessions].sort(), ids);
  const reg = loadRegistry(sb.paths).sessions;
  assert.equal(reg['k-0002']!.last_read_at, null);
  assert.equal(reg['k-0001']!.read_failures, 0);
});

test('round: more followers than a round holds split into two reader processes in the same round', async () => {
  const sb = sandbox();
  const ids = openMany(sb, ROUND_MAX_SESSIONS + 1, { max_open: ROUND_MAX_SESSIONS + 5 });
  const clock = virtualClock(START);
  const calls: Call[] = [];
  await followAll(sb, ids, clock, roundReader(sb, clock, calls), () => ({ maxMs: 20_000 }));
  const first = calls.filter((c) => c.at === calls[0]!.at);
  assert.deepEqual(first.map((c) => c.sessions.length).sort((a, b) => a - b), [1, ROUND_MAX_SESSIONS]);
  assert.deepEqual(first.flatMap((c) => c.sessions).sort(), ids);
});

test('round: a round the wait has to leave before its reader starts counts no read', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 2);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  // Two followers: the round waits two seconds for the other, longer than either wait may last.
  const out = await followAll(sb, ids, clock, roundReader(sb, clock, calls), () => ({ maxMs: 1_000 }));
  assert.equal(calls.length, 0);
  for (const o of out) {
    assert.equal(o.reads, 0);
    assert.equal(o.error, undefined);
  }
});

test('round: followers of two accounts in the same moment get a reader each, with its own CLAUDE_CONFIG_DIR', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 4);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  const dirA = path.join(sb.dir, 'account-a');
  const dirB = path.join(sb.dir, 'account-b');
  const envOf = (id: string) => ({ ...sb.env, CLAUDE_CONFIG_DIR: id === 'k-0001' || id === 'k-0003' ? dirA : dirB });
  assert.notEqual(readerGroup(envOf('k-0001')), readerGroup(envOf('k-0002')));
  await followAll(sb, ids, clock, roundReader(sb, clock, calls), (id) => ({ env: envOf(id), maxMs: 20_000 }));
  const first = calls.filter((c) => c.at === calls[0]!.at);
  assert.equal(first.length, 2);
  const byDir = Object.fromEntries(first.map((c) => [c.configDir, c.sessions]));
  assert.deepEqual(byDir[dirA], ['k-0001', 'k-0003']);
  assert.deepEqual(byDir[dirB], ['k-0002', 'k-0004']);
});

test('round: a follower alone reads at once, with no wait for others', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 1);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  await followAll(sb, ids, clock, roundReader(sb, clock, calls), () => ({ maxMs: 10_000 }));
  assert.equal(calls[0]?.at, START);
});

test('round: the follower whose wait ends last runs the reader, and a round whose followers are all gone is dropped', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 3);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  const timeouts: number[] = [];
  const inner = roundReader(sb, clock, calls);
  const read: Reader = async (p, reads, env, now, ms) => {
    timeouts.push(ms);
    return inner(p, reads, env, now, ms);
  };
  // k-0001's follower opened a round and is gone: nobody waits on that round any more, so it is dropped,
  // and the others share a new one.
  fs.writeFileSync(
    sb.paths.rounds,
    JSON.stringify({
      rounds: [
        {
          id: 'r-gone',
          group: readerGroup(sb.env),
          tick: START,
          opened: START,
          starts: START + 2_000,
          leader: 'gone',
          state: 'forming',
          started: null,
          timeout: null,
          members: [{ token: 'gone', pid: 2 ** 22 + 12_345, session: 'k-0001', reads: [{ session: 'k-0001', action: 'get_run_log', params: { session_id: sid(1) } }], seen: null, deadline: START + 600_000 }],
          results: null,
          ended: null,
          cost_usd: null,
          error: null,
        },
      ],
    }),
  );
  for (const id of ids) takeLease(sb.paths, id, START, process.pid, 'shell');
  const ask = (n: number, deadline: number) => () =>
    readInRound(sb.paths, { session: ids[n]!, reads: [{ session: ids[n]!, action: 'get_run_log', params: { session_id: sid(n + 1) } }], seen: null, deadline, stepMs: STEP }, { env: sb.env, now: clock.now, sleep: clock.sleep, read });
  const [short, long] = await clock.run([ask(1, START + 40_000), ask(2, START + 100_000)]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.sessions, ['k-0002', 'k-0003']);
  // The reader may run as long as the latest deadline allows, not only until the first one.
  assert.deepEqual(timeouts, [Math.min(roundTimeout(2), START + 100_000 - (START + 2_000))]);
  assert.ok(timeouts[0]! > START + 40_000 - (START + 2_000));
  assert.equal(short!.run.ok, true);
  assert.equal(long!.run.ok, true);
  assert.equal(short!.ran, true);
  assert.equal(long!.ran, true);
  assert.equal(long!.sessions, 2);
  assert.equal(short!.tick, onGrid(START, STEP));
  assert.equal(JSON.parse(fs.readFileSync(sb.paths.rounds, 'utf8')).rounds.some((r: { id: string }) => r.id === 'r-gone'), false);
});

test('round: a round its leader does not start is started by another of its followers', async () => {
  const sb = sandbox();
  const ids = openMany(sb, 2);
  const clock = virtualClock(START);
  const calls: Call[] = [];
  // k-0001's follower opened the round and leads it, but its process is stuck: it never starts it.
  fs.writeFileSync(
    sb.paths.rounds,
    JSON.stringify({
      rounds: [
        {
          id: 'r-stuck',
          group: readerGroup(sb.env),
          tick: START,
          opened: START,
          starts: START + 2_000,
          leader: 'stuck',
          state: 'forming',
          started: null,
          timeout: null,
          members: [{ token: 'stuck', pid: process.pid, session: 'k-0001', reads: [{ session: 'k-0001', action: 'get_run_log', params: { session_id: sid(1) } }], seen: null, deadline: START + 600_000 }],
          results: null,
          ended: null,
          cost_usd: null,
          error: null,
        },
      ],
    }),
  );
  for (const id of ids) takeLease(sb.paths, id, START, process.pid, 'shell');
  const ask = { session: 'k-0002', reads: [{ session: 'k-0002', action: 'get_run_log' as const, params: { session_id: sid(2) } }], seen: null, deadline: START + 60_000, stepMs: STEP };
  const [part] = await clock.run([() => readInRound(sb.paths, ask, { env: sb.env, now: clock.now, sleep: clock.sleep, read: roundReader(sb, clock, calls) })]);
  assert.equal(part!.run.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.sessions, ['k-0001', 'k-0002']);
  assert.ok(calls[0]!.at >= START + 7_000 && calls[0]!.at < START + 8_000, `started at ${(calls[0]!.at - START) / 1000} s`);
});

test('round: the reader gets one call to make, or the numbered list of the round with each archive check after the logs', async () => {
  const one: Read[] = [{ session: 'k-0001', action: 'get_run_log', params: { session_id: sid(1) } }];
  assert.equal(readerAsk(one), `Call RemoteTrigger with action "get_run_log" and session_id "${sid(1)}".`);
  const logs: Read[] = [...one, { session: 'k-0003', action: 'list_runs', params: { trigger_id: trig(3) } }];
  assert.equal(readerAsk(logs), ['Make these 2 RemoteTrigger calls:', `1. action "get_run_log" and session_id "${sid(1)}"`, `2. action "list_runs" and trigger_id "${trig(3)}"`].join('\n'));
  // k-0002's sixth read: its archive check must not be answered before its log, or an end mark in that log
  // would be settled as an archive without one.
  const many: Read[] = [{ session: 'k-0002', action: 'get_run_log', params: { session_id: sid(2), cursor: 'c1' } }, { session: 'k-0002', action: 'list_runs', params: { trigger_id: trig(2) } }, ...one];
  assert.equal(
    readerAsk(many),
    [
      'Make these 2 RemoteTrigger calls:',
      `1. action "get_run_log" and session_id "${sid(2)}" and cursor "c1"`,
      `2. action "get_run_log" and session_id "${sid(1)}"`,
      'Once all of them have answered, make these:',
      `3. action "list_runs" and trigger_id "${trig(2)}"`,
    ].join('\n'),
  );

  const sb = sandbox();
  openMany(sb, 2);
  const bin = path.join(sb.dir, 'reader');
  fs.writeFileSync(bin, ['#!/bin/sh', `printf '%s\\n' "$@" > "${sb.dir}/argv.txt"`, `echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0004}'`].join('\n'), { mode: 0o755 });
  const run = await headlessRead(sb.paths, many, { ...sb.env, KHAROS_CLAUDE_BIN: bin }, T0, 60_000);
  assert.deepEqual(run, { ok: true, cost_usd: 0.0004, error: null });
  const argv = fs.readFileSync(path.join(sb.dir, 'argv.txt'), 'utf8');
  assert.ok(argv.includes(readerAsk(many)), 'the reader is asked for every call of the round');
});

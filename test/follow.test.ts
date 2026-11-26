import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { close } from '../src/commands.ts';
import { readOutbox, transition } from '../src/events.ts';
import { detachedSpawner, detachFollower, followerLog, followLoop, isHeadless, startFollowers, type Spawner } from '../src/follow.ts';
import { postToolUse, preToolUse, stop, type HookInput } from '../src/hook.ts';
import { runHook } from '../src/cli.ts';
import { updateWatch } from '../src/state.ts';
import { prepare } from '../src/launch.ts';
import { followerReport, HANDOVER_MS, LEASE_STALE_MS, liveFollowers, releaseLease, takeLease } from '../src/lease.ts';
import { loadRegistry, type Session } from '../src/registry.ts';
import { stopKey, type WaitOutcome } from '../src/wait.ts';
import { captured, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
const MIN = 60_000;
const HEADLESS = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };

function h(ti: Record<string, unknown>, tool_response?: unknown): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: 'launcher', tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function openOne(sb: Sandbox, outputs: unknown[] = []): string {
  writeConfig(sb, { outputs });
  const id = prepare(sb.paths, { instruction: 'Fix the typo.', claude_session: 'launcher', now: T0, env: sb.env, heads: () => HEADS_OK }).id;
  const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: TRIG } })));
  preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }));
  postToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }, response(200, { session_id: SID })));
  return id;
}

function recording(): { spawner: Spawner; calls: { args: string[]; log: string }[] } {
  const calls: { args: string[]; log: string }[] = [];
  return { calls, spawner: (args, log) => (calls.push({ args, log }), 4242) };
}

test('follow: only a headless Claude Code counts as headless', () => {
  assert.equal(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), true);
  assert.equal(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), true);
  assert.equal(isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);
  assert.equal(isHeadless({}), false);
});

test('follow: an interactive Claude Code gets follower agents, a headless one follower processes', () => {
  const sb = sandbox();
  const id = openOne(sb, [{ type: 'notification', events: ['needs_you'] }, { type: 'file', path: '{state}/events.jsonl' }]);
  const r = recording();

  const interactive = startFollowers(sb.paths, id, T0 + MIN, { ...sb.env, CLAUDE_CODE_ENTRYPOINT: 'cli' }, r.spawner);
  assert.match(interactive, /^The kharos command is: .*The session id is k-0001\.$/m);
  assert.equal(r.calls.length, 0);

  // The agent is starting: the session counts as followed, so nothing starts a second follower.
  assert.equal(startFollowers(sb.paths, id, T0 + MIN, { ...sb.env, ...HEADLESS }, r.spawner), 'a live follower already reads k-0001.');
  assert.equal(r.calls.length, 0);
  fs.rmSync(sb.paths.followers, { recursive: true, force: true });

  // A person who lifted the ceiling keeps the follower agent inside the headless launch.
  const waits = startFollowers(sb.paths, id, T0 + MIN, { ...sb.env, ...HEADLESS, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }, r.spawner);
  assert.match(waits, /^The kharos command is:/m);
  assert.equal(r.calls.length, 0);
  fs.rmSync(sb.paths.followers, { recursive: true, force: true });

  const headless = startFollowers(sb.paths, id, T0 + MIN, { ...sb.env, ...HEADLESS }, r.spawner);
  assert.deepEqual(r.calls, [{ args: ['follow', id], log: followerLog(sb.paths, id) }]);
  assert.doesNotMatch(headless, /The kharos command is:/, 'no agent prompt to start');
  assert.match(headless, /^started a follower process for k-0001 \(pid 4242\)/m);
  assert.match(headless, /background agents are stopped 10 minutes after the last turn/);
  assert.match(headless, new RegExp(`Its events go to desktop notifications, ${sb.paths.state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/events\\.jsonl; kharos list shows the state\\.`));
  assert.match(headless, /claude -p '\/kharos:send k-0001 <answer>'/);
  assert.match(headless, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0/);

  // A live follower already reads it: no second process.
  takeLease(sb.paths, id, T0 + MIN, process.ppid);
  assert.equal(startFollowers(sb.paths, id, T0 + MIN, { ...sb.env, ...HEADLESS }, r.spawner), 'a live follower already reads k-0001.');
  assert.equal(detachFollower(sb.paths, id, T0 + MIN, sb.env, r.spawner), 'a live follower already reads k-0001.');
  assert.equal(r.calls.length, 1);
});

test('follow: the shell loop prints each change, goes on by itself, and stops at the end', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  const base = { kharos: 'wait', id, state: 'running', notice: null, url: null, waited_s: 1, reads: 1, reader_cost_usd: 0, report: '' } as const;
  const answers: WaitOutcome[] = [
    { ...base, changed: false, key: 'ok' },
    { ...base, changed: true, key: 'session.waiting_answer|t1', state: 'waiting_answer', question: 'Which?' },
    { ...base, changed: true, key: 'end:finished', state: 'finished' },
  ];
  const sinces: (string | null)[] = [];
  const lines: string[] = [];
  const code = await followLoop(sb.paths, {
    id,
    env: sb.env,
    write: (l) => lines.push(l),
    wait: async (_p, o) => {
      sinces.push(o.since);
      assert.equal(o.follower, 'shell');
      return answers.shift() as WaitOutcome;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(sinces, [null, 'ok', 'session.waiting_answer|t1']);
  assert.deepEqual(lines.map((l) => JSON.parse(l).key), ['session.waiting_answer|t1', 'end:finished']);

});

test('follow: a failed wait is tried again with a growing delay, and only then the outputs hear nobody follows', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  const base = { kharos: 'wait', id, state: 'running', notice: null, url: null, waited_s: 1, reads: 1, reader_cost_usd: 0, report: '' } as const;
  const failure: WaitOutcome = { ...base, changed: false, key: 'ok', error: 'reads failed' };
  const slept: number[] = [];
  const followedWhileAsleep: boolean[] = [];
  let delivered = 0;
  const loop = (answers: WaitOutcome[], lines: string[]) =>
    followLoop(sb.paths, {
      id,
      env: sb.env,
      write: (l) => lines.push(l),
      wait: async () => answers.shift() ?? failure,
      sleep: async (ms) => {
        slept.push(ms);
        followedWhileAsleep.push(liveFollowers(sb.paths, Date.now()).has(id));
      },
      deliver: async () => {
        delivered++;
        return { sent: 0, failed: 0, gaveUp: [], skipped: false, configError: null };
      },
    });

  // A short outage: the follower goes on after it, and the outputs hear nothing.
  const lines: string[] = [];
  const recovered = await loop([failure, failure, { ...base, changed: false, key: 'ok' }, { ...base, changed: true, key: 'end:finished', state: 'finished' }], lines);
  assert.equal(recovered, 0);
  assert.equal(slept.reduce((a, b) => a + b, 0), 3 * MIN);
  assert.ok(slept.every((ms) => ms < LEASE_STALE_MS));
  assert.ok(followedWhileAsleep.every(Boolean));
  assert.equal(liveFollowers(sb.paths, Date.now()).has(id), false);
  assert.equal(delivered, 0);
  assert.equal(readOutbox(sb.paths).filter((i) => i.event.event === 'session.unfollowed').length, 0);
  assert.equal(JSON.parse(lines.at(-1) ?? '{}').key, 'end:finished');

  // Reads that keep failing: four tries over about 15 minutes, then a needs_you event and exit 1.
  slept.length = 0;
  followedWhileAsleep.length = 0;
  const failed = await loop([], lines);
  assert.equal(failed, 1);
  assert.equal(slept.reduce((a, b) => a + b, 0), 15 * MIN);
  assert.ok(followedWhileAsleep.length > 0 && followedWhileAsleep.every(Boolean));
  assert.equal(liveFollowers(sb.paths, Date.now()).has(id), false);
  assert.match(lines.at(-1) ?? '', /reads failed/);
  assert.equal(delivered, 1);
  const events = readOutbox(sb.paths).filter((i) => i.event.event === 'session.unfollowed');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event.class, 'needs_you');
  assert.equal(events[0]?.event.session, id);
  assert.match(events[0]?.event.reason ?? '', new RegExp(`kharos follow ${id} --detach`));

  // The notice stays open, so the next follower that reads the session running again reports it back,
  // and a follower started again does not wake on it before its first read.
  const s = loadRegistry(sb.paths).sessions[id];
  assert.equal(s?.notice?.event, 'session.unfollowed');
  assert.equal(stopKey(s as Session), 'ok');
  const back = transition(s as Session, { state: 'running', notice: null, reason: 'running' }, Date.now(), 30, false);
  assert.deepEqual(back.map((e) => e.event), ['session.back']);
});

test('follow: a detached follower runs on its own and writes to its log', async () => {
  const sb = sandbox();
  const id = openOne(sb);
  close(sb.paths, id, T0 + MIN);
  // A closed session ends the loop at once, so the real process exits right after its first look.
  const pid = detachedSpawner(['follow', id], followerLog(sb.paths, id), sb.env);
  assert.ok(pid && pid > 0);
  const deadline = Date.now() + 20_000;
  let text = '';
  while (Date.now() < deadline) {
    text = fs.existsSync(followerLog(sb.paths, id)) ? fs.readFileSync(followerLog(sb.paths, id), 'utf8') : '';
    if (text.includes('end:closed')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(text, /"key":"end:closed"/);
  assert.equal(fs.statSync(followerLog(sb.paths, id)).mode & 0o777, 0o600);
});

test('wait: a report for the shell loop says how to answer from a shell, and never asks to start an agent', async () => {
  const { outcome } = await import('../src/wait.ts');
  const sb = sandbox();
  const id = openOne(sb);
  const { loadRegistry } = await import('../src/registry.ts');
  const s = { ...loadRegistry(sb.paths).sessions[id]!, state: 'waiting_answer' as const, notice: { event: 'session.waiting_answer', at: 't' } as any };
  s.result = { ...s.result, question: 'Which?' };
  const shell = outcome(s, 'session.waiting_answer|t', true, { waitedMs: 0, reads: 0, cost: 0, follower: 'shell' });
  assert.match(shell.report, /claude -p '\/kharos:send k-0001 <answer>' from a shell/);
  assert.doesNotMatch(shell.report, /kharos:follow/);
  const agent = outcome(s, 'session.waiting_answer|t', true, { waitedMs: 0, reads: 0, cost: 0 });
  assert.match(agent.report, /subagent_type "kharos:follow"/);
});

test('stop hook: at a turn end, an open session that nobody follows gets one follower process, and only one', () => {
  const sb = sandbox();
  const id = openOne(sb);
  const calls: string[][] = [];
  // The spawned process gets the lease under its pid: this test's own process, so it counts as live.
  const spawner: Spawner = (args) => (calls.push(args), process.pid);
  const ctx = (now: number, env: NodeJS.ProcessEnv = sb.env) => ({ ...sb.ctx(now), env, spawner });
  const input: HookInput = { hook_event_name: 'Stop', session_id: 'person' };

  // Right after the fire, the follower may still be starting.
  assert.equal(stop(ctx(T0 + 30_000), input), null);
  // In kharos's own sessions (a reader, a follower process, a fire), nothing happens.
  assert.equal(stop(ctx(T0 + 2 * MIN, { ...sb.env, KHAROS_ROLE: 'reader' }), input), null);
  assert.equal(calls.length, 0);

  const out = stop(ctx(T0 + 2 * MIN), input) as { systemMessage: string };
  assert.deepEqual(calls, [['follow', id]]);
  assert.match(out.systemMessage, /^kharos: k-0001 had no follower; a follower process reads it now \(pid \d+\)/);
  assert.equal(followerReport(sb.paths, T0 + 2 * MIN)[0]?.kind, 'shell');
  // The next turn end finds it followed.
  assert.equal(stop(ctx(T0 + 2 * MIN + 1000), input), null);
  assert.equal(calls.length, 1);
});

test('stop hook: a handover, the watcher, a closed or ended session, or no session start nothing', () => {
  const sb = sandbox();
  const calls: string[][] = [];
  const spawner: Spawner = (args) => (calls.push(args), process.pid);
  const ctx = (now: number) => ({ ...sb.ctx(now), spawner });
  const input: HookInput = { hook_event_name: 'Stop', session_id: 'person' };
  writeConfig(sb);
  assert.equal(stop(ctx(T0), input), null, 'nothing open');
  assert.equal(fs.existsSync(sb.paths.followers), false, 'and nothing written');

  const id = openOne(sb);
  // A follower agent is about to start again: its lease was handed over.
  takeLease(sb.paths, id, T0, process.pid, 'agent');
  releaseLease(sb.paths, id, process.pid, T0 + MIN);
  assert.equal(stop(ctx(T0 + 2 * MIN), input), null);
  assert.equal(calls.length, 0);
  // The handover ran out: a follower process starts.
  assert.ok(stop(ctx(T0 + MIN + HANDOVER_MS + 1000), input));
  assert.equal(calls.length, 1);
  fs.rmSync(sb.paths.followers, { recursive: true, force: true });

  // The watcher runs: it reads the sessions nobody follows.
  updateWatch(sb.paths, (w) => {
    w.last_beat = new Date(T0 + 4 * MIN).toISOString();
    w.interval_min = 10;
  });
  assert.equal(stop(ctx(T0 + 5 * MIN), input), null);
  // The watcher session itself: nothing either, even once the watcher's heartbeat is old.
  updateWatch(sb.paths, (w) => {
    w.watchers['watcher-1'] = new Date(T0 + 39 * MIN).toISOString();
  });
  assert.equal(stop(ctx(T0 + 40 * MIN), { hook_event_name: 'Stop', session_id: 'watcher-1' }), null);
  assert.equal(calls.length, 1);

  close(sb.paths, id, T0 + 50 * MIN);
  assert.equal(stop(ctx(T0 + 50 * MIN), input), null);
  assert.equal(calls.length, 1);
});

test('stop hook: the plugin registers it, and the CLI runs it', async () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  assert.deepEqual(hooks.hooks.Stop[0].hooks[0].args.slice(1), ['hook', 'stop']);
  const sb = sandbox();
  writeConfig(sb);
  const r = await captured(() => runHook('stop', sb.ctx(T0), () => JSON.stringify({ hook_event_name: 'Stop', session_id: 'person' })));
  assert.equal(r.value, 0);
  assert.equal(r.stdout, '');
});

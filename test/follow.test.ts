import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { close } from '../src/commands.ts';
import { detachedSpawner, detachFollower, followerLog, followLoop, isHeadless, startFollowers, type Spawner } from '../src/follow.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { takeLease } from '../src/lease.ts';
import type { WaitOutcome } from '../src/wait.ts';
import { HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

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

  // A person who lifted the ceiling keeps the follower agent inside the headless launch.
  const waits = startFollowers(sb.paths, id, T0 + MIN, { ...sb.env, ...HEADLESS, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }, r.spawner);
  assert.match(waits, /^The kharos command is:/m);
  assert.equal(r.calls.length, 0);

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

  const failed = await followLoop(sb.paths, { id, env: sb.env, write: (l) => lines.push(l), wait: async () => ({ ...base, changed: false, key: 'ok', error: 'reads failed' }) });
  assert.equal(failed, 1);
  assert.match(lines.at(-1) ?? '', /reads failed/);
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

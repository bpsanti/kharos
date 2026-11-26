import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readAuthStatus } from '../src/account.ts';
import { main } from '../src/cli.ts';
import { close, list, queueLines, resume, show } from '../src/commands.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import { readOutbox } from '../src/events.ts';
import type { Spawner } from '../src/follow.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { LaunchError, prepare } from '../src/launch.ts';
import { dispatchQueued, kickQueue, MAX_FIRE_TRIES, RETRY_AFTER_MS, type Fire } from '../src/queue.ts';
import { activeCount, loadRegistry, updateRegistry } from '../src/registry.ts';
import { recordAccess } from '../src/repo.ts';
import { captured, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const MIN = 60_000;
/** The account that queued the launches: the one the sandbox is logged in with. */
const ACCOUNT = () => readAuthStatus(sandbox().env)?.account ?? null;

function h(ti: Record<string, unknown>, tool_response?: unknown, session = 'person'): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: session, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function launchOpts(sb: Sandbox, extra: Record<string, unknown> = {}) {
  return { instruction: 'Fix the typo.', claude_session: 'person', now: T0, env: sb.env, heads: () => HEADS_OK, ...extra };
}

/** Fires a prepared launch through the hooks, as /kharos:run does, and returns its trigger id. */
function fireByHand(sb: Sandbox, id: string, n: number, now = T0): string {
  const trig = `trig_${String(n).padStart(4, '0')}`;
  const pre = preToolUse(sb.ctx(now), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(now), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: trig } })));
  preToolUse(sb.ctx(now), h({ action: 'run', trigger_id: trig }));
  postToolUse(sb.ctx(now), h({ action: 'run', trigger_id: trig }, response(200, { session_id: `cse_01OPENSESSION${String(n).padStart(4, '0')}AAAAAAAA` })));
  return trig;
}

/** One slot, taken by an open session: the next launch with --queue waits. */
function full(sb: Sandbox): { open: string; queued: string } {
  writeConfig(sb, { watch: { max_open: 1 } });
  const open = prepare(sb.paths, launchOpts(sb)).id;
  fireByHand(sb, open, 1);
  const queued = prepare(sb.paths, launchOpts(sb, { queue: true, now: T0 + MIN })).id;
  return { open, queued };
}

/** Ends a session the way a read does. */
function finish(sb: Sandbox, id: string): void {
  updateRegistry(sb.paths, (reg) => {
    reg.sessions[id]!.state = 'finished';
  });
}

/** A fire that makes the calls a headless Claude Code would, through the hooks; `runs` sends run that many times. */
function hookFire(sb: Sandbox, runs = 1, calls: string[] = []): Fire {
  let n = 100;
  return async (_paths, id) => {
    calls.push(id);
    const trig = `trig_q${n++}`;
    const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }, undefined, 'fire'));
    if ((pre?.hookSpecificOutput as any)?.permissionDecision !== 'allow') return { ok: false, error: 'create denied' };
    postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: trig } }), 'fire'));
    for (let i = 0; i < runs; i++) {
      const gate = preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: trig }, undefined, 'fire'));
      if ((gate?.hookSpecificOutput as any)?.permissionDecision === 'deny') continue;
      postToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: trig }, response(200, { session_id: `cse_01QUEUEDSESSION${n}AAAAAAAA` }), 'fire'));
    }
    return { ok: true, error: null };
  };
}

const noDeliver = async () => ({ sent: 0, failed: 0, gaveUp: [], skipped: false, configError: null });

test('queue: with every slot taken, --queue records the launch as queued, and a launch without it is refused', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  const s = loadRegistry(sb.paths).sessions[queued]!;
  assert.equal(s.step, 'queued');
  assert.equal(s.queue?.tries, 0);
  assert.equal(activeCount(loadRegistry(sb.paths)), 1, 'a queued launch holds no slot');
  assert.ok(fs.existsSync(path.join(sb.paths.bodies, `${queued}.json`)), 'its body is stored, as for any launch');
  const ev = readOutbox(sb.paths).map((x) => x.event).find((e) => e.event === 'session.queued');
  assert.equal(ev?.class, 'progress');
  assert.equal(ev?.session, queued);

  // Without --queue: refused, and the refusal says --queue exists; a queued launch is ahead of any new one.
  assert.throws(() => prepare(sb.paths, launchOpts(sb)), (err: unknown) => err instanceof LaunchError && /--queue/.test(err.message) && new RegExp(`queued launch\\(es\\) wait for a slot before any new one: ${queued}`).test(err.message));
  finish(sb, open);
  assert.throws(() => prepare(sb.paths, launchOpts(sb)), LaunchError, 'the free slot is the queued launch\'s');

  assert.match(list(sb.paths, { all: false, now: T0 + 3 * MIN }), new RegExp(`^${queued}  queued `, 'm'));
  assert.match(queueLines(sb.paths, T0 + 3 * MIN)[0]!, new RegExp(`^queue: ${queued} \\(1st in line, queued 2 min ago\\)\\. Each fires by itself when a slot frees, a paid action with nobody present; /kharos:close <id> cancels one\\.$`));
  assert.match(show(sb.paths, queued), new RegExp(`^${queued} queued `));
  // Nobody creates it by hand while it waits.
  const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: queued } }));
  assert.equal((pre?.hookSpecificOutput as any).permissionDecision, 'deny');
  assert.match((pre?.hookSpecificOutput as any).permissionDecisionReason, /is queued for a free slot/);
});

test('queue: prepare --queue says it is queued and that nothing is to be called now', async () => {
  const sb = sandbox();
  writeConfig(sb, { watch: { max_open: 1 } });
  recordAccess(sb.paths, 'https://github.com/example/demo', 'ok', null, T0);
  fireByHand(sb, prepare(sb.paths, launchOpts(sb)).id, 1);
  const r = await captured(() => main(['prepare', '--queue', '--session', 'person'], sb.env, () => 'Fix the other typo.'));
  assert.equal(r.value, 0);
  assert.match(r.stdout, /^k-0002 queued: every watch\.max_open slot is taken\. It fires by itself when one frees: kharos then creates and runs it from a headless Claude Code in auto mode, a paid action with nobody present/);
  assert.match(r.stdout, /Do not call RemoteTrigger for it now\./);
  // With a free slot, --queue launches as usual.
  writeConfig(sb, { watch: { max_open: 5 } });
  const free = await captured(() => main(['prepare', '--queue', '--session', 'person'], sb.env, () => 'One more.'));
  assert.match(free.stdout, /^k-0003 prepared: /);
});

test('queue: refused when the organization disabled auto mode, since nobody could approve the fire', () => {
  const sb = sandbox();
  writeConfig(sb, { watch: { max_open: 1 } });
  fireByHand(sb, prepare(sb.paths, launchOpts(sb)).id, 1);
  fs.mkdirSync(path.join(sb.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.claude', 'remote-settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' } }));
  assert.throws(() => prepare(sb.paths, launchOpts(sb, { queue: true })), /turn auto mode off \(permissions\.disableAutoMode\): a queued launch is fired in auto mode/);
});

test('queue: when a slot frees, the dispatcher fires the oldest queued launch once and starts its follower', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  const second = prepare(sb.paths, launchOpts(sb, { queue: true, now: T0 + 2 * MIN })).id;
  const spawned: string[][] = [];
  const spawner: Spawner = (args) => (spawned.push(args), process.pid);
  const calls: string[] = [];

  // No free slot: nothing to fire, and no dispatcher starts.
  assert.deepEqual(await dispatchQueued(sb.paths, { env: sb.env, fire: hookFire(sb, 1, calls), spawner, account: ACCOUNT, deliver: noDeliver }), []);
  assert.equal(kickQueue(sb.paths, T0 + 3 * MIN, sb.env, spawner), null);
  assert.equal(calls.length, 0);

  finish(sb, open);
  // The slot frees: a hook or a command starts the dispatcher, once.
  assert.equal(kickQueue(sb.paths, T0 + 3 * MIN, sb.env, spawner), process.pid);
  assert.deepEqual(spawned, [['dispatch']]);
  assert.equal(kickQueue(sb.paths, T0 + 3 * MIN, sb.env, spawner), null, 'a dispatcher runs already');
  assert.equal(kickQueue(sb.paths, T0 + 3 * MIN, { ...sb.env, KHAROS_ROLE: 'fire' }, spawner), null);
  fs.rmSync(path.join(sb.paths.state, 'dispatch.json'));

  // The fire sends run twice: the hook allows one, so one session starts.
  const lines = await dispatchQueued(sb.paths, { env: sb.env, fire: hookFire(sb, 2, calls), spawner, account: ACCOUNT, deliver: noDeliver });
  assert.deepEqual(calls, [queued], 'the oldest first, and only as many as there are free slots');
  const s = loadRegistry(sb.paths).sessions[queued]!;
  assert.equal(s.step, 'open');
  assert.equal(s.queue?.tries, 1);
  assert.ok(s.queue?.fired_by_queue_at);
  assert.equal(lines[0], `${queued}: fired`);
  assert.match(lines[1]!, new RegExp(`^started a follower process for ${queued}`));
  assert.deepEqual(spawned.at(-1), ['follow', queued]);
  assert.equal(readOutbox(sb.paths).filter((x) => x.event.event === 'session.opened' && x.event.session === queued).length, 1);
  assert.equal(loadRegistry(sb.paths).sessions[second]?.step, 'queued', 'the next one waits for the next slot');
  assert.equal(fs.existsSync(path.join(sb.paths.state, 'dispatch.json')), false);
});

test('queue: only the account that queued a launch fires it', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  finish(sb, open);
  const calls: string[] = [];
  const opts = { env: sb.env, fire: hookFire(sb, 1, calls), spawner: (() => process.pid) as Spawner, account: () => 'another', deliver: noDeliver };
  await dispatchQueued(sb.paths, opts);
  await dispatchQueued(sb.paths, { ...opts, now: () => Date.now() + RETRY_AFTER_MS + 1000 });
  assert.equal(calls.length, 0);
  const s = loadRegistry(sb.paths).sessions[queued]!;
  assert.equal(s.step, 'queued');
  assert.match(s.queue?.blocked ?? '', /not the one that queued it/);
  const notFired = readOutbox(sb.paths).filter((x) => x.event.event === 'session.not_fired');
  assert.equal(notFired.length, 1, 'said once, not at every try');
  assert.equal(notFired[0]?.event.class, 'needs_you');
});

test('queue: a fire that does not go through is tried again later, then left to the person', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  finish(sb, open);
  let t = Date.now();
  const failing: Fire = async () => ({ ok: false, error: 'claude -p exited 1' });
  const opts = { env: sb.env, fire: failing, spawner: (() => process.pid) as Spawner, account: ACCOUNT, deliver: noDeliver, now: () => t };
  for (let i = 1; i <= MAX_FIRE_TRIES; i++) {
    await dispatchQueued(sb.paths, opts);
    const s = loadRegistry(sb.paths).sessions[queued]!;
    assert.equal(s.step, 'queued');
    assert.equal(s.queue?.tries, i);
    // Before the retry time, nothing starts the dispatcher.
    assert.equal(kickQueue(sb.paths, t + 1000, sb.env, () => process.pid), null);
    t += RETRY_AFTER_MS + 1000;
  }
  const s = loadRegistry(sb.paths).sessions[queued]!;
  assert.equal(s.queue?.next_try_at, null);
  assert.equal(kickQueue(sb.paths, t, sb.env, () => process.pid), null, 'no more fires by itself');
  const ev = readOutbox(sb.paths).find((x) => x.event.event === 'session.not_fired')?.event;
  assert.match(ev?.reason ?? '', new RegExp(`not fired after ${MAX_FIRE_TRIES} tries .*claude -p exited 1.*/kharos:run --resume ${queued}`));
  assert.match(queueLines(sb.paths, t)[0]!, /not fired: claude -p exited 1/);
  const checks = runDoctor(sb.paths, { now: t, env: sb.env }, doctorDeps);
  assert.equal(checks.find((c) => c.name === 'queue')?.level, 'warn');
  assert.match(formatChecks(checks), /queue/);
  // With the person present, resume takes the free slot.
  assert.match(resume(sb.paths, queued), /a slot is free\. Call RemoteTrigger with action "create"/);
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.step, 'prepared');
});

test('queue: resume keeps a launch queued while no slot is free, and close cancels it', () => {
  const sb = sandbox();
  const { queued } = full(sb);
  assert.match(resume(sb.paths, queued), new RegExp(`^${queued} is still queued \\(1 in line\\)`));
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.step, 'queued');
  assert.match(close(sb.paths, queued, T0 + 5 * MIN), /was queued, and is cancelled: no routine was created and nothing was spent/);
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.step, 'closed');
  assert.deepEqual(queueLines(sb.paths, T0 + 5 * MIN), []);
});

test('queue: a launch the person resumes is theirs: the dispatcher neither fires nor retries it', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  finish(sb, open);
  assert.match(resume(sb.paths, queued), /a slot is free\. Call RemoteTrigger with action "create"/);
  const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: queued } }));
  postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: 'trig_person' } })));
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.step, 'routine_created');
  assert.equal(kickQueue(sb.paths, Date.now(), sb.env, () => process.pid), null, 'no dispatcher for a routine the person created');
  const calls: string[] = [];
  await dispatchQueued(sb.paths, { env: sb.env, fire: hookFire(sb, 1, calls), spawner: (() => process.pid) as Spawner, account: ACCOUNT, deliver: noDeliver });
  assert.deepEqual(calls, []);
  const gate = preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: 'trig_person' }));
  assert.notEqual((gate?.hookSpecificOutput as any)?.permissionDecision, 'deny', 'the person\'s own run goes through');
});

test('queue: resuming a routine the queue created but did not run stops its automatic retries', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  finish(sb, open);
  let t = Date.now();
  const createOnly: Fire = async (_paths, id) => {
    const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }, undefined, 'fire'));
    postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: 'trig_q1' } }), 'fire'));
    return { ok: false, error: 'the run was not approved' };
  };
  await dispatchQueued(sb.paths, { env: sb.env, fire: createOnly, spawner: (() => process.pid) as Spawner, account: ACCOUNT, deliver: noDeliver, now: () => t });
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.step, 'routine_created');
  t += RETRY_AFTER_MS + 1000;
  assert.notEqual(kickQueue(sb.paths, t, sb.env, () => process.pid), null, 'the queue retries its own routine');
  fs.rmSync(path.join(sb.paths.state, 'dispatch.json'), { force: true });
  assert.match(resume(sb.paths, queued), /action "run" and trigger_id "trig_q1", once/);
  assert.equal(kickQueue(sb.paths, t, sb.env, () => process.pid), null, 'once the person took it, no dispatcher');
  assert.deepEqual(queueLines(sb.paths, t), []);
});

test('queue: a launch left to the person holds up neither the younger queued launches nor a new launch', async () => {
  const sb = sandbox();
  const { open, queued } = full(sb);
  const younger = prepare(sb.paths, launchOpts(sb, { queue: true, now: T0 + 2 * MIN })).id;
  finish(sb, open);
  let t = Date.now();
  const failing: Fire = async () => ({ ok: false, error: 'claude -p exited 1' });
  for (let i = 0; i < MAX_FIRE_TRIES; i++) {
    await dispatchQueued(sb.paths, { env: sb.env, fire: failing, spawner: (() => process.pid) as Spawner, account: ACCOUNT, deliver: noDeliver, now: () => t });
    t += RETRY_AFTER_MS + 1000;
  }
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.queue?.tries, MAX_FIRE_TRIES);
  assert.equal(loadRegistry(sb.paths).sessions[younger]?.queue?.tries, 0, 'the oldest was tried first');
  const calls: string[] = [];
  await dispatchQueued(sb.paths, { env: sb.env, fire: hookFire(sb, 1, calls), spawner: (() => process.pid) as Spawner, account: ACCOUNT, deliver: noDeliver, now: () => t });
  assert.deepEqual(calls, [younger], 'the younger one fires in the free slot');
  finish(sb, younger);
  const fresh = prepare(sb.paths, launchOpts(sb, { now: T0 + 3 * MIN }));
  assert.equal(fresh.step, 'prepared', 'a new launch takes the free slot');
  assert.equal(loadRegistry(sb.paths).sessions[queued]?.step, 'queued');
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

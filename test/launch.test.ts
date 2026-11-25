import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { close, list, logRequest, rearm, sendMessage, result, resume, writeProfile } from '../src/commands.ts';
import { main, runHook } from '../src/cli.ts';
import { postToolUse, postToolUseFailure, preToolUse, type HookInput } from '../src/hook.ts';
import { LaunchError, prepare } from '../src/launch.ts';
import { loadRegistry } from '../src/registry.ts';
import { loadRepos } from '../src/repo.ts';
import { addIntent } from '../src/state.ts';
import { captured, fixture, HEADS_EMPTY, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const CLAUDE = 'claude-session-1';

function hook(ti: Record<string, unknown>, tool_response?: unknown): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: CLAUDE, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function prepared(sb: Sandbox, instruction = 'Fix the typo in README.md, run the tests and open a PR.'): string {
  writeConfig(sb);
  return prepare(sb.paths, { instruction, claude_session: CLAUDE, now: T0, env: sb.env, heads: () => HEADS_OK }).id;
}

function summaryOf(out: Record<string, unknown> | null): string {
  const h = out?.hookSpecificOutput as Record<string, any> | undefined;
  return h?.updatedToolOutput?.summary ?? '';
}

/** Runs create and run through the hooks the way the model does, and returns the trigger id. */
function launch(sb: Sandbox, id: string, sessionId = 'cse_01TESTSESSIONAAAAAAAAAAA'): string {
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }));
  const updated = (pre?.hookSpecificOutput as any).updatedInput;
  assert.equal((pre?.hookSpecificOutput as any).permissionDecision, 'allow');
  const created = postToolUse(sb.ctx(T0), hook(updated, response(200, { outcome: 'CREATE_TRIGGER_OUTCOME_CREATED', trigger: { id: 'trig_01TESTROUTINEAAAAAAAAAAA' } })));
  assert.match(summaryOf(created), /routine created/);
  assert.equal(preToolUse(sb.ctx(T0), hook({ action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' })), null);
  const ran = postToolUse(sb.ctx(T0 + 1000), hook({ action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, response(200, { session_id: sessionId })));
  assert.match(summaryOf(ran), /is open: https:\/\/claude\.ai\/code\/session_01TESTSESSIONAAAAAAAAAAA/);
  return 'trig_01TESTROUTINEAAAAAAAAAAA';
}

test('launch: prepare, create with the stored body, run once, and the session is open', () => {
  const sb = sandbox();
  const id = prepared(sb);
  assert.equal(id, 'k-0001');
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }));
  const body = (pre?.hookSpecificOutput as any).updatedInput.body;
  assert.equal(body.name.startsWith('kharos k-0001: Fix the typo'), true);
  assert.match(body.job_config.ccr.events[0].data.message.content, /^Fix the typo in README\.md/);
  launch(sb, id);
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.step, 'open');
  assert.equal(s.trigger_id, 'trig_01TESTROUTINEAAAAAAAAAAA');
  assert.equal(s.session_id, 'cse_01TESTSESSIONAAAAAAAAAAA');
  assert.equal(s.url, 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA');
  assert.equal(loadRepos(sb.paths)['example/demo']?.access, 'ok');
  assert.equal(fs.statSync(sb.paths.registry).mode & 0o777, 0o600);
});

test('launch: a second run of the same routine is denied, before and after the answer', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const trig = launch(sb, id);
  const again = preToolUse(sb.ctx(T0 + 5000), hook({ action: 'run', trigger_id: trig }));
  assert.equal((again?.hookSpecificOutput as any).permissionDecision, 'deny');
  assert.match((again?.hookSpecificOutput as any).permissionDecisionReason, /second paid session/);
  assert.equal(preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }))?.hookSpecificOutput !== undefined, true);
  assert.equal(((preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }))?.hookSpecificOutput) as any).permissionDecision, 'deny');
});

test('launch: a lost run answer is recovered from list_runs, never by firing again', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(T0), hook((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: 'trig_01TESTROUTINEAAAAAAAAAAA' } })));
  preToolUse(sb.ctx(T0), hook({ action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }));
  // The local session died before the run answer reached the hook.
  assert.match(resume(sb.paths, id), /Do not run it again: call RemoteTrigger with action "list_runs"/);
  const out = postToolUse(
    sb.ctx(T0 + 60_000),
    hook({ action: 'list_runs', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, response(200, { data: [{ id: 'cse_01TESTSESSIONAAAAAAAAAAA', status: 'active', worker_status: 'running', url: 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA' }] })),
  );
  assert.match(summaryOf(out), /run active/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'open');
});

/** Creates the routine and lets the hook allow its fire, with no answer to the run yet. */
function fired(sb: Sandbox, id: string): string {
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(T0), hook((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: 'trig_01TESTROUTINEAAAAAAAAAAA' } })));
  assert.equal(preToolUse(sb.ctx(T0), hook({ action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' })), null);
  return 'trig_01TESTROUTINEAAAAAAAAAAA';
}

const NO_RUNS = response(200, { data: [], next_cursor: null });

test('launch: an empty list_runs keeps the fire and never tells the model to fire again', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const trig = fired(sb, id);
  assert.match(resume(sb.paths, id), /Do not run it again: call RemoteTrigger with action "list_runs"/);
  for (const t of [T0 + 30_000, T0 + 60 * 60_000]) {
    const text = summaryOf(postToolUse(sb.ctx(t), hook({ action: 'list_runs', trigger_id: trig }, NO_RUNS)));
    assert.match(text, /no session is visible yet\. Do not run again/);
    assert.match(text, /https:\/\/claude\.ai\/code\/routines\/trig_01TESTROUTINEAAAAAAAAAAA/);
    assert.match(text, /\/kharos:run --rearm k-0001/);
    assert.doesNotMatch(text, /may be fired|fire it once more/);
    assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'firing');
  }
  assert.equal((preToolUse(sb.ctx(T0 + 61 * 60_000), hook({ action: 'run', trigger_id: trig }))?.hookSpecificOutput as any).permissionDecision, 'deny');
});

test('rearm: refused without an empty list_runs in the last 10 minutes', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const trig = fired(sb, id);
  assert.throws(() => rearm(sb.paths, id, T0 + 60_000), /no empty list_runs in the last 10 minutes/);
  postToolUse(sb.ctx(T0 + 60_000), hook({ action: 'list_runs', trigger_id: trig }, NO_RUNS));
  assert.throws(() => rearm(sb.paths, id, T0 + 60_000 + 11 * 60_000), /no empty list_runs in the last 10 minutes/);
  assert.throws(() => rearm(sb.paths, id, T0 + 59_000), /no empty list_runs in the last 10 minutes/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'firing');
});

test('rearm: refused for a launch that is not firing', () => {
  const sb = sandbox();
  const id = prepared(sb);
  assert.throws(() => rearm(sb.paths, id, T0), /not waiting on a fire \(step prepared\)/);
  launch(sb, id);
  postToolUse(sb.ctx(T0 + 2000), hook({ action: 'list_runs', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, NO_RUNS));
  assert.throws(() => rearm(sb.paths, id, T0 + 3000), /not waiting on a fire \(step open\)/);
});

test('rearm: then resume allows exactly one more run', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const trig = fired(sb, id);
  // The CLI reads the real clock, so the empty list_runs is recorded now.
  postToolUse(sb.ctx(Date.now()), hook({ action: 'list_runs', trigger_id: trig }, NO_RUNS));
  const r = captured(() => main(['rearm', id], sb.env, () => ''));
  assert.equal(r.value, 0);
  assert.match(r.stdout, /k-0001 re-armed\. To fire it once, type \/kharos:run --resume k-0001/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'routine_created');
  assert.match(resume(sb.paths, id), /action "run" and trigger_id "trig_01TESTROUTINEAAAAAAAAAAA", once/);
  const now = Date.now();
  assert.equal(preToolUse(sb.ctx(now), hook({ action: 'run', trigger_id: trig })), null);
  assert.equal((preToolUse(sb.ctx(now + 1000), hook({ action: 'run', trigger_id: trig }))?.hookSpecificOutput as any).permissionDecision, 'deny');
  assert.throws(() => rearm(sb.paths, id, now + 2000), /no empty list_runs/);
});

test('launch: list_runs does not reopen a closed launch', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const trig = fired(sb, id);
  close(sb.paths, id, T0 + 1000);
  postToolUse(sb.ctx(T0 + 2000), hook({ action: 'list_runs', trigger_id: trig }, response(200, { data: [{ id: 'cse_01TESTSESSIONAAAAAAAAAAA', status: 'active' }] })));
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.step, 'closed');
  assert.equal(s.session_id, null);
});

/** Runs the pre-tool-use hook the way Claude Code does and returns what it printed. */
function runPreHook(sb: Sandbox, ti: Record<string, unknown>): { code: number; printed: string } {
  const r = captured(() => runHook('pre-tool-use', sb.ctx(T0), () => JSON.stringify(hook(ti))));
  return { code: r.value, printed: r.stdout };
}

test('hooks: with unreadable kharos state, a run and a kharos create are denied and other calls pass', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.paths.state, { recursive: true });
  fs.writeFileSync(sb.paths.registry, '{"version": 1, "sessions": ');
  for (const ti of [{ action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, { action: 'create', body: { kharos_launch: 'k-0001' } }]) {
    const { code, printed } = runPreHook(sb, ti);
    assert.equal(code, 0);
    const h = JSON.parse(printed).hookSpecificOutput;
    assert.equal(h.permissionDecision, 'deny');
    assert.ok(h.permissionDecisionReason.includes(sb.paths.registry), 'the reason names the state file');
    assert.match(h.permissionDecisionReason, /kharos state could not be read/);
  }
  assert.equal(runPreHook(sb, { action: 'create', body: { name: 'my own routine' } }).printed, '');
  assert.equal(runPreHook(sb, { action: 'list' }).printed, '');
});

test('hooks: a registry lock left by a dead holder is taken over, so a run is not denied', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const trig = fired(sb, id);
  fs.writeFileSync(sb.paths.registry, fs.readFileSync(sb.paths.registry, 'utf8').replace('"step": "firing"', '"step": "routine_created"'));
  const lock = `${sb.paths.registry}.lock`;
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(runPreHook(sb, { action: 'run', trigger_id: trig }).printed, '');
  assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'firing');
});

test('launch: repo_access_denied stops before any session, with the fix', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }));
  const out = postToolUse(
    sb.ctx(T0),
    hook((pre?.hookSpecificOutput as any).updatedInput, response(403, { error: { type: 'permission_error', message: 'Repository access denied', sub_reason: 'repo_access_denied' } })),
  );
  const text = summaryOf(out);
  assert.match(text, /was not created; nothing was started/);
  assert.match(text, /github\.com\/apps\/claude\/installations\/new/);
  assert.match(text, /Stop here/);
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.step, 'refused');
  assert.equal(loadRepos(sb.paths)['example/demo']?.access, 'denied');
  // A refused launch does not hold a slot, and a run for it is not possible.
  assert.equal(preToolUse(sb.ctx(T0), hook({ action: 'run', trigger_id: 'trig_x' })), null);
});

test('launch: local checks stop an empty repository, a missing branch, and too many open sessions', () => {
  const sb = sandbox();
  writeConfig(sb, { watch: { max_open: 1 } });
  assert.throws(() => prepare(sb.paths, { instruction: 'x', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_EMPTY }), (e: unknown) => e instanceof LaunchError && /no commit yet/.test(e.message));
  assert.throws(
    () => prepare(sb.paths, { instruction: 'x', claude_session: null, now: T0, env: sb.env, heads: () => ({ ...HEADS_OK, hasRevision: false, defaultBranch: 'trunk' }) }),
    /default branch is "trunk"/,
  );
  prepare(sb.paths, { instruction: 'one', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_OK });
  assert.throws(() => prepare(sb.paths, { instruction: 'two', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_OK }), /max_open is 1/);
  assert.throws(() => prepare(sb.paths, { instruction: '   ', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_OK }), /empty/);
});

test('launch: refuses an API key and a login that is not claude.ai', () => {
  const sb = sandbox({ auth: { loggedIn: true, authMethod: 'api_key' } });
  writeConfig(sb);
  assert.throws(() => prepare(sb.paths, { instruction: 'x', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_OK }), /claude\.ai account/);
  const sb2 = sandbox();
  writeConfig(sb2);
  assert.throws(() => prepare(sb2.paths, { instruction: 'x', claude_session: null, now: T0, env: { ...sb2.env, ANTHROPIC_API_KEY: 'k' }, heads: () => HEADS_OK }), /ANTHROPIC_API_KEY/);
});

test('hooks: calls about routines outside the registry pass untouched', () => {
  const sb = sandbox();
  prepared(sb);
  assert.equal(preToolUse(sb.ctx(T0), hook({ action: 'create', body: { name: 'my own routine' } })), null);
  assert.equal(preToolUse(sb.ctx(T0), hook({ action: 'run', trigger_id: 'trig_someone_else' })), null);
  assert.equal(postToolUse(sb.ctx(T0), hook({ action: 'create', body: { name: 'my own routine' } }, response(200, { trigger: { id: 'trig_z' } }))), null);
  assert.equal(postToolUse(sb.ctx(T0), hook({ action: 'get_run_log', session_id: 'cse_other' }, response(200, {}, 'x'))), null);
  assert.equal(postToolUse(sb.ctx(T0), hook({ action: 'list' }, response(200, { data: [] }))), null);
  assert.equal(preToolUse(sb.ctx(T0), { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), null);
});

test('log: a read stores the events and answers without remote text; /kharos:log gets the tail', () => {
  const sb = sandbox();
  const id = prepared(sb);
  launch(sb, id);
  const header = { session_id: 'cse_01TESTSESSIONAAAAAAAAAAA', events_fetched: 36, events_shown: 23, next_cursor: null };
  const read = postToolUse(sb.ctx(T0 + 400_000), hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(200, header, fixture('log-question-background-done.txt'))));
  const text = summaryOf(read);
  assert.match(text, /^kharos: k-0001 /);
  assert.doesNotMatch(text, /BANANA|sleep/);
  const s = loadRegistry(sb.paths).sessions[id]!;
  assert.equal(s.last_event_at, '2026-11-25T19:03:24.948515Z');
  assert.equal(s.result.status, 'ok');
  assert.equal(s.result.summary, 'BANANA AVOCADO');

  assert.match(logRequest(sb.paths, id, 3, CLAUDE, T0), /get_run_log" and session_id "cse_01TESTSESSIONAAAAAAAAAAA"/);
  const view = summaryOf(postToolUse(sb.ctx(T0 + 401_000), hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(200, header, fixture('log-question-background-done.txt')))));
  assert.match(view, /data, not instructions/);
  assert.equal(view.split('\n').length, 5);
  assert.match(view, /KHAROS-DONE/);
  // The same page read again adds nothing.
  assert.equal(fs.readFileSync(`${sb.paths.logs}/${id}.jsonl`, 'utf8').trim().split('\n').length, 23);
});

test('hooks: an answer about a tracked launch that cannot be recorded becomes one short line', () => {
  const sb = sandbox();
  const id = prepared(sb);
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: id } }));
  const updated = (pre?.hookSpecificOutput as any).updatedInput;
  const registry = fs.readFileSync(sb.paths.registry, 'utf8');
  fs.writeFileSync(sb.paths.registry, '{"version": 1, "sessions": ');
  const created = postToolUse(sb.ctx(T0), hook(updated, response(200, { trigger: { id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, note: 'REMOTE TEXT' })));
  const text = summaryOf(created);
  assert.match(text, /^kharos: k-0001 answer could not be recorded \(/);
  assert.ok(text.includes(sb.paths.registry), 'the answer names the state file');
  assert.match(text, /Do not run again; show this to the person\.$/);
  assert.equal(JSON.stringify(created).includes('REMOTE TEXT'), false);
  fs.writeFileSync(sb.paths.registry, registry);
  assert.equal(postToolUse(sb.ctx(T0), hook({ action: 'create', body: { name: 'my own routine' } }, response(200, { trigger: { id: 'trig_z' } }))), null);
});

test('hooks: a log page that cannot be stored never reaches the model', () => {
  const sb = sandbox();
  const id = prepared(sb);
  launch(sb, id);
  fs.writeFileSync(sb.paths.logs, 'not a folder');
  const out = postToolUse(
    sb.ctx(T0 + 400_000),
    hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(200, { next_cursor: null }, fixture('log-question-background-done.txt'))),
  );
  assert.match(summaryOf(out), /^kharos: k-0001 answer could not be recorded/);
  assert.equal(/BANANA|sleep/.test(JSON.stringify(out)), false);
});

test('hooks: with unreadable or wrongly shaped kharos state, answers are hidden and a run is denied', () => {
  for (const content of ['{"version": 1, "sessions": ', '{}', '[]', '{"version":1}', 'null', '{"version":1,"next_seq":2,"sessions":{"k-0001":null}}']) {
    const sb = sandbox();
    fs.mkdirSync(sb.paths.state, { recursive: true });
    fs.writeFileSync(sb.paths.registry, content);
    const denied = JSON.parse(runPreHook(sb, { action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }).printed).hookSpecificOutput;
    assert.equal(denied.permissionDecision, 'deny', `a run is denied with ${content}`);
    const answers = [
      hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(200, { next_cursor: null }, fixture('log-question-background-done.txt'))),
      hook({ action: 'list_runs', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, response(200, { data: [{ id: 'cse_REMOTE', title: 'REMOTE TEXT' }] })),
      hook({ action: 'run', trigger_id: 'trig_01TESTROUTINEAAAAAAAAAAA' }, response(200, { session_id: 'cse_REMOTE', note: 'REMOTE TEXT' })),
    ];
    for (const input of answers) {
      const out = postToolUse(sb.ctx(T0), input);
      const text = summaryOf(out);
      assert.match(text, /^kharos: kharos state could not be read \(/);
      assert.ok(text.includes(sb.paths.registry), 'the answer names the state file');
      assert.match(text, /until then RemoteTrigger answers are hidden here\.$/);
      assert.equal(/BANANA|sleep|REMOTE/.test(JSON.stringify(out)), false);
    }
  }
});

test('log: a 404 counts as a failed read, and so does a tool failure', () => {
  const sb = sandbox();
  const id = prepared(sb);
  launch(sb, id);
  postToolUse(sb.ctx(T0), hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(404, { error: { type: 'not_found_error' } })));
  postToolUseFailure(sb.ctx(T0), { hook_event_name: 'PostToolUseFailure', tool_name: 'RemoteTrigger', tool_input: { action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' } });
  assert.equal(loadRegistry(sb.paths).sessions[id]?.read_failures, 2);
});

test('environments: the routine list becomes the environment list only when asked', () => {
  const sb = sandbox();
  addIntent(sb.paths, { kind: 'environments', claude_session: CLAUDE }, T0);
  const out = postToolUse(sb.ctx(T0), hook({ action: 'list' }, response(200, { data: [{ job_config: { ccr: { environment_id: 'env_01AAA' } }, last_fired_at: '2026-11-25T00:00:00Z' }] })));
  assert.match(summaryOf(out), /env_01AAA {2}used by 1 routine/);
  assert.equal(postToolUse(sb.ctx(T0), hook({ action: 'list' }, response(200, { data: [] }))), null);
});

test('commands: list, sendMessage, result and close', () => {
  const sb = sandbox();
  const id = prepared(sb);
  launch(sb, id);
  postToolUse(
    sb.ctx(T0 + 400_000),
    hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(200, { next_cursor: null }, fixture('log-question-background-done.txt'))),
  );
  const listed = list(sb.paths, { all: false, now: T0 + 600_000 });
  assert.match(listed, /^k-0001 /);
  assert.match(listed, /watcher: never ran/);
  assert.match(sendMessage(sb.paths, id, 'Also add a test.', sb.env), /^sent to k-0001/);
  assert.equal(fs.readFileSync(`${sb.dir}/sent.txt`, 'utf8'), 'Also add a test.');
  const res = result(sb.paths, id, sb.env);
  assert.match(res, /KHAROS-DONE: ok/);
  assert.match(res, /claude --teleport cse_01TESTSESSIONAAAAAAAAAAA/);
  const closed = close(sb.paths, id, T0 + 700_000);
  assert.match(closed, /claude\.ai\/code\/routines\/trig_01TESTROUTINEAAAAAAAAAAA/);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.step, 'closed');
  assert.match(list(sb.paths, { all: false, now: T0 }), /no open sessions/);
});

test('result: a session woken by a message loses its old KHAROS-DONE until it writes a new one', () => {
  const sb = sandbox();
  const id = prepared(sb);
  launch(sb, id);
  const page = fixture('log-question-background-done.txt');
  const read = (t: number, text: string) =>
    postToolUse(sb.ctx(t), hook({ action: 'get_run_log', session_id: 'cse_01TESTSESSIONAAAAAAAAAAA' }, response(200, { next_cursor: null }, text)));
  read(T0 + 400_000, page);
  assert.equal(loadRegistry(sb.paths).sessions[id]?.result.status, 'ok');
  sendMessage(sb.paths, id, 'Also add a test.', sb.env);
  read(T0 + 800_000, `${page.trimEnd()}\n[2026-11-25T19:10:00.000000Z] user: Also add a test.\n[2026-11-25T19:10:05.000000Z] assistant: Adding the test now.\n`);
  const r = loadRegistry(sb.paths).sessions[id]!.result;
  assert.deepEqual([r.status, r.pr, r.branch, r.summary], [null, null, null, null]);
  assert.match(result(sb.paths, id, sb.env), /has no KHAROS-DONE mark yet/);
});

test('commands: send reports a refusal of the binary', () => {
  const sb = sandbox({ send: { ok: false, error: 'session not found' } });
  const id = prepared(sb);
  launch(sb, id);
  assert.throws(() => sendMessage(sb.paths, id, 'hello', sb.env), /not sent: session not found/);
});

test('setup: writes a profile and keeps the rest of the configuration', () => {
  const sb = sandbox();
  assert.match(writeProfile(sb.paths, { name: 'demo', repo: 'example/demo', environment: 'env_01X', makeDefault: false }), /wrote profile demo: example\/demo@main.*\(default\)/);
  writeProfile(sb.paths, { name: 'other', repo: 'example/other', environment: 'env_01Y', revision: 'dev', makeDefault: false });
  const cfg = JSON.parse(fs.readFileSync(sb.paths.config, 'utf8'));
  assert.equal(cfg.default_profile, 'demo');
  assert.equal(cfg.profiles.other.revision, 'dev');
  assert.throws(() => writeProfile(sb.paths, { name: 'Bad Name', repo: 'example/demo', environment: 'env_01X', makeDefault: false }), /profile name/);
  assert.throws(() => writeProfile(sb.paths, { name: 'x', repo: 'example/demo', environment: 'nope', makeDefault: false }), /env_/);
});

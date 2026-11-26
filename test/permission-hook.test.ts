import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  bashRuleMatches,
  decide,
  hookOutput,
  parsePattern,
  REFUSAL_PREFIX,
  splitCommand,
  type HookRules,
} from '../cloud/kharos-permission.mjs';
import { promptCommand, readHookDecisions, recordHookDecisions } from '../src/approvals.ts';
import { classify } from '../src/classify.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_WATCH, defaultConfig, loadConfig, parseConfig } from '../src/config.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import { postToolUse, preToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { parseManagedPolicy, planMirror } from '../src/managed-policy.ts';
import { HOOK_COMMAND, HOOK_RULES_PATH, HOOK_SCRIPT_PATH, hookSnapshot, planHook, shippedScript, type HookFiles } from '../src/permission-hook.ts';
import { EMPTY_CHANGE } from '../src/permissions.ts';
import { parseLog } from '../src/logparse.ts';
import { loadRegistry, type Session } from '../src/registry.ts';
import { captured, fixture, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const RULES: HookRules = { allow: ['psql -h 127.0.0.1 -p 5470 -U dev -d * -Atc *', 'pg_isready -h 127.0.0.1'], mirror: [], unmatched: 'deny' };
const SID_REAL = 'cse_01TESTSESSIONBBBBBBBBBBB';
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command, description: 'x' } });

/** An organization policy with example rules; never a real one. */
const POLICY = {
  permissions: {
    ask: ['Bash(redis-cli:*)', 'Bash(*.db.example.com*)', 'Bash(python3:*)', 'Bash', 'WebFetch(domain:internal.example)'],
    deny: ['Bash(rm -rf:*)', 'Read(**/.env)'],
  },
  env: { SOMETHING: 'not read' },
};

function writePolicy(sb: Sandbox, policy: unknown = POLICY): void {
  fs.mkdirSync(path.join(sb.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.claude', 'remote-settings.json'), JSON.stringify(policy));
}

function gitRepo(sb: Sandbox, settings: unknown = { permissions: { deny: ['Bash(git push --force:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }): string {
  const dir = path.join(sb.dir, 'checkout');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/example/demo.git');
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

async function run(sb: Sandbox, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await captured(() => main(argv, sb.env, () => ''));
  return { code: r.value, out: r.stdout, err: r.stderr };
}

const tokenOf = (out: string) => out.match(/change ([0-9a-f]{12}):/)?.[1] ?? '';

test('permission hook: off by default, and nothing is planned or snapshotted while it is off', async () => {
  assert.equal(defaultConfig().permission_hook, false);
  assert.equal(parseConfig({ version: 1 }).permission_hook, false);
  assert.throws(() => parseConfig({ version: 1, permission_hook: 'yes' }), /permission_hook must be true or false/);

  const sb = sandbox();
  writeConfig(sb);
  const dir = gitRepo(sb);
  const before = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
  const refused = await run(sb, 'permissions', 'hook', 'diff', '--allow', 'pg_isready', dir);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /opt-in and off .*kharos permissions hook enable/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), before);
  assert.match((await run(sb, 'permissions', 'hook', 'show', dir)).out, /permission_hook in .*: off \(the default\)/);

  // A launch reads nothing about the hook while it is off.
  let asked = 0;
  const s = prepare(sb.paths, { instruction: 'x', claude_session: null, now: T0, env: sb.env, heads: () => HEADS_OK, hookFiles: () => (asked++, { status: 'unreadable', error: 'x' }) });
  assert.equal(asked, 0);
  assert.equal(s.permission_hook, null);

  const on = await run(sb, 'permissions', 'hook', 'enable');
  assert.match(on.out, /permission_hook is on/);
  assert.equal(loadConfig(sb.paths).config.permission_hook, true);
  assert.equal(loadConfig(sb.paths).config.profiles.demo?.repo, 'https://github.com/example/demo', 'the rest of the configuration stays');
  assert.match((await run(sb, 'permissions', 'hook', 'disable')).out, /permission_hook is off/);
  assert.equal(loadConfig(sb.paths).config.permission_hook, false);
});

test('permission hook: splits only single simple commands with literal words', () => {
  assert.deepEqual(splitCommand(`psql -d "my db" -c 'select 1; select 2' a\\ b`), { ok: true, words: ['psql', '-d', 'my db', '-c', 'select 1; select 2', 'a b'] });
  const refused: [string, RegExp][] = [
    ['psql -c x; rm -rf /', /chained/],
    ['psql -c x && echo', /chained/],
    ['psql -c x | cat', /chained/],
    ['psql -c x > out', /chained/],
    ['psql -c x &', /chained/],
    ['psql -c "$(id)"', /substitutes/],
    ['psql -c `id`', /substitutes/],
    ['psql -c $HOME', /substitutes/],
    ['PGPASSWORD=x psql', /sets a variable/],
    ['psql *.sql', /wildcard/],
    ['psql ~/x', /tilde/],
    ['psql -c x # note', /comment/],
    ["psql -c 'open", /not closed/],
    ['psql\nrm x', /more than one line/],
    ['   ', /empty/],
  ];
  for (const [c, why] of refused) {
    const r = splitCommand(c);
    assert.equal(r.ok, false, c);
    assert.match((r as { why: string }).why, why, c);
  }
  assert.deepEqual(parsePattern('psql -d * -c *'), { ok: true, words: ['psql', '-d', null, '-c', null] });
  assert.deepEqual(parsePattern("psql -c '*'"), { ok: true, words: ['psql', '-c', '*'] });
  for (const [p, why] of [['* -c x', /written out/], ['psql -d db*', /one whole word/], ['bash -c *', /runs other commands/], ['env psql', /runs other commands/], ['/usr/bin/python3 *', /runs other commands/], ['psql; ls', /chained/]] as const) {
    const r = parsePattern(p);
    assert.equal(r.ok, false, p);
    assert.match((r as { why: string }).why, why, p);
  }
});

test('permission hook: allows a command that matches an allow pattern word for word', () => {
  assert.deepEqual(decide(bash("psql -h 127.0.0.1 -p 5470 -U dev -d postgres -Atc 'select 1'"), RULES), { behavior: 'allow', rule: RULES.allow[0], source: 'allow' });
  assert.deepEqual(decide(bash('pg_isready -h 127.0.0.1'), RULES), { behavior: 'allow', rule: 'pg_isready -h 127.0.0.1', source: 'allow' });
  // One more word, one word less, or a longer command is not the pattern.
  for (const c of ['pg_isready -h 127.0.0.1 -t 1', 'pg_isready', `psql -h 127.0.0.1 -p 5470 -U dev -d postgres -Atc '${'x'.repeat(700)}'`]) {
    assert.equal(decide(bash(c), RULES)?.behavior, 'deny', c);
  }
  const out = hookOutput({ behavior: 'allow', rule: 'pg_isready -h 127.0.0.1', source: 'allow' });
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
});

test('permission hook: denies the rest with a message that names the allowed form, so the session can send it', () => {
  const chained = decide(bash("cd /app && psql -h 127.0.0.1 -p 5470 -U dev -d postgres -Atc 'select 1'"), RULES);
  assert.equal(chained?.behavior, 'deny');
  const msg = (chained as { message: string }).message;
  assert.ok(msg.startsWith(REFUSAL_PREFIX));
  assert.match(msg, /psql runs here only in this form: `psql -h 127\.0\.0\.1 -p 5470 -U dev -d <arg> -Atc <arg>`/);
  assert.match(msg, /refused because it is chained/);
  assert.match(msg, /alone in its own call: no cd before it, no variable in front, and nothing chained, piped or redirected/);
  assert.match((decide(bash('psql -h db -p 5470 -U dev -d x -Atc y'), RULES) as { message: string }).message, /only in this form/);
  assert.equal((decide(bash('PGPASSWORD=x psql -h 127.0.0.1'), RULES) as { program: string }).program, 'psql');
  // A program with no pattern, or another tool, gets the plain refusal.
  for (const input of [bash('curl https://example.com'), { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }]) {
    const d = decide(input, RULES) as { behavior: string; message: string; program: string | null };
    assert.equal(d.behavior, 'deny');
    assert.equal(d.program, null);
    assert.match(d.message, /needs a person's approval, and nobody answers permission prompts in this cloud session/);
  }
  const out = hookOutput({ behavior: 'deny', message: 'm', program: null });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'm' } } });
  // With "unmatched": "prompt" the hook only allows; everything else waits for a person, as without it.
  const prompt = { ...RULES, unmatched: 'prompt' as const };
  assert.equal(decide(bash('curl https://example.com'), prompt), null);
  assert.equal(decide(bash('pg_isready -h 127.0.0.1'), prompt)?.behavior, 'allow');
  // A rules file that cannot be used allows nothing, and says so.
  assert.match((decide(bash('pg_isready -h 127.0.0.1'), { error: 'x' }) as { message: string }).message, /rules file cannot be used \(x\), so it allows nothing/);
});

test('permission hook: decides only in cloud sessions, through the settings entry as a session runs it', () => {
  const sb = sandbox();
  const repo = path.join(sb.dir, 'repo');
  fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, HOOK_SCRIPT_PATH), shippedScript());
  fs.writeFileSync(path.join(repo, HOOK_RULES_PATH), JSON.stringify({ version: 1, ...RULES }));
  const runHook = (env: Record<string, string>, input: unknown) =>
    spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: repo, ...env } });

  const cloud = runHook({ CLAUDE_CODE_REMOTE: 'true' }, bash('pg_isready -h 127.0.0.1'));
  assert.equal(cloud.status, 0, cloud.stderr);
  const allowed = JSON.parse(cloud.stdout);
  assert.equal(allowed.hookSpecificOutput.decision.behavior, 'allow');
  assert.match(allowed.systemMessage, /allowed this call by the rule pg_isready -h 127\.0\.0\.1/);
  const denied = JSON.parse(runHook({ CLAUDE_CODE_REMOTE: 'true' }, bash('rm -r x')).stdout);
  assert.equal(denied.hookSpecificOutput.decision.behavior, 'deny');

  // On a person's machine (no CLAUDE_CODE_REMOTE, or another value) it says nothing: the prompt shows as usual.
  for (const env of [{}, { CLAUDE_CODE_REMOTE: 'false' }]) {
    const local = runHook(env, bash('pg_isready -h 127.0.0.1'));
    assert.equal(local.status, 0);
    assert.equal(local.stdout, '');
  }
  const direct = spawnSync(process.execPath, [path.join(repo, HOOK_SCRIPT_PATH)], { input: JSON.stringify(bash('pg_isready -h 127.0.0.1')), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(direct.stdout, '', 'the script checks the variable itself too');
});

test('permission hook: mirrors Claude Code rule syntax for Bash', () => {
  assert.equal(bashRuleMatches('Bash(redis-cli:*)', 'redis-cli -h localhost ping'), true);
  assert.equal(bashRuleMatches('Bash(redis-cli:*)', 'redis-cli'), true);
  assert.equal(bashRuleMatches('Bash(redis-cli:*)', 'redis-cli-other'), false);
  assert.equal(bashRuleMatches('Bash(*.db.example.com*)', 'psql -h a.db.example.com'), true);
  assert.equal(bashRuleMatches('Bash(npm test)', 'npm test'), true);
  assert.equal(bashRuleMatches('Bash(npm test)', 'npm test x'), false);
  assert.equal(bashRuleMatches('Read(**/.env)', 'cat .env'), false);
});

test('permission hook: mirroring is refused when the organization disabled bypass mode, or its policy is not on this machine', () => {
  const files: HookFiles = { settings: null, script: null, rules: null };
  const disabled = parseManagedPolicy(JSON.stringify({ permissions: { ...POLICY.permissions, disableBypassPermissionsMode: 'disable' } }), '/p');
  assert.throws(() => planHook(files, { ...EMPTY_CHANGE, mirror: true }, disabled), /refused: the organization's managed settings set disableBypassPermissionsMode/);
  assert.equal((parseManagedPolicy(JSON.stringify({ disableBypassPermissionsMode: 'disable' }), '/p') as { bypassDisabled: boolean }).bypassDisabled, true);
  assert.throws(() => planHook(files, { ...EMPTY_CHANGE, mirror: true }, { status: 'absent', file: '/p' }), /mirroring is unavailable: there is no copy .* kharos never guesses them/);
  assert.throws(() => planHook(files, { ...EMPTY_CHANGE, mirror: true }, { status: 'unreadable', file: '/p', error: 'EACCES' }), /mirroring is unavailable: \/p cannot be read \(EACCES\)/);
  assert.equal(parseManagedPolicy('not json', '/p').status, 'unreadable');
  assert.equal(parseManagedPolicy(JSON.stringify({ permissions: { ask: 'Bash' } }), '/p').status, 'unreadable');
});

test('permission hook: mirroring lists every rule it converts, keeps deny rules out, and writes only with the confirmation', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  writePolicy(sb);
  const dir = gitRepo(sb);

  assert.deepEqual(planMirror(POLICY.permissions.ask), {
    converted: ['Bash(redis-cli:*)', 'Bash(*.db.example.com*)'],
    kept: [
      { rule: 'Bash(python3:*)', why: 'python3 runs other commands, so an allow would cover anything' },
      { rule: 'Bash', why: 'it covers every command' },
      { rule: 'WebFetch(domain:internal.example)', why: 'only Bash rules are mirrored' },
    ],
  });

  const diff = await run(sb, 'permissions', 'hook', 'diff', '--mirror', dir);
  assert.equal(diff.code, 0, diff.err);
  assert.match(diff.out, /WARNING: check with your organization's administrator before approving this/);
  assert.match(diff.out, /organization ask rules this turns into a cloud-only allow \(2\): Bash\(redis-cli:\*\), Bash\(\*\.db\.example\.com\*\)/);
  assert.match(diff.out, /stays a prompt: Bash\(python3:\*\) \(python3 runs other commands/);
  assert.match(diff.out, /stays a prompt: WebFetch\(domain:internal\.example\) \(only Bash rules are mirrored\)/);
  assert.match(diff.out, /organization deny rules are never touched \(2 stay as they are\)/);
  assert.doesNotMatch(diff.out, /rm -rf|\.env|SOMETHING/, 'deny rules and other policy keys never reach the repository');
  assert.match(diff.out, /--mirror --org-confirmed/);
  const token = tokenOf(diff.out);
  assert.ok(token);
  assert.equal(fs.existsSync(path.join(dir, HOOK_RULES_PATH)), false, 'a diff writes nothing');

  const unconfirmed = await run(sb, 'permissions', 'hook', 'write', '--expect', token, '--mirror', dir);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.err, /written only with --org-confirmed/);
  assert.equal(fs.existsSync(path.join(dir, HOOK_RULES_PATH)), false);

  const wrote = await run(sb, 'permissions', 'hook', 'write', '--expect', token, '--mirror', '--org-confirmed', dir);
  assert.equal(wrote.code, 0, wrote.err);
  assert.match(wrote.out, /Nothing was committed or pushed/);
  const rules = JSON.parse(fs.readFileSync(path.join(dir, HOOK_RULES_PATH), 'utf8'));
  assert.deepEqual(rules, { version: 1, unmatched: 'deny', allow: [], mirror: ['Bash(redis-cli:*)', 'Bash(*.db.example.com*)'] });
  assert.equal(decide(bash('redis-cli -h localhost ping'), { allow: [], mirror: rules.mirror, unmatched: 'deny' })?.behavior, 'allow');
  // Still only a single simple command: the allow covers the whole call.
  assert.equal(decide(bash('redis-cli ping; rm x'), { allow: [], mirror: rules.mirror, unmatched: 'deny' })?.behavior, 'deny');
  assert.equal(spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no commit was made');
});

test('permission hook: deny rules are never touched, and an allow pattern a deny rule covers is refused', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  writePolicy(sb);
  const dir = gitRepo(sb);
  const managed = await run(sb, 'permissions', 'hook', 'diff', '--allow', 'rm -rf *', dir);
  assert.equal(managed.code, 1);
  assert.match(managed.err, /the deny rule Bash\(rm -rf:\*\) covers it, and a hook cannot approve what a deny rule refuses/);
  const repo = await run(sb, 'permissions', 'hook', 'diff', '--allow', 'git push --force *', dir);
  assert.match(repo.err, /the deny rule Bash\(git push --force:\*\) covers it/);
  assert.match((await run(sb, 'permissions', 'hook', 'diff', '--allow', 'bash -c *', dir)).err, /bash runs other commands/);

  const diff = await run(sb, 'permissions', 'hook', 'diff', '--allow', 'psql -h 127.0.0.1 -d * -c *', '--allow', 'pg_isready', dir);
  assert.equal(diff.code, 0, diff.err);
  const wrote = await run(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(diff.out), '--allow', 'psql -h 127.0.0.1 -d * -c *', '--allow', 'pg_isready', dir);
  assert.equal(wrote.code, 0, wrote.err);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { deny: ['Bash(git push --force:*)'] }, 'the repository rules stay as they are');
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }], 'other hooks stay');
  assert.deepEqual(settings.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] }]);
  assert.equal(fs.readFileSync(path.join(dir, HOOK_SCRIPT_PATH), 'utf8'), shippedScript());

  // Dropping a pattern, then removing the hook, each as its own approved diff.
  const drop = await run(sb, 'permissions', 'hook', 'diff', '--drop', 'pg_isready', dir);
  assert.match(drop.out, /^-    "pg_isready"$/m);
  assert.match((await run(sb, 'permissions', 'hook', 'diff', '--drop', 'nope', dir)).err, /"nope" is not an allow pattern/);
  const un = await run(sb, 'permissions', 'hook', 'diff', '--uninstall', dir);
  assert.match(un.out, /deletes \.claude\/hooks\/kharos-permission\.mjs/);
  const removed = await run(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(un.out), '--uninstall', dir);
  assert.equal(removed.code, 0, removed.err);
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.hooks.PermissionRequest, undefined);
  assert.deepEqual(after.hooks.PreToolUse, settings.hooks.PreToolUse);
  assert.equal(fs.existsSync(path.join(dir, HOOK_SCRIPT_PATH)), false);
  assert.equal(fs.existsSync(path.join(dir, HOOK_RULES_PATH)), false);
});

function h(ti: Record<string, unknown>, tool_response?: unknown, session = 'launcher'): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: session, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

test('permission hook: the watcher logs each decision from the session log, with the rule and never the command', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  const installed: HookFiles = {
    settings: JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }),
    script: shippedScript(),
    rules: JSON.stringify({ version: 1, ...RULES, mirror: ['Bash(redis-cli:*)'] }),
  };
  assert.deepEqual(hookSnapshot(installed), { ...RULES, mirror: ['Bash(redis-cli:*)'] });
  assert.equal(hookSnapshot({ ...installed, script: null }), null, 'no script, no hook');
  const id = prepare(sb.paths, { instruction: 'x', claude_session: 'launcher', now: T0, env: sb.env, heads: () => HEADS_OK, hookFiles: () => ({ status: 'found', files: installed }) }).id;
  assert.deepEqual(loadRegistry(sb.paths).sessions[id]?.permission_hook, { ...RULES, mirror: ['Bash(redis-cli:*)'] });

  const SID = 'cse_01TESTSESSIONAAAAAAAAAAA';
  const TRIG = 'trig_01TESTROUTINEAAAAAAAAAAA';
  const pre = preToolUse(sb.ctx(T0), h({ action: 'create', body: { kharos_launch: id } }));
  postToolUse(sb.ctx(T0), h((pre?.hookSpecificOutput as any).updatedInput, response(200, { trigger: { id: TRIG } })));
  preToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }));
  postToolUse(sb.ctx(T0), h({ action: 'run', trigger_id: TRIG }, response(200, { session_id: SID })));

  const secret = "psql -h 127.0.0.1 -p 5470 -U dev -d app -Atc 'select secret_column from accounts'";
  const page = [
    '[2026-11-25T19:00:00.000000Z] init: model=claude-haiku-5-5 cwd=/home/user/demo',
    `[2026-11-25T19:00:01.000000Z] tool_use Bash: ${JSON.stringify({ command: secret, description: 'q' })}`,
    `[2026-11-25T19:00:01.100000Z] permission prompt Bash: ${JSON.stringify({ command: secret, description: 'q' })}`,
    '[2026-11-25T19:00:01.300000Z] tool_result: 1',
    `[2026-11-25T19:00:02.000000Z] permission prompt Bash: ${JSON.stringify({ command: 'redis-cli -h localhost ping', description: 'r' })}`,
    '[2026-11-25T19:00:02.200000Z] tool_result: PONG',
    `[2026-11-25T19:00:03.000000Z] permission prompt Bash: ${JSON.stringify({ command: `cd /app && ${secret}`, description: 'q' })}`,
    `[2026-11-25T19:00:03.100000Z] tool_result: ${REFUSAL_PREFIX}: nobody answers`,
    `[2026-11-25T19:00:04.000000Z] permission prompt WebFetch: ${JSON.stringify({ url: 'https://example.com/private' })}`,
    `[2026-11-25T19:00:04.100000Z] tool_result: ${REFUSAL_PREFIX}: this WebFetch call`,
  ].join('\n');
  const read = postToolUse(sb.ctx(T0 + 5 * 60_000), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, page), 'watcher'));
  assert.match(JSON.stringify(read), /The kharos permission hook answered 4 prompt\(s\)/);
  // A second read of the same page logs nothing again.
  postToolUse(sb.ctx(T0 + 15 * 60_000), h({ action: 'get_run_log', session_id: SID }, response(200, { session_id: SID, next_cursor: null }, page), 'watcher'));

  const logged = readHookDecisions(sb.paths);
  assert.deepEqual(
    logged.map((d) => [d.at, d.kharos, d.session_id, d.tool, d.decision, d.rule, d.source, d.program]),
    [
      ['2026-11-25T19:00:01.100000Z', id, SID, 'Bash', 'allow', RULES.allow[0], 'allow', null],
      ['2026-11-25T19:00:02.000000Z', id, SID, 'Bash', 'allow', 'Bash(redis-cli:*)', 'mirror', null],
      ['2026-11-25T19:00:03.000000Z', id, SID, 'Bash', 'deny', null, null, 'psql'],
      ['2026-11-25T19:00:04.000000Z', id, SID, 'WebFetch', 'deny', null, null, null],
    ],
  );
  const text = fs.readFileSync(sb.paths.approvals, 'utf8');
  assert.doesNotMatch(text, /secret_column|accounts|example\.com\/private|PONG/, 'no command, input or output is logged');
  assert.equal((fs.statSync(sb.paths.approvals).mode & 0o777).toString(8), '600');

  const listed = await run(sb, 'permissions', 'approvals');
  assert.match(listed.out, /^2 approval\(s\) of the kharos permission hook/);
  assert.match(listed.out, new RegExp(`2026-11-25T19:00:01Z  ${id}  Bash  allowed by allow pattern psql -h 127\\.0\\.0\\.1`));
  assert.match(listed.out, /allowed by mirrored organization rule Bash\(redis-cli:\*\)/);
  assert.doesNotMatch(listed.out, /denied/);
  const all = await run(sb, 'permissions', 'approvals', '--all', '--session', id);
  assert.match(all.out, /^4 decision\(s\)/);
  assert.match(all.out, /Bash  denied \(refusal named the forms of psql\)/);
  assert.match((await run(sb, 'permissions', 'approvals', '--session', 'k-9999')).out, /no approval .* for k-9999/);
});

test('permission hook: the command of a prompt line is read even when the service cut its end', () => {
  assert.equal(promptCommand(JSON.stringify({ command: 'a "b"', description: 'c' })), 'a "b"');
  assert.equal(promptCommand('{"command":"psql -c \\"x\\"","description":"long… [+120 chars]'), 'psql -c "x"');
  assert.equal(promptCommand('{"command":"psql -c very long… [+900 chars]'), null);
});

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'team', account: 'sha256:x' }),
    heads: () => HEADS_OK,
    ownerType: () => 'Organization',
    settings: () => ({ status: 'found', text: JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }) }),
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    managedPolicy: () => parseManagedPolicy(JSON.stringify(POLICY), '/home/person/.claude/remote-settings.json'),
    ...over,
  };
}

test('doctor: reads the managed-policy copy, warns about the ask rules that stop cloud sessions, and warns while the hook is on', () => {
  const sb = sandbox();
  writeConfig(sb);
  const off = runDoctor(sb.paths, { now: T0, env: sb.env }, deps());
  const policy = off.find((c) => c.name === 'managed policy');
  assert.equal(policy?.level, 'info');
  assert.match(policy?.detail ?? '', /5 ask rule\(s\), 2 deny rule\(s\); bypass mode not disabled/);
  const ask = off.find((c) => c.name === 'demo: managed ask rules');
  assert.equal(ask?.level, 'warn');
  assert.match(ask?.detail ?? '', /5 organization ask rule\(s\) prompt in every cloud session, which has no bypass mode/);
  assert.match(formatChecks(off), /opt in to the kharos permission hook/);
  assert.equal(off.find((c) => c.name === 'permission hook'), undefined, 'no hook warning while it is off');

  const settings = JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } });
  const files: HookFiles = { settings, script: shippedScript(), rules: JSON.stringify({ version: 1, allow: ['pg_isready'], mirror: ['Bash(redis-cli:*)', 'Bash(*.db.example.com*)'] }) };
  const withHook = deps({ settings: () => ({ status: 'found', text: settings }), hookFiles: () => ({ status: 'found', files }) });

  // The hook on the branch while the setting is off is a warning of its own.
  const stray = runDoctor(sb.paths, { now: T0, env: sb.env }, withHook).find((c) => c.name === 'demo: permission hook');
  assert.equal(stray?.level, 'warn');
  assert.match(stray?.detail ?? '', /permission_hook is off, yet the hook answers prompts/);

  writeConfig(sb, { permission_hook: true });
  const on = runDoctor(sb.paths, { now: T0, env: sb.env }, withHook);
  assert.equal(on.find((c) => c.name === 'permission hook')?.level, 'warn');
  assert.match(on.find((c) => c.name === 'permission hook')?.detail ?? '', /permission_hook is on/);
  const hook = on.find((c) => c.name === 'demo: permission hook');
  assert.equal(hook?.level, 'info');
  assert.match(hook?.detail ?? '', /1 allow pattern\(s\), 2 mirrored organization ask rule\(s\), any other prompt denied/);
  // Mirrored rules no longer stop the session; the rest still do.
  assert.match(on.find((c) => c.name === 'demo: managed ask rules')?.detail ?? '', /^3 organization ask rule\(s\) .*: Bash\(python3:\*\), Bash, WebFetch/);

  const none = runDoctor(sb.paths, { now: T0, env: sb.env }, deps({ managedPolicy: () => ({ status: 'absent', file: '/home/person/.claude/remote-settings.json' }) }));
  assert.match(none.find((c) => c.name === 'managed policy')?.detail ?? '', /no copy of organization managed settings/);
  assert.equal(none.find((c) => c.name === 'demo: managed ask rules'), undefined);
  assert.match(none.find((c) => c.name === 'demo: permission hook')?.detail ?? '', /has no kharos permission hook, so its cloud sessions still wait/);
});

test('permission hook: show reads the local policy copy and the hook files of the checkout', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  writePolicy(sb, { permissions: { ...POLICY.permissions, disableBypassPermissionsMode: 'disable' } });
  const dir = gitRepo(sb);
  const shown = await run(sb, 'permissions', 'hook', 'show', dir);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /permission_hook in .*: on/);
  assert.match(shown.out, /kharos permission hook: not in \.claude\/settings\.json; script missing/);
  assert.match(shown.out, /5 ask rule\(s\), 2 deny rule\(s\), bypass mode disabled/);
  assert.match(shown.out, /refused: the organization's managed settings set disableBypassPermissionsMode/);
  assert.match((await run(sb, 'permissions', 'hook', 'diff', '--mirror', dir)).err, /refused: .*disableBypassPermissionsMode/);
  const general = await run(sb, 'permissions', 'show', dir);
  assert.match(general.out, /ask rules prompt in every cloud session, which has no bypass mode, and no repository allow rule outranks them/);
});

test('permission hook: a real cloud log (names changed) attributes every decision the hook made, and no prompt stays open', () => {
  const sb = sandbox();
  const page = parseLog(fixture('log-permission-hook.txt'));
  const s = { id: 'k-0001', session_id: SID_REAL, permission_hook: { allow: ['psql -h 127.0.0.1 -p 5470 -U dev -d * -Atc *'], mirror: [], unmatched: 'deny' } } as unknown as Session;
  const got = recordHookDecisions(sb.paths, s, page.events).map((d) => [d.decision, d.rule ?? d.program]);
  assert.deepEqual(got, [
    ['allow', 'psql -h 127.0.0.1 -p 5470 -U dev -d * -Atc *'],
    ['deny', 'psql'],
    ['deny', null],
    ['deny', 'psql'],
    ['allow', 'psql -h 127.0.0.1 -p 5470 -U dev -d * -Atc *'],
  ]);
  const last = page.events[page.events.length - 1]!;
  assert.equal(classify({ events: page.events, seenStart: true, createdAt: page.events[0]!.t, deadlineMin: 30, now: last.t + 60_000, watch: DEFAULT_WATCH }).state, 'running');
});

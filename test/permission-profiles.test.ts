import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import {
  applyProfile,
  assess,
  buildRules,
  identify,
  OPEN_RULES,
  readFacts,
  readRules,
  STANDARD_BASE,
  unifiedDiff,
} from '../src/permission-profiles.ts';
import type { RemoteSettings } from '../src/permissions.ts';
import { captured, HEADS_OK, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const NO_FACTS = { files: [], scripts: [], makeTargets: [] };

test('permission profiles: standard allows the build and test commands the repository has, never deploys', () => {
  const pkg = JSON.stringify({ scripts: { test: 'x', 'test:unit': 'x', build: 'x', lint: 'x', deploy: 'x', release: 'x', 'bad name': 'x' } });
  const facts = readFacts(['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'Makefile'], pkg, 'build:\n\tcc\ntest: build\n\t./t\ndeploy:\n\tscp\nX := 1\n');
  assert.deepEqual(buildRules(facts), [
    'Bash(pnpm install --frozen-lockfile)',
    'Bash(pnpm install)',
    'Bash(pnpm test *)',
    'Bash(pnpm run test *)',
    'Bash(pnpm run test:unit *)',
    'Bash(pnpm run build *)',
    'Bash(pnpm run lint *)',
    'Bash(cargo build *)',
    'Bash(cargo test *)',
    'Bash(cargo check *)',
    'Bash(cargo clippy *)',
    'Bash(cargo fmt *)',
    'Bash(make build *)',
    'Bash(make test *)',
  ]);
  assert.deepEqual(buildRules(readFacts(['package.json'], '{not json', null)), ['Bash(npm ci)', 'Bash(npm install)', 'Bash(npm test *)']);
});

test('permission profiles: standard allows no build or test script whose name says it deploys, releases, publishes, uploads or pushes', () => {
  const names = ['build:deploy', 'test:release', 'build-and-publish', 'check:publish', 'build:upload', 'build-push', 'build:Deploy'];
  const pkg = JSON.stringify({ scripts: Object.fromEntries([...names, 'build:prod'].map((n) => [n, 'x'])) });
  const make = [...names.map((n) => n.replace(/:/g, '-')), 'build-release', 'test-unit'].map((t) => `${t}:\n\tx\n`).join('');
  const rules = buildRules(readFacts(['package.json', 'Makefile'], pkg, make));
  assert.deepEqual(rules, ['Bash(npm ci)', 'Bash(npm install)', 'Bash(npm test *)', 'Bash(npm run build:prod *)', 'Bash(make test-unit *)']);
});

test('permission profiles: standard adds allow rules after the existing ones and keeps ask, deny and every other key', () => {
  const settings = { env: { A: '1' }, permissions: { allow: ['Bash(npm test *)', 'Read'], ask: ['Bash(git push *)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' }, hooks: {} };
  const next = applyProfile(settings, 'standard', NO_FACTS);
  const rules = readRules(next);
  assert.deepEqual(rules.allow.slice(0, 2), ['Bash(npm test *)', 'Read']);
  assert.equal(rules.allow.filter((r) => r === 'Read').length, 1);
  assert.ok(STANDARD_BASE.every((r) => rules.allow.includes(r)));
  assert.deepEqual(rules.ask, ['Bash(git push *)']);
  assert.deepEqual(rules.deny, ['Read(./.env)']);
  assert.equal(rules.defaultMode, 'acceptEdits');
  assert.deepEqual(Object.keys(next), ['env', 'permissions', 'hooks']);
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test *)', 'Read'], 'the input is not changed');
  assert.equal(identify(rules), 'standard');
});

test('permission profiles: open allows every built-in tool, drops ask rules and keeps deny rules', () => {
  const next = applyProfile({ permissions: { ask: ['Bash(git push *)'], deny: ['Bash(rm -rf *)'] } }, 'open', NO_FACTS);
  const rules = readRules(next);
  assert.deepEqual(rules.allow, [...OPEN_RULES]);
  assert.deepEqual(rules.ask, []);
  assert.deepEqual(rules.deny, ['Bash(rm -rf *)']);
  assert.equal(identify(rules), 'open');
  assert.equal(applyProfile({ x: 1 }, 'default', NO_FACTS).x, 1);
});

test('permission profiles: identify and assess name what would hold a session at a prompt', () => {
  const none = readRules({});
  assert.equal(identify(none), 'default');
  assert.deepEqual(assess(none).map((f) => f.level), ['warn']);
  assert.match(assess(none)[0]!.text, /^no allow rule for Bash: .*3 blocks in a row or 20/);
  const custom = readRules({ permissions: { allow: ['Bash(npm test *)'], ask: ['Bash(git push *)', 'WebFetch', 'Edit', 'Write'], defaultMode: 'bypassPermissions' } });
  assert.equal(identify(custom), 'custom');
  const found = assess(custom);
  assert.match(found[0]!.text, /^4 ask rule\(s\) \(Bash\(git push \*\), WebFetch, Edit, \.\.\.\) prompt even in auto mode/);
  assert.deepEqual(found.map((f) => f.level), ['warn', 'info']);
  assert.match(found[1]!.text, /bypassPermissions" does not apply/);
  // Bash allowed but an ask rule left: not open.
  assert.equal(identify(readRules({ permissions: { allow: ['Bash'], ask: ['Bash(git push *)'] } })), 'custom');
  assert.throws(() => readRules({ permissions: { allow: 'Bash' } }), /permissions\.allow must be a list of strings/);
});

test('permission profiles: the diff is a unified diff with context', () => {
  assert.equal(unifiedDiff('{\n  "a": 1\n}\n', '{\n  "a": 1,\n  "b": 2\n}\n', '.claude/settings.json'), [
    '--- a/.claude/settings.json',
    '+++ b/.claude/settings.json',
    '@@ -1,3 +1,4 @@',
    ' {',
    '-  "a": 1',
    '+  "a": 1,',
    '+  "b": 2',
    ' }',
  ].join('\n'));
  assert.equal(unifiedDiff(null, '{}\n', 'f'), ['--- /dev/null', '+++ b/f', '@@ -0,0 +1,1 @@', '+{}'].join('\n'));
});

function gitRepo(sb: Sandbox): string {
  const dir = path.join(sb.dir, 'checkout');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/example/demo.git');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', deploy: 'x' } }));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(git push *)'], deny: ['Read(./.env)'] } }, null, 4) + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

async function run(sb: Sandbox, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await captured(() => main(argv, sb.env, () => ''));
  return { code: r.value, out: r.stdout, err: r.stderr };
}

test('kharos permissions: shows the rules, writes only the diff the person saw, and never commits', async () => {
  const sb = sandbox();
  writeConfig(sb);
  const dir = gitRepo(sb);
  const file = path.join(dir, '.claude', 'settings.json');
  const original = fs.readFileSync(file, 'utf8');

  const shown = await run(sb, 'permissions', 'show', path.join(dir, '.claude'));
  assert.equal(shown.code, 0);
  assert.match(shown.out, /permission profile: custom/);
  assert.match(shown.out, /ask \(1\): Bash\(git push \*\)/);
  assert.match(shown.out, /warn: 1 ask rule\(s\)/);
  assert.match(shown.out, /warn: no allow rule for Bash/);
  assert.match(shown.out, /kharos launch profiles on example\/demo: demo \(branch main\)/);

  const diff = await run(sb, 'permissions', 'diff', 'standard', dir);
  assert.equal(diff.code, 0);
  assert.match(diff.out, /adds \d+ allow rule\(s\); deny rules stay as they are/);
  assert.match(diff.out, /^\+ {12}"Bash\(npm test \*\)",$/m, 'the file keeps its four-space indent');
  assert.doesNotMatch(diff.out, /deploy/);
  const token = diff.out.match(/change ([0-9a-f]{12}):/)?.[1];
  assert.ok(token);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'a diff writes nothing');

  // Without the token, with the token of another profile, or after the file changed: nothing is written.
  assert.match((await run(sb, 'permissions', 'write', 'standard', dir)).err, /--expect needs the change token/);
  assert.match((await run(sb, 'permissions', 'write', 'open', '--expect', token, dir)).err, /not what that diff was made from/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  const wrote = await run(sb, 'permissions', 'write', 'standard', '--expect', token, dir);
  assert.equal(wrote.code, 0, wrote.err);
  assert.match(wrote.out, /Nothing was committed or pushed/);
  assert.match(wrote.out, /demo \(branch main\)/);
  const rules = readRules(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(identify(rules), 'standard');
  assert.deepEqual(rules.deny, ['Read(./.env)']);
  assert.deepEqual(rules.ask, ['Bash(git push *)']);
  const log = spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(log.length, 1, 'no commit was made');
  assert.match(spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, /^ M \.claude\/settings\.json$/m);

  assert.match((await run(sb, 'permissions', 'diff', 'standard', dir)).out, /nothing to change/);
  assert.match((await run(sb, 'permissions', 'write', 'standard', '--expect', token, dir)).out, /nothing to change/);
  assert.match((await run(sb, 'permissions', 'diff', 'default', dir)).out, /permission profile default: nothing to change/);
  assert.match((await run(sb, 'permissions', 'diff', 'wide', dir)).err, /one of default, standard, open/);
});

test('kharos permissions: a settings file that is not valid JSON, or a folder outside git, is refused', async () => {
  const sb = sandbox();
  const dir = gitRepo(sb);
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ // a comment\n}');
  const r = await run(sb, 'permissions', 'diff', 'open', dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /not valid JSON .*kharos does not edit it/);
  fs.rmSync(path.join(dir, '.claude', 'settings.json'));
  const created = await run(sb, 'permissions', 'diff', 'open', dir);
  assert.match(created.out, /^--- \/dev\/null$/m);
  const outside = path.join(sb.dir, 'plain');
  fs.mkdirSync(outside);
  assert.match((await run(sb, 'permissions', 'show', outside)).err, /not inside a git checkout/);
});

function deps(settings: RemoteSettings): DoctorDeps {
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', account: 'sha256:x' }),
    heads: () => HEADS_OK,
    ownerType: () => 'User',
    settings: () => settings,
  };
}

test('doctor: reports the permission profile of the launch branch and warns when a launch would likely stall', () => {
  const sb = sandbox();
  writeConfig(sb);
  const check = (s: RemoteSettings) => runDoctor(sb.paths, { now: T0, env: sb.env }, deps(s)).find((c) => c.name === 'demo: permissions');
  const absent = check({ status: 'absent' });
  assert.equal(absent?.level, 'warn');
  assert.match(absent?.detail ?? '', /^example\/demo@main is on the default permission profile \(no settings file\); no allow rule for Bash/);
  assert.match(absent?.fix?.[0] ?? '', /\/kharos:permissions standard .*commit and push it to main/);
  const asks = check({ status: 'found', text: JSON.stringify({ permissions: { allow: ['Bash'], ask: ['Bash(git push *)'] } }) });
  assert.equal(asks?.level, 'warn');
  assert.match(asks?.detail ?? '', /custom permission profile \(1 allow, 1 ask, 0 deny\); 1 ask rule\(s\)/);
  const open = check({ status: 'found', text: JSON.stringify({ permissions: { allow: [...OPEN_RULES], deny: ['Bash(rm -rf *)'] } }) });
  assert.equal(open?.level, 'ok');
  assert.match(open?.detail ?? '', /on the open permission profile/);
  assert.equal(check({ status: 'unreadable', error: 'gh is not installed' })?.level, 'info');
  assert.equal(check({ status: 'found', text: '{' })?.level, 'warn');
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps({ status: 'absent' }))), /warn {2}demo: permissions: /);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, runHook } from '../src/cli.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import { recordAccess } from '../src/repo.ts';
import { saveEnvironments } from '../src/state.ts';
import { captured, HEADS_EMPTY, HEADS_OK, sandbox, T0, writeConfig } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', account: 'sha256:x' }),
    heads: () => HEADS_OK,
    ownerType: () => 'User',
    settings: () => ({ status: 'found', text: JSON.stringify({ permissions: { allow: ['Bash(npm test *)'] } }) }),
    ...over,
  };
}

test('doctor: a ready profile passes, with the Claude side still to be seen', () => {
  const sb = sandbox();
  writeConfig(sb);
  saveEnvironments(sb.paths, [{ id: 'env_01TESTENVIRONMENT', routines: 2, last_used: null }], T0);
  const checks = runDoctor(sb.paths, { now: T0, env: sb.env }, deps());
  assert.equal(checks.filter((c) => c.level === 'fail').length, 0);
  const text = formatChecks(checks);
  assert.match(text, /demo: claude access: not checked yet/);
  assert.match(text, /demo: environment: env_01TESTENVIRONMENT \(used by 2/);
  assert.match(text, /Ready to launch/);
});

test('doctor: each gap comes with its fix', () => {
  const sb = sandbox();
  writeConfig(sb);
  recordAccess(sb.paths, 'https://github.com/example/demo', 'denied', 'repo_access_denied', T0);
  saveEnvironments(sb.paths, [{ id: 'env_other', routines: 1, last_used: null }], T0);
  const checks = runDoctor(
    sb.paths,
    { now: T0, env: { ...sb.env, ANTHROPIC_API_KEY: 'k' }, noRemoteTool: true },
    deps({ claudeVersion: () => '2.1.200 (Claude Code)', heads: () => HEADS_EMPTY }),
  );
  const text = formatChecks(checks);
  assert.match(text, /fail {2}claude: .*needs 2\.1\.323/);
  assert.match(text, /fail {2}login: ANTHROPIC_API_KEY/);
  assert.match(text, /fail {2}remote tool/);
  assert.match(text, /fail {2}demo: repo: example\/demo has no commit/);
  assert.match(text, /fail {2}demo: claude access: .*repo_access_denied/);
  assert.match(text, /github\.com\/settings\/installations/);
  assert.match(text, /warn {2}demo: environment/);
  assert.match(text, /problem\(s\) to fix/);
});

test('doctor: an unreadable registry is a failed check, and the other checks still run', () => {
  const sb = sandbox();
  writeConfig(sb);
  fs.mkdirSync(path.dirname(sb.paths.registry), { recursive: true });
  fs.writeFileSync(sb.paths.registry, '{"version":1}');
  fs.writeFileSync(sb.paths.watch, '{"last_beat": ');
  const checks = runDoctor(sb.paths, { now: T0, env: sb.env }, deps());
  const registry = checks.find((c) => c.name === 'registry');
  assert.equal(registry?.level, 'fail');
  assert.ok(registry?.detail.startsWith(`state could not be read (${sb.paths.registry}): `));
  assert.deepEqual(registry?.fix, ['Repair or move that file.']);
  assert.equal(checks.find((c) => c.name === 'watcher')?.level, 'fail');
  assert.equal(checks.find((c) => c.name === 'demo: repo')?.level, 'ok');
  assert.equal(checks.find((c) => c.name === 'config')?.level, 'ok');
  assert.match(formatChecks(checks), /problem\(s\) to fix/);
});

test('doctor: wrongly shaped environments and repos files are failed checks, not a crash', () => {
  const sb = sandbox();
  writeConfig(sb);
  fs.mkdirSync(path.dirname(sb.paths.environments), { recursive: true });
  fs.writeFileSync(sb.paths.environments, '{}');
  fs.writeFileSync(sb.paths.repos, 'null');
  const checks = runDoctor(sb.paths, { now: T0, env: sb.env }, deps());
  for (const [name, file] of [['environments', sb.paths.environments], ['repos', sb.paths.repos]] as const) {
    const c = checks.find((x) => x.name === name);
    assert.equal(c?.level, 'fail', `${name} fails`);
    assert.ok(c?.detail.startsWith(`state could not be read (${file}): `));
  }
  assert.equal(checks.find((c) => c.name === 'demo: repo')?.level, 'ok');
});

test('cli: a wrongly shaped registry prints one line naming the file and exits 1', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.dirname(sb.paths.registry), { recursive: true });
  fs.writeFileSync(sb.paths.registry, '{"version":1}');
  const r = await captured(() => main(['list'], sb.env, () => ''));
  assert.equal(r.value, 1);
  assert.equal(r.stderr, `kharos: state could not be read (${sb.paths.registry}): it is not a kharos registry (it needs "next_seq" and "sessions" of objects). Do not run again; show this to the person.\n`);
  assert.equal(r.stdout, '');
});

test('config: a syntax error is one line from the CLI and a failed doctor check', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.dirname(sb.paths.config), { recursive: true });
  fs.writeFileSync(sb.paths.config, '{"version": 1, "profiles": {},}');
  const r = await captured(() => main(['prepare'], sb.env, () => 'Fix the typo.'));
  assert.equal(r.value, 1);
  const lines = (r.stdout + r.stderr).trim().split('\n');
  assert.equal(lines[0], 'not launched:');
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.trim().startsWith(`${sb.paths.config}: invalid JSON (`));
  assert.doesNotMatch(r.stdout + r.stderr, /\n\s+at /);
  const c = runDoctor(sb.paths, { now: T0, env: sb.env }, deps()).find((x) => x.name === 'config');
  assert.equal(c?.level, 'fail');
  assert.ok(c?.detail.startsWith(`${sb.paths.config}: invalid JSON (`));
});

test('doctor: no configuration points to setup', () => {
  const sb = sandbox();
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps())), /no configuration .*\n {6}Run \/kharos:setup/);
});

test('plugin: every hook event in hooks.json has a handler', async () => {
  const sb = sandbox();
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const events = (Object.values(hooks.hooks) as any[]).flatMap((entries) => entries.flatMap((e: any) => e.hooks.map((h: any) => h.args[2] as string)));
  assert.ok(events.length > 0);
  for (const event of events) {
    const r = await captured(() => runHook(event, sb.ctx(T0), () => '{}'));
    assert.equal(r.value, 0, `hook ${event} is handled`);
    assert.doesNotMatch(r.stderr, /unknown hook event/);
  }
  assert.equal((await captured(() => runHook('not-an-event', sb.ctx(T0), () => '{}'))).value, 1);
});

/** The key/value pairs of a SKILL.md frontmatter block, the part Claude Code reads. */
function frontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  assert.equal(lines[0], '---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'the frontmatter is closed');
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

test('plugin: skills call commands the CLI knows, and the manifest matches the package', async () => {
  const sb = sandbox();
  for (const name of fs.readdirSync(path.join(ROOT, 'skills'))) {
    const text = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    assert.ok(fm.description, `${name} has a description`);
    for (const m of text.matchAll(/scripts\/kharos" ([a-z-]+)/g)) {
      const command = m[1] as string;
      const r = await captured(() => main([command], sb.env, () => ''));
      assert.ok(!(r.value === 2 && /unknown command/.test(r.stderr)), `${name} calls kharos ${command}, which the CLI knows`);
    }
    if (name !== 'kharos' && name !== 'watch') assert.equal(fm['disable-model-invocation'], 'true', `${name} is for the person only`);
  }
  assert.equal((await captured(() => main(['not-a-command'], sb.env, () => ''))).value, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'kharos');
  assert.equal(manifest.version, pkg.version);
});

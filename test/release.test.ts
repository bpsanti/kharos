import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { ConfigError, parseConfig } from '../src/config.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import {
  applyUpdate,
  changesBetween,
  compareVersions,
  formatRelease,
  installedVersion,
  installOf,
  loadReleaseCache,
  noticeText,
  readLatest,
  readReleaseView,
  refreshRelease,
  RELEASE_TTL_MS,
  UPDATE_OFFER,
  updateNotice,
  type Fetcher,
  type ReleaseView,
} from '../src/release.ts';
import { captured, HEADS_OK, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const API = 'http://127.0.0.1:9/repos/bpsanti/kharos';
const CHANGELOG = ['# Changelog', '', '## Unreleased', '', '- not out yet', '', '## 0.4.0', '', '- the newest', '', '## 0.3.2', '', '- a fix', '', '## 0.3.1', '', '- already installed', ''].join('\n');

/** A GitHub that answers the latest release with `tag` and the changelog of any tag. */
function github(tag: unknown, opts: { status?: number; body?: string; changelog?: string | null } = {}): Fetcher {
  return async (url) => {
    if (url.endsWith('/releases/latest')) return { status: opts.status ?? 200, text: opts.body ?? JSON.stringify({ tag_name: tag }) };
    if (url.includes('/contents/CHANGELOG.md')) return opts.changelog === null ? { status: 404, text: '' } : { status: 200, text: opts.changelog ?? CHANGELOG };
    return { status: 404, text: '' };
  };
}

const unreachable: Fetcher = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:9');
};

function online(sb: Sandbox): NodeJS.ProcessEnv {
  return { ...sb.env, KHAROS_RELEASES_API: API };
}

function writeCache(sb: Sandbox, cache: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(sb.paths.release), { recursive: true });
  fs.writeFileSync(sb.paths.release, JSON.stringify(cache));
}

const DOCTOR_DEPS: DoctorDeps = {
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

function view(over: Partial<ReleaseView> = {}): ReleaseView {
  return { installed: '0.3.1', install: { kind: 'plugin', marketplace: 'kharos' }, latest: '0.3.2', error: null, changes: '## 0.3.2\n\n- a fix', npm: null, ...over };
}

test('release: versions compare newer, equal and older, and a malformed tag is no version', () => {
  assert.ok(compareVersions('0.3.2', '0.3.1') > 0);
  assert.ok(compareVersions('v0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('v0.3.1', '0.3.1'), 0);
  assert.ok(compareVersions('0.3.0', '0.3.1') < 0);
  assert.throws(() => compareVersions('0.3', '0.3.1'));
});

test('release: the latest release is read from its tag; any failure is a reason, never a throw', async () => {
  const sb = sandbox();
  const env = online(sb);
  assert.deepEqual(await readLatest(env, github('v0.3.2'), 1000), { version: '0.3.2' });
  assert.match(JSON.stringify(await readLatest(env, github('nightly'), 1000)), /no version tag \(nightly\)/);
  assert.match(JSON.stringify(await readLatest(env, github('v0.4.0-rc.1'), 1000)), /no version tag/, 'a prerelease is not offered');
  assert.match(JSON.stringify(await readLatest(env, github(null, { body: '<html>' }), 1000)), /not JSON/);
  assert.match(JSON.stringify(await readLatest(env, github(null, { status: 403, body: '{}' }), 1000)), /GitHub answered 403/);
  assert.match(JSON.stringify(await readLatest(env, unreachable, 1000)), /ECONNREFUSED/);
  assert.match(JSON.stringify(await readLatest(sb.env, github('v0.3.2'), 1000)), /off/, 'KHAROS_RELEASES_API=off reads nothing');
});

test('release: a failed read keeps the last version known, with its reason', async () => {
  const sb = sandbox();
  await refreshRelease(sb.paths, online(sb), T0, github('v0.3.2'), 1000);
  const after = await refreshRelease(sb.paths, online(sb), T0 + 1000, unreachable, 1000);
  assert.equal(after.latest, '0.3.2');
  assert.match(after.error ?? '', /ECONNREFUSED/);
  assert.deepEqual(loadReleaseCache(sb.paths), after);
});

test('release: the changelog sections after the installed version, up to the latest', () => {
  const text = changesBetween(CHANGELOG, '0.3.1', '0.4.0');
  assert.match(text, /^## 0\.4\.0\n\n- the newest\n\n## 0\.3\.2\n\n- a fix$/);
  assert.doesNotMatch(text, /Unreleased|already installed/);
  assert.equal(changesBetween(CHANGELOG, '0.3.1', '0.3.2'), '## 0.3.2\n\n- a fix');
  assert.equal(changesBetween(CHANGELOG, '0.4.0', '0.4.0'), '');
});

test('notice: with no read yet it starts one in the background and says nothing; a newer release then gets one line', () => {
  const sb = sandbox();
  const env = online(sb);
  let spawned = 0;
  const refresh = () => void spawned++;
  assert.equal(updateNotice(sb.paths, env, T0, refresh, '0.3.1'), null);
  assert.equal(spawned, 1);
  assert.equal(updateNotice(sb.paths, env, T0 + 1000, refresh, '0.3.1'), null, 'the read under way counts as today\'s');
  assert.equal(spawned, 1);
  writeCache(sb, { checked_at: new Date(T0).toISOString(), latest: '0.3.2' });
  assert.equal(updateNotice(sb.paths, env, T0 + 2000, refresh, '0.3.1'), noticeText('0.3.2', '0.3.1'));
  assert.match(noticeText('0.3.2', '0.3.1'), /^kharos 0\.3\.2 is available \(you have 0\.3\.1\); \/kharos:doctor/);
  assert.equal(spawned, 1);
});

test('notice: at most once a day, and the release is read again after a day', () => {
  const sb = sandbox();
  const env = online(sb);
  let spawned = 0;
  const refresh = () => void spawned++;
  writeCache(sb, { checked_at: new Date(T0).toISOString(), latest: '0.3.2' });
  assert.ok(updateNotice(sb.paths, env, T0, refresh, '0.3.1'));
  assert.equal(updateNotice(sb.paths, env, T0 + 3600_000, refresh, '0.3.1'), null);
  assert.equal(spawned, 0, 'a read younger than a day is not repeated');
  const later = T0 + RELEASE_TTL_MS + 1;
  assert.ok(updateNotice(sb.paths, env, later, refresh, '0.3.1'), 'a day later the notice shows again');
  assert.equal(spawned, 1, 'and the release is read again');
});

test('notice: nothing for an equal or older release, an unreadable cache, or with the notice turned off', () => {
  const sb = sandbox();
  const env = online(sb);
  const refresh = () => {
    throw new Error('must not read');
  };
  writeCache(sb, { checked_at: new Date(T0).toISOString(), latest: '0.3.1' });
  assert.equal(updateNotice(sb.paths, env, T0, refresh, '0.3.1'), null);
  assert.equal(updateNotice(sb.paths, env, T0, refresh, '0.4.0'), null);
  writeCache(sb, { checked_at: new Date(T0).toISOString(), latest: 'garbage' });
  assert.equal(updateNotice(sb.paths, env, T0, refresh, '0.3.1'), null);
  writeCache(sb, { checked_at: new Date(T0).toISOString(), latest: '0.3.2' });
  writeConfig(sb, { update: { notify: false } });
  let spawned = 0;
  assert.equal(updateNotice(sb.paths, env, T0, () => void spawned++, '0.3.1'), null);
  fs.rmSync(sb.paths.release);
  assert.equal(updateNotice(sb.paths, env, T0, () => void spawned++, '0.3.1'), null);
  assert.equal(spawned, 0, 'turned off, it reads nothing either');
  assert.equal(updateNotice(sb.paths, sb.env, T0, () => void spawned++, '0.3.1'), null, 'KHAROS_RELEASES_API=off');
});

test('notice: a refresh that throws never fails the command', () => {
  const sb = sandbox();
  assert.equal(
    updateNotice(sb.paths, online(sb), T0, () => {
      throw new Error('spawn failed');
    }, '0.3.1'),
    null,
  );
});

test('config: update.notify is on by default, can be turned off, and nothing else is taken', () => {
  assert.equal(parseConfig({ version: 1 }).update.notify, true);
  assert.equal(parseConfig({ version: 1, update: { notify: false } }).update.notify, false);
  assert.throws(() => parseConfig({ version: 1, update: { notify: 'no' } }), ConfigError);
  assert.throws(() => parseConfig({ version: 1, update: { channel: 'beta' } }), /update\.channel is not a known field/);
});

test('install: a plugin of a marketplace, a git checkout, or anything else', () => {
  assert.deepEqual(installOf('/home/p/.claude-work/plugins/cache/kharos/kharos/0.3.1'), { kind: 'plugin', marketplace: 'kharos' });
  assert.deepEqual(installOf('/home/p/.claude/plugins/cache/team-tools/kharos/0.3.1'), { kind: 'plugin', marketplace: 'team-tools' });
  assert.deepEqual(installOf(path.resolve(import.meta.dirname, '..')), { kind: 'git' });
  assert.equal(installedVersion(path.resolve(import.meta.dirname, '..')), JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
});

test('doctor: a newer release shows a warning, what changed and the update offer; it runs nothing', async () => {
  const sb = sandbox();
  const root = fs.mkdtempSync(path.join(sb.dir, 'plugins-'));
  const dir = path.join(root, 'plugins', 'cache', 'kharos', 'kharos', '0.3.1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kharos', version: '0.3.1' }));
  const v = await readReleaseView(sb.paths, online(sb), T0, { fetcher: github('v0.4.0'), root: dir, npmVersion: () => '0.3.0' });
  assert.equal(v.latest, '0.4.0');
  assert.equal(loadReleaseCache(sb.paths)?.latest, '0.4.0', 'the doctor\'s read counts as the day\'s');
  writeConfig(sb);
  const text = formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env, release: v }, DOCTOR_DEPS));
  assert.match(text, /^warn  kharos: 0\.3\.1 installed; 0\.4\.0 is the latest release$/m);
  assert.match(text, /^warn  kharos npm: the kharos command installed from npm is 0\.3\.0\n {6}Run `npm install -g kharos@0\.4\.0` to update it\.$/m);
  const changes = formatRelease(v);
  assert.match(changes, /What changed from 0\.3\.1 to 0\.4\.0/);
  assert.match(changes, /## 0\.4\.0[\s\S]*## 0\.3\.2/);
  assert.match(changes, new RegExp(`^${UPDATE_OFFER} 0\\.4\\.0 \\(runs \`claude plugin marketplace update kharos\` then \`claude plugin update kharos@kharos\``, 'm'));
});

test('doctor: the latest release installed is ok, and an unreachable GitHub is only information', async () => {
  const sb = sandbox();
  const root = path.resolve(import.meta.dirname, '..');
  const installed = installedVersion(root) as string;
  const same = await readReleaseView(sb.paths, online(sb), T0, { fetcher: github(`v${installed}`), root, npmVersion: () => null });
  writeConfig(sb);
  const deps = DOCTOR_DEPS;
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env, release: same }, deps)), new RegExp(`^ok    kharos: ${installed.replace(/\./g, '\\.')}, the latest release$`, 'm'));
  assert.equal(formatRelease(same), '');
  const down = await readReleaseView(sb.paths, online(sb), T0, { fetcher: unreachable, root, npmVersion: () => assert.fail('npm is asked only when a release is known') });
  const text = formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env, release: down }, deps), { verbose: true });
  assert.match(text, /^info  kharos: .*the latest release could not be read \(connect ECONNREFUSED/m);
  assert.equal(formatRelease(down), '');
});

test('doctor: a git checkout is told to pull, with no update offer', () => {
  const v = view({ install: { kind: 'git' } });
  assert.doesNotMatch(formatRelease(v), new RegExp(UPDATE_OFFER));
  assert.match(applyUpdate(v, '0.3.2', () => assert.fail('nothing runs')).lines.join('\n'), /not installed as a Claude Code plugin; run `git pull`/);
});

test('update: refused, with nothing run, unless the version said yes to is the latest and newer', () => {
  const never = () => assert.fail('nothing runs');
  assert.match(applyUpdate(view(), '0.3.3', never).lines[0] as string, /the latest release is 0\.3\.2, not 0\.3\.3/);
  assert.match(applyUpdate(view(), 'latest', never).lines[0] as string, /"latest" is not a version/);
  assert.match(applyUpdate(view({ latest: '0.3.1' }), '0.3.1', never).lines[0] as string, /already the latest release/);
  assert.match(applyUpdate(view({ latest: null, error: 'GitHub answered 403' }), '0.3.2', never).lines[0] as string, /could not be read \(GitHub answered 403\)/);
});

test('update: runs the marketplace update, then the plugin update, and says to restart', () => {
  const ran: string[][] = [];
  const r = applyUpdate(view({ install: { kind: 'plugin', marketplace: 'team-tools' }, npm: '0.3.1' }), 'v0.3.2', (args) => {
    ran.push(args);
    return { status: 0, output: '' };
  });
  assert.ok(r.ok);
  assert.deepEqual(ran, [
    ['plugin', 'marketplace', 'update', 'team-tools'],
    ['plugin', 'update', 'kharos@team-tools'],
  ]);
  assert.match(r.lines.join('\n'), /kharos 0\.3\.2 is installed: restart Claude Code to load it\.\nThe kharos command from npm is 0\.3\.1: run `npm install -g kharos@0\.3\.2` to update it too\./);
});

test('update: a failed marketplace update stops before the plugin update', () => {
  const ran: string[][] = [];
  const r = applyUpdate(view(), '0.3.2', (args) => {
    ran.push(args);
    return { status: 1, output: 'marketplace not found' };
  });
  assert.equal(r.ok, false);
  assert.equal(ran.length, 1);
  assert.match(r.lines.join('\n'), /failed \(1\)\n {2}marketplace not found\nkharos was not updated/);
});

/** A local GitHub for the CLI, which reads releases over HTTP. */
async function serve(tag: string): Promise<{ api: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/releases/latest')) res.end(JSON.stringify({ tag_name: tag }));
    else if (req.url?.includes('/contents/CHANGELOG.md')) res.end(`## ${tag.slice(1)}\n\n- something new\n`);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { api: `http://127.0.0.1:${port}/repos/bpsanti/kharos`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A claude binary that records every call. */
function recordingClaude(sb: Sandbox): { env: NodeJS.ProcessEnv; calls: () => string } {
  const log = path.join(sb.dir, 'claude-calls.txt');
  const bin = path.join(sb.dir, 'claude-recording');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = --version ]; then echo '2.1.332 (Claude Code)'; fi\nexit 0\n`, { mode: 0o755 });
  return { env: { ...sb.env, KHAROS_CLAUDE_BIN: bin }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

test('cli: kharos doctor reads the latest release and changes nothing; --update refuses outside a plugin install', async () => {
  const sb = sandbox();
  writeConfig(sb);
  const gh = await serve('v99.0.0');
  try {
    const claude = recordingClaude(sb);
    const env = { ...claude.env, KHAROS_RELEASES_API: gh.api, PATH: '' };
    const r = await captured(() => main(['doctor'], env, () => ''));
    assert.match(r.stdout, /^warn  kharos: .* installed; 99\.0\.0 is the latest release\n {6}To update it, run `git pull` in its folder, then restart Claude Code\.$/m);
    assert.match(r.stdout, /What changed from .* to 99\.0\.0 \(CHANGELOG\.md\):\n## 99\.0\.0\n\n- something new/);
    const u = await captured(() => main(['doctor', '--update', '99.0.0'], env, () => ''));
    assert.equal(u.value, 1);
    assert.match(u.stdout, /not updated: this kharos is not installed as a Claude Code plugin/);
    assert.doesNotMatch(claude.calls(), /plugin/, 'no update command ran');
    assert.equal(loadReleaseCache(sb.paths)?.latest, '99.0.0');
  } finally {
    await gh.close();
  }
});

test('cli: list adds the notice once, from the cache, and not when it is turned off', async () => {
  const sb = sandbox();
  writeConfig(sb);
  const env = online(sb);
  writeCache(sb, { checked_at: new Date().toISOString(), latest: '99.0.0' });
  const first = await captured(() => main(['list'], env, () => ''));
  assert.match(first.stdout, /^kharos 99\.0\.0 is available \(you have .*\); \/kharos:doctor shows what changed and updates it\.$/m);
  const second = await captured(() => main(['list'], env, () => ''));
  assert.doesNotMatch(second.stdout, /is available/);
  writeCache(sb, { checked_at: new Date().toISOString(), latest: '99.0.0' });
  writeConfig(sb, { update: { notify: false } });
  const off = await captured(() => main(['list'], env, () => ''));
  assert.doesNotMatch(off.stdout, /is available/);
});

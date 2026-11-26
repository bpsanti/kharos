import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, planMigration } from '../src/accounts.ts';
import { loadConfig, pickProfile, parseConfig } from '../src/config.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import type { ManagedPolicy } from '../src/managed-policy.ts';
import { accountKey, resolvePaths, sharedPaths } from '../src/paths.ts';
import { updateRegistry } from '../src/registry.ts';
import { result as showResult } from '../src/commands.ts';
import { saveEnvironments } from '../src/state.ts';
import { formatSetup, parseScheduleView, readGitHub, runSetup, SetupError, type SetupInput } from '../src/setup.ts';
import { HEADS_EMPTY, HEADS_OK, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const ME = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NO_POLICY: ManagedPolicy = { status: 'absent', file: '/home/person/.claude/remote-settings.json' };

/** What the /schedule skill shows, in its own format, for an account with two environments. */
const LISTED = ['Available environments:', '- demo (id: env_01DEMO, kind: anthropic_cloud)', '- Default (id: env_01DEFAULT, kind: anthropic_cloud)'].join('\n');
const NOT_CONNECTED = `${LISTED}\n⚠ Heads-up:\n- GitHub isn't connected to your Claude account, so example/demo can't be cloned in the cloud. Run /web-setup to connect with your GitHub CLI login, or connect on the web at https://claude.ai/connect-github`;

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', account: ME, email: 'person@example.com' }),
    heads: () => HEADS_OK,
    ownerType: () => 'User',
    settings: () => ({ status: 'absent' }),
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    managedPolicy: () => NO_POLICY,
    repoRole: () => 'admin',
    setupScript: () => ({ status: 'absent' }),
    ...over,
  };
}

function input(sb: Sandbox, over: Partial<SetupInput> = {}): SetupInput {
  return { repo: 'example/demo', makeDefault: false, view: parseScheduleView(LISTED), here: 'example/demo', noRemoteTool: false, shared: null, adopt: null, now: T0, env: sb.env, ...over };
}

test('setup: reads the environments and the GitHub heads-up the /schedule skill shows', () => {
  const v = parseScheduleView(NOT_CONNECTED)!;
  assert.deepEqual(v.environments, [
    { name: 'demo', id: 'env_01DEMO', kind: 'anthropic_cloud' },
    { name: 'Default', id: 'env_01DEFAULT', kind: 'anthropic_cloud' },
  ]);
  assert.equal(v.notes.length, 1);
  assert.equal(readGitHub(v, 'example/demo', 'example/demo').state, 'not-connected');
  assert.equal(readGitHub(v, 'other/repo', 'example/demo').state, 'not-connected', 'a missing connection is about the account, whatever the folder');

  const ok = parseScheduleView(LISTED);
  assert.equal(readGitHub(ok, 'example/demo', 'example/demo').state, 'connected');
  assert.equal(readGitHub(ok, 'Example/Demo', 'example/demo').state, 'connected');
  assert.equal(readGitHub(ok, 'other/repo', 'example/demo').state, 'not-checked', 'silence says nothing about another repository');
  assert.equal(readGitHub(ok, null, 'example/demo').state, 'not-checked');
  assert.equal(readGitHub(null, 'example/demo', 'example/demo').state, 'not-checked');
  assert.equal(readGitHub(parseScheduleView(''), 'example/demo', 'example/demo').state, 'not-checked', 'no list means the skill did not run all the way');

  const app = parseScheduleView(`${LISTED}\n- Claude GitHub App not installed on example/demo — install at https://claude.ai/code/onboarding?magic=github-app-setup if your scheduled task needs this repo.`);
  assert.equal(readGitHub(app, 'example/demo', 'example/demo').state, 'no-access');
  const transient = parseScheduleView(`${LISTED}\n- Couldn't verify GitHub access for example/demo (the check failed in a way that may be temporary)`);
  assert.equal(readGitHub(transient, 'example/demo', 'example/demo').state, 'unverified');
});

test('setup: one list up front, then each step in order, and the profile only once all are settled', () => {
  const sb = sandbox();
  // GitHub is missing: the whole list shows, the first gap is the next action, nothing is written.
  let r = runSetup(sb.paths, input(sb, { view: parseScheduleView(NOT_CONNECTED) }), deps());
  assert.equal(r.steps.length, 7);
  assert.deepEqual(r.steps.map((s) => s.state), ['ok', 'missing', 'check', 'choose', 'note', 'choose', 'waiting']);
  assert.deepEqual(r.next, { kind: 'person', step: 2, action: r.steps[1]?.action });
  assert.match(r.steps[1]?.action ?? '', /\/web-setup/);
  assert.match(r.steps[0]?.detail ?? '', /person@example\.com/, 'says which account it checks');
  const text = formatSetup(r);
  for (const t of ['Account and plan', 'GitHub connection', 'Repository access', 'Cloud environment', 'Commit identity', 'Permission prompts', 'Profile']) assert.match(text, new RegExp(t));
  assert.match(text, /Claude <noreply@anthropic\.com>/);
  assert.match(text, /GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL/);
  assert.match(text, /next: person \(step 2\)$/);
  assert.equal(loadConfig(sb.paths).exists, false);

  // Connected: the environment is picked by name, the best fit for the repository first.
  r = runSetup(sb.paths, input(sb), deps());
  assert.equal(r.steps[1]?.state, 'ok');
  assert.equal(r.next.kind, 'ask-environment');
  if (r.next.kind === 'ask-environment') assert.deepEqual(r.next.options, [{ name: 'demo', recommended: true }, { name: 'Default', recommended: false }]);
  assert.doesNotMatch(formatSetup(r).split('Environments, best fit first')[1] ?? '', /env_/, 'the person never sees an id');

  // Then the permission modes, every one of them, asked once.
  r = runSetup(sb.paths, input(sb, { environment: 'Demo' }), deps());
  assert.equal(r.next.kind, 'ask-permissions');
  if (r.next.kind === 'ask-permissions') {
    assert.deepEqual(r.next.options.map((o) => o.id), ['as-is', 'standard', 'hook', 'standard+hook', 'mirror', 'broad', 'auto-preflight', 'unblock', 'auto-unblock']);
    assert.match(r.next.options.find((o) => o.id === 'mirror')?.unavailable ?? '', /no copy of the organization's managed settings/);
    assert.match(r.next.options.find((o) => o.id === 'unblock')?.unavailable ?? '', /no copy/);
    assert.equal(r.next.offer[0], 'standard', 'the recommended mode comes first');
    assert.ok(r.next.offer.length <= 4);
  }
  assert.match(formatSetup(r), /trade-off: /);
  assert.equal(loadConfig(sb.paths).exists, false);

  // Settled: the profile is written, with the name, the choice and the account, and the summary is short.
  r = runSetup(sb.paths, input(sb, { environment: 'demo', permissions: 'standard' }), deps());
  assert.equal(r.next.kind, 'ready');
  if (r.next.kind === 'ready') {
    assert.ok(r.next.summary.length <= 6, r.next.summary.join('\n'));
    assert.match(r.next.summary[0] ?? '', /^Ready: profile demo \(default\) launches on example\/demo@main in "demo"\.$/);
    assert.match(r.next.summary.join('\n'), /GitHub: Claude reaches example\/demo\./);
    assert.match(r.next.summary.at(-1) ?? '', /^Next: \/kharos:permissions standard$/);
  }
  const p = loadConfig(sb.paths).config.profiles.demo;
  assert.equal(p?.environment, 'env_01DEMO');
  assert.equal(p?.environment_name, 'demo');
  assert.equal(p?.permissions, 'standard');
  assert.equal(p?.account, ME);

  // Run again: nothing is asked a second time.
  r = runSetup(sb.paths, input(sb), deps());
  assert.equal(r.next.kind, 'ready');
});

test('setup: a single environment is picked without a question, and an empty repository asks for a first commit', () => {
  const sb = sandbox();
  const one = parseScheduleView('Available environments:\n- Default (id: env_01DEFAULT, kind: anthropic_cloud)');
  const r = runSetup(sb.paths, input(sb, { view: one, permissions: 'as-is' }), deps());
  assert.equal(r.next.kind, 'ready');
  assert.equal(loadConfig(sb.paths).config.profiles.demo?.environment_name, 'Default');
  if (r.next.kind === 'ready') assert.match(r.next.summary.at(-1) ?? '', /^Next: \/kharos:run/);

  const empty = sandbox();
  const e = runSetup(empty.paths, input(empty, { view: one, permissions: 'as-is' }), deps({ heads: () => HEADS_EMPTY }));
  assert.equal(e.next.kind, 'ask-initial-commit');
  assert.equal(loadConfig(empty.paths).exists, false);
});

test('setup: an empty --from-schedule paste reads as not listed, so an existing environment or an env_ id is kept', () => {
  assert.equal(parseScheduleView(''), null);
  assert.deepEqual(parseScheduleView('Available environments:'), { environments: [], notes: [] }, 'a list with no entry is an account with no environment');

  const sb = sandbox();
  const byId = runSetup(sb.paths, input(sb, { view: parseScheduleView(''), environment: 'env_01PASTED', permissions: 'as-is' }), deps());
  assert.equal(byId.steps[3]?.state, 'ok');
  assert.equal(byId.next.kind, 'ready');
  assert.equal(loadConfig(sb.paths).config.profiles.demo?.environment, 'env_01PASTED');

  const again = runSetup(sb.paths, input(sb, { view: parseScheduleView(''), permissions: 'as-is' }), deps());
  assert.equal(again.steps[3]?.state, 'check');
  assert.doesNotMatch(again.steps[3]?.detail ?? '', /listed no environment/);
});

test('setup: a repository other than this folder keeps GitHub unconfirmed, and the summary says the first launch checks it', () => {
  const sb = sandbox();
  const r = runSetup(sb.paths, input(sb, { here: 'other/repo', environment: 'demo', permissions: 'standard' }), deps());
  assert.equal(r.steps[1]?.state, 'check');
  assert.equal(r.next.kind, 'ready');
  if (r.next.kind === 'ready') {
    assert.match(r.next.summary.join('\n'), /GitHub: not confirmed for example\/demo yet; the first launch checks it/);
    assert.match(r.next.summary.at(-1) ?? '', /\/kharos:permissions standard in a checkout of example\/demo/);
  }
});

test('setup: modes the organization rules out are listed with the reason, and cannot be chosen', () => {
  const sb = sandbox();
  const strict: ManagedPolicy = { status: 'found', file: 'f', ask: ['Bash(psql *)'], deny: [], bypassDisabled: true, managedHooksOnly: false };
  const r = runSetup(sb.paths, input(sb, { environment: 'demo' }), deps({ managedPolicy: () => strict }));
  assert.equal(r.next.kind, 'ask-permissions');
  if (r.next.kind === 'ask-permissions') {
    assert.match(r.next.options.find((o) => o.id === 'mirror')?.unavailable ?? '', /disableBypassPermissionsMode/);
    assert.match(r.next.options.find((o) => o.id === 'auto-unblock')?.unavailable ?? '', /disableBypassPermissionsMode/);
    assert.equal(r.next.options.find((o) => o.id === 'hook')?.unavailable, null);
    assert.ok(!r.next.offer.includes('unblock'));
  }
  assert.throws(() => runSetup(sb.paths, input(sb, { environment: 'demo', permissions: 'unblock' }), deps({ managedPolicy: () => strict })), SetupError);

  const hooksOnly: ManagedPolicy = { status: 'found', file: 'f', ask: [], deny: [], bypassDisabled: false, managedHooksOnly: true };
  const h = runSetup(sb.paths, input(sb, { environment: 'demo' }), deps({ managedPolicy: () => hooksOnly }));
  if (h.next.kind === 'ask-permissions') {
    for (const id of ['hook', 'standard+hook', 'auto-preflight', 'broad']) assert.match(h.next.options.find((o) => o.id === id)?.unavailable ?? '', /allowManagedHooksOnly/, id);
    assert.deepEqual(h.next.offer, ['standard', 'as-is']);
  } else assert.fail(`expected the permission question, got ${h.next.kind}`);
});

test('setup: a profile of another account keeps its name, and this account gets one of its own', () => {
  const sb = sandbox();
  writeConfig(sb, { profiles: { demo: { repo: 'https://github.com/example/demo', environment: 'env_01THEIRS', account: OTHER } } });
  const r = runSetup(sb.paths, input(sb, { environment: 'demo', permissions: 'as-is' }), deps());
  assert.equal(r.profile, 'demo-aaaaaa');
  const profiles = loadConfig(sb.paths).config.profiles;
  assert.equal(profiles.demo?.environment, 'env_01THEIRS', "the other account's profile is untouched");
  assert.equal(profiles['demo-aaaaaa']?.environment, 'env_01DEMO');
  assert.throws(() => runSetup(sb.paths, input(sb, { profile: 'demo' }), deps()), /another Claude account/);

  // With no name, a launch takes this account's only profile over a default another account set.
  const picked = pickProfile(loadConfig(sb.paths).config, undefined, ME);
  assert.equal(picked.name, 'demo-aaaaaa');
  assert.throws(() => pickProfile(parseConfig({ version: 1, default_profile: 'demo', profiles: { demo: { repo: 'a/b', environment: 'env_1', account: OTHER } } }), undefined, ME), /another Claude account/);
});

test('paths: the default Claude folder keeps the files kharos always used; any other account gets its own', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kharos-home-'));
  const base = { HOME: home };
  assert.equal(accountKey(base), null);
  assert.equal(accountKey({ ...base, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }), null);
  const key = accountKey({ ...base, CLAUDE_CONFIG_DIR: '~/.claude-work' });
  assert.match(key ?? '', /^claude-work-[0-9a-f]{8}$/);
  assert.equal(resolvePaths(base).config, path.join(home, '.config', 'kharos', 'config.json'));
  assert.equal(resolvePaths({ ...base, CLAUDE_CONFIG_DIR: '~/.claude-work' }).config, path.join(home, '.config', 'kharos', 'accounts', key as string, 'config.json'));
  assert.equal(sharedPaths(base), null);
  assert.equal(sharedPaths({ ...base, CLAUDE_CONFIG_DIR: '~/.claude-work' })?.config, path.join(home, '.config', 'kharos', 'config.json'));
  assert.equal(sharedPaths({ ...base, KHAROS_HOME: path.join(home, 'k'), CLAUDE_CONFIG_DIR: '~/.claude-work' }), null);
});

test('accounts: this account takes its profiles and sessions out of the shared files once, and is asked only about the unknown ones', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kharos-home-'));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') };
  const mine = resolvePaths(env);
  const shared = sharedPaths(env);
  assert.ok(shared);
  fs.mkdirSync(path.dirname(shared.config), { recursive: true });
  fs.writeFileSync(
    shared.config,
    JSON.stringify({
      version: 1,
      default_profile: 'work',
      profiles: {
        work: { repo: 'example/work', environment: 'env_01WORK' }, // launched by this account
        stamped: { repo: 'example/stamped', environment: 'env_01S', account: ME },
        theirs: { repo: 'example/theirs', environment: 'env_01T', account: OTHER },
        unused: { repo: 'example/unused', environment: 'env_01U' },
      },
      outputs: [],
    }),
  );
  updateRegistry(shared, (reg) => {
    reg.next_seq = 3;
    reg.sessions['k-0001'] = { id: 'k-0001', profile: 'work', account: ME } as never;
    reg.sessions['k-0002'] = { id: 'k-0002', profile: 'theirs', account: OTHER } as never;
  });
  fs.mkdirSync(shared.logs, { recursive: true });
  fs.writeFileSync(path.join(shared.logs, 'k-0001.jsonl'), '{}\n');

  assert.deepEqual(planMigration(shared, ME), { mine: ['work', 'stamped'], unknown: ['unused'], sessions: ['k-0001'] });
  assert.deepEqual(migrate(mine, shared, ME, null, T0), { state: 'ask', unknown: ['unused'] });
  assert.equal(fs.existsSync(mine.config), false, 'nothing moves before the answer');

  const done = migrate(mine, shared, ME, [], T0);
  assert.equal(done.state, 'done');
  const own = loadConfig(mine).config;
  assert.deepEqual(Object.keys(own.profiles).sort(), ['stamped', 'work']);
  assert.equal(own.profiles.work?.account, ME);
  assert.equal(own.default_profile, 'work');
  const left = loadConfig(shared).config;
  assert.deepEqual(Object.keys(left.profiles).sort(), ['theirs', 'unused']);
  assert.equal(left.default_profile, null);
  assert.ok(fs.existsSync(path.join(mine.logs, 'k-0001.jsonl')));
  assert.equal(fs.existsSync(path.join(shared.logs, 'k-0001.jsonl')), false);
  const reg = JSON.parse(fs.readFileSync(mine.registry, 'utf8'));
  assert.deepEqual(Object.keys(reg.sessions), ['k-0001']);
  assert.equal(reg.next_seq, 3, 'new ids do not collide with the shared ones');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(shared.registry, 'utf8')).sessions), ['k-0002']);
  // Once only.
  assert.equal(migrate(mine, shared, ME, null, T0).state, 'done');
  assert.equal(planMigration(shared, ME)?.unknown[0], 'unused');
});

test('setup: asks once which shared profiles are this account\'s, before anything else is written', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kharos-home-'));
  const sb = sandbox();
  const env = { ...sb.env, KHAROS_HOME: '', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') } as NodeJS.ProcessEnv;
  delete env.KHAROS_HOME;
  const paths = resolvePaths(env);
  const shared = sharedPaths(env);
  fs.mkdirSync(path.dirname(shared!.config), { recursive: true });
  fs.writeFileSync(shared!.config, JSON.stringify({ version: 1, profiles: { old: { repo: 'example/old', environment: 'env_01OLD' } } }));
  const r = runSetup(paths, { ...input(sb), env, shared, permissions: 'as-is', environment: 'demo' }, deps());
  assert.deepEqual(r.next, { kind: 'ask-adopt', profiles: ['old'] });
  assert.equal(r.steps[0]?.state, 'choose');
  assert.equal(fs.existsSync(paths.config), false);
  const doc = formatChecks(runDoctor(paths, { now: T0, env, shared }, deps()));
  assert.match(doc, /warn {2}account files: .*1 profile\(s\) whose account kharos cannot tell \(old\)/);

  const again = runSetup(paths, { ...input(sb), env, shared, permissions: 'as-is', environment: 'demo', adopt: ['old'] }, deps());
  assert.equal(again.next.kind, 'ready');
  assert.deepEqual(Object.keys(loadConfig(paths).config.profiles).sort(), ['demo', 'old']);
});

test('doctor: on a new account, only what the person can act on is a warning', () => {
  const sb = sandbox();
  writeConfig(sb);
  saveEnvironments(sb.paths, [], T0); // no routine uses an environment yet
  const settings = () => ({ status: 'found' as const, text: JSON.stringify({ permissions: { allow: ['Bash(*)', 'Bash(npm test)'] } }) });
  const checks = runDoctor(sb.paths, { now: T0, env: sb.env }, deps({ settings, repoRole: () => 'write' }));
  const text = formatChecks(checks);
  assert.doesNotMatch(text, /warn/, text);
  assert.doesNotMatch(text, /not used by any of your routines/);
  assert.match(text, /Claude's GitHub access is not confirmed yet for demo/);
  const verbose = formatChecks(checks, { verbose: true });
  assert.match(verbose, /info  demo: permissions: .*broad allow rule.*which its maintainers decide/);
  assert.match(verbose, /info  demo: environment: .*expected on a new account/);
  assert.match(verbose, /info  commits: .*Claude <noreply@anthropic\.com>/);
  assert.match(verbose, /info  limits: /);

  // The person who can change the repository is told, as an action.
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps({ settings }))), /warn {2}demo: permissions: .*broad allow rule/);
  // So is a profile on an account that has routines, none of them on that environment.
  saveEnvironments(sb.paths, [{ id: 'env_other', routines: 1, last_used: null }], T0);
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps())), /warn {2}demo: environment: .*\n {6}Run \/kharos:setup to pick the environment by name/);
});

test('doctor: a profile of another account is not checked as this one\'s, and fails when named', () => {
  const sb = sandbox();
  writeConfig(sb, { profiles: { demo: { repo: 'https://github.com/example/demo', environment: 'env_01T', account: OTHER } } });
  const all = runDoctor(sb.paths, { now: T0, env: sb.env }, deps());
  assert.equal(all.find((c) => c.name === 'profile demo')?.level, 'info');
  assert.equal(all.find((c) => c.name === 'demo: repo'), undefined);
  const named = runDoctor(sb.paths, { profile: 'demo', now: T0, env: sb.env }, deps());
  assert.equal(named.find((c) => c.name === 'profile demo')?.level, 'fail');
});

test('result: the command that brings a branch here names the repository, never origin', () => {
  const sb = sandbox();
  updateRegistry(sb.paths, (reg) => {
    reg.sessions['k-0001'] = { id: 'k-0001', repo: 'https://github.com/example/demo', state: 'finished', step: 'open', result: { status: 'ok', pr: null, branch: 'feat/x', summary: null, question: null }, session_id: null, url: null } as never;
  });
  const text = showResult(sb.paths, 'k-0001', sb.env);
  assert.match(text, /git fetch https:\/\/github\.com\/example\/demo\.git 'feat\/x:feat\/x'/);
  assert.doesNotMatch(text, /\borigin\b/);
});

test('setup: a repository with a setup script asks once whether the environment runs it, and records the answer', () => {
  const sb = sandbox();
  const script = () => ({ status: 'found' as const, text: '#!/bin/sh\necho setup\n' });
  let r = runSetup(sb.paths, input(sb, { environment: 'demo', permissions: 'as-is' }), deps({ setupScript: script }));
  assert.equal(r.next.kind, 'ask-environment-ready');
  if (r.next.kind === 'ask-environment-ready') assert.deepEqual(r.next, { kind: 'ask-environment-ready', environment: 'demo', script: 'tools/cloud/bootstrap.sh', changed: false });
  assert.equal(loadConfig(sb.paths).exists, false);

  r = runSetup(sb.paths, input(sb, { environment: 'demo', permissions: 'as-is', confirmed: true }), deps({ setupScript: script }));
  assert.equal(r.next.kind, 'ready');
  // Once recorded, it is not asked again; a changed script asks again.
  assert.equal(runSetup(sb.paths, input(sb), deps({ setupScript: script })).next.kind, 'ready');
  const changed = runSetup(sb.paths, input(sb), deps({ setupScript: () => ({ status: 'found', text: 'echo other\n' }) }));
  assert.equal(changed.next.kind, 'ask-environment-ready');
  if (changed.next.kind === 'ask-environment-ready') assert.equal(changed.next.changed, true);

  // "A new environment" hands over to the assisted path of kharos env-guide.
  const fresh = sandbox();
  const n = runSetup(fresh.paths, input(fresh, { environment: 'new', permissions: 'as-is' }), deps());
  assert.equal(n.next.kind, 'env-assist');
  if (n.next.kind === 'env-assist') assert.match(n.next.action, /kharos env-guide --repo example\/demo --copy --open/);
});

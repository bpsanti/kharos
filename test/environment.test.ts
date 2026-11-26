import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { runDoctor, type DoctorDeps } from '../src/doctor.ts';
import {
  buildGuide,
  copyToClipboard,
  formatGuide,
  GuideError,
  minimalScript,
  namedFiles,
  openBrowser,
  scriptDigest,
  waitForEnvironment,
} from '../src/environment.ts';
import { postToolUse } from '../src/hook.ts';
import type { RemoteSettings } from '../src/permissions.ts';
import { findSetup, loadEnvironments, loadSetups, recordSetup, saveEnvironments } from '../src/state.ts';
import { captured, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const SCRIPT = [
  '#!/usr/bin/env bash',
  '# snapshot: 2026-01-02',
  '# Paste this whole file as the setup script (docs/environment/cloud.md); the work is in tools/cloud/setup.sh.',
  'LOG=${DEMO_CLOUD_LOG:-/var/log/demo.log}',
  'HOOK=/usr/local/bin/demo-session.sh',
  'bash tools/cloud/setup.sh >> "$LOG"',
  'exit 0',
  '',
].join('\n');

const REPO: Record<string, string> = {
  'tools/cloud/bootstrap.sh': SCRIPT,
  'tools/cloud/setup.sh': [
    '#!/usr/bin/env bash',
    'BUDGET=${DEMO_BUDGET_S:-900}',
    'for DEMO_ITEM in a b; do echo "$DEMO_ITEM $BUDGET $HOME ${CLAUDE_PROJECT_DIR:-}"; done',
    '# $DEMO_IN_A_COMMENT is not read',
    'curl -H "Authorization: Bearer $DEMO_REGISTRY_TOKEN" https://registry.example.com',
    '',
  ].join('\n'),
  'docs/environment/cloud.md': [
    '# The cloud environment',
    '3. Network access: Full (unrestricted).',
    '',
    '| Variable | Needed for | What it is |',
    '| --- | --- | --- |',
    '| `DEMO_QUEUE_TOKEN` | the queue | A token of yours; example `DEMO_QUEUE_TOKEN=ghp_0123456789abcdefghij0123`. |',
    '',
    '| File | What |',
    '| --- | --- |',
    '| `/var/log/demo.log` | the log |',
    '',
    'The keys of the model are in `model.env.example`.',
    '',
  ].join('\n'),
  'model.env.example': ['# The model, as the provider lists it.', 'DEMO_MODEL=do-not-show-this-value', '', '# DEMO_REGION=also-hidden', ''].join('\n'),
};

function reader(files: Record<string, string>): (file: string) => RemoteSettings {
  return (file) => (file in files ? { status: 'found', text: files[file] as string } : { status: 'absent' });
}

test('guide: the shipped script verbatim, the documented variables and network, and never a value', () => {
  const g = buildGuide('example/demo', 'main', reader(REPO));
  assert.equal(g.shipped, true);
  assert.equal(g.script, SCRIPT);
  assert.deepEqual(g.variables.map((v) => v.name), ['DEMO_QUEUE_TOKEN', 'DEMO_MODEL', 'DEMO_REGION', 'DEMO_REGISTRY_TOKEN']);
  assert.match(g.variables[0]!.purpose, /^Needed for: the queue; What it is: A token of yours/);
  assert.equal(g.variables[1]!.purpose, 'The model, as the provider lists it.');
  assert.equal(g.variables[3]!.source, 'tools/cloud/setup.sh');
  assert.deepEqual(g.overrides, ['DEMO_BUDGET_S', 'DEMO_CLOUD_LOG']);
  assert.equal(g.network.level, 'Full');
  const text = formatGuide(g, { copied: 'pbcopy', opened: true, since: 'env_01OLD' });
  assert.match(text, /Network access: Full \(docs\/environment\/cloud\.md says/);
  assert.match(text, /copied to the clipboard with pbcopy; it is printed below\./);
  assert.match(text, /# snapshot: 2026-01-02/);
  assert.match(text, /default environment before you start: env_01OLD$/);
  assert.doesNotMatch(text, /do-not-show|also-hidden|ghp_0123/);
});

test('guide: without a script in the repository, a minimal one and the default network level', () => {
  const g = buildGuide('https://github.com/example/demo', 'main', reader({ '.env.example': 'API_URL=\n' }));
  assert.equal(g.shipped, false);
  assert.equal(g.script, minimalScript('example/demo'));
  assert.deepEqual(g.variables.map((v) => v.name), ['API_URL']);
  assert.equal(g.network.level, 'Limited');
  assert.match(formatGuide(g, { copied: null, since: null }), /ships no tools\/cloud\/bootstrap\.sh.*no clipboard tool worked/);
});

test('guide: a repository gh cannot read gives no script at all', () => {
  assert.throws(() => buildGuide('example/demo', 'main', () => ({ status: 'unreadable', error: 'HTTP 401' })), GuideError);
});

test('guide: only files inside the repository are followed', () => {
  assert.deepEqual(namedFiles('see docs/a.md, $HOME/.claude/CLAUDE.md, /usr/local/bin/x.sh, ../up/b.sh, tools/c.test.sh and x.env.example'), ['docs/a.md', 'x.env.example']);
});

/** A PATH with only these tools, so a test never touches the real clipboard or browser. */
function tools(sb: Sandbox, scripts: Record<string, string>): NodeJS.ProcessEnv {
  const bin = path.join(sb.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ...sb.env, PATH: `${bin}:/bin` };
}

test('clipboard and browser: the first tool that works, and null or false without one', () => {
  const sb = sandbox();
  const env = tools(sb, { xclip: `cat > "${sb.dir}/clip.txt"`, 'xdg-open': `echo "$1" > "${sb.dir}/opened.txt"` });
  assert.equal(copyToClipboard(SCRIPT, env, 'linux'), 'xclip');
  assert.equal(fs.readFileSync(path.join(sb.dir, 'clip.txt'), 'utf8'), SCRIPT);
  assert.equal(openBrowser('https://claude.ai/code', env, 'linux'), true);
  assert.equal(fs.readFileSync(path.join(sb.dir, 'opened.txt'), 'utf8'), 'https://claude.ai/code\n');
  const none = { ...sb.env, PATH: path.join(sb.dir, 'empty') };
  assert.equal(copyToClipboard(SCRIPT, none, 'linux'), null);
  assert.equal(openBrowser('https://claude.ai/code', none, 'linux'), false);
  // `start` takes its first quoted argument as a window title, so the empty one keeps the url as the target.
  const win = tools(sb, { cmd: `printf '%s|' "$@" > "${sb.dir}/cmd.txt"` });
  assert.equal(openBrowser('https://claude.ai/code', win, 'win32'), true);
  assert.equal(fs.readFileSync(path.join(sb.dir, 'cmd.txt'), 'utf8'), '/c|start||https://claude.ai/code|');
});

function settingsFile(sb: Sandbox, id: string): void {
  fs.mkdirSync(path.join(sb.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.claude', 'settings.json'), JSON.stringify({ remote: { defaultEnvironmentId: id } }));
}

test('env-wait: sees the environment /remote-env saves, and gives up after its timeout', async () => {
  const sb = sandbox();
  settingsFile(sb, 'env_01OLD');
  assert.equal(await waitForEnvironment('env_01OLD', 20, sb.env, 5), null);
  setTimeout(() => settingsFile(sb, 'env_01NEW'), 20);
  assert.equal(await waitForEnvironment('env_01OLD', 5000, sb.env, 5), 'env_01NEW');
  const r = await captured(() => main(['env-wait', '--since', 'none'], sb.env, () => ''));
  assert.equal(r.value, 0);
  assert.match(r.stdout, /saved env_01NEW\. Confirm with the person/);
  assert.equal((await captured(() => main(['env-wait'], sb.env, () => ''))).value, 1);
});

test('environments: the answer says which environment is known for the repository', async () => {
  const sb = sandbox();
  const routine = (env: string, repo: string) => ({
    job_config: { ccr: { environment_id: env, session_context: { sources: [{ git_repository: { url: `https://github.com/${repo}` } }] } } },
  });
  const ask = async (repo: string) => {
    await captured(() => main(['environments', '--session', 's', '--repo', repo], sb.env, () => ''));
    const out = postToolUse(sb.ctx(Date.now()), {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_name: 'RemoteTrigger',
      tool_input: { action: 'list' },
      tool_response: response(200, { data: [routine('env_01DEMO', 'Example/Demo'), routine('env_01OTHER', 'example/other')] }),
    }) as any;
    return out.hookSpecificOutput.updatedToolOutput.summary as string;
  };
  assert.match(await ask('example/demo'), /env_01DEMO  used by 1 routine\(s\) on example\/demo[\s\S]*for example\/demo: env_01DEMO \(used by your routines on it\)/);
  assert.match(await ask('example/new'), /for example\/new: no environment is known to fit it/);
  const at = new Date(T0).toISOString();
  recordSetup(sb.paths, { account: loadEnvironments(sb.paths)!.account!, repo: 'example/new', revision: 'main', environment: 'env_01MAIN', confirmed_at: at, script_sha256: null });
  recordSetup(sb.paths, { account: loadEnvironments(sb.paths)!.account!, repo: 'example/new', revision: 'dev', environment: 'env_01DEV', confirmed_at: at, script_sha256: null });
  assert.match(await ask('example/new'), /for example\/new: env_01MAIN on main \(you confirmed it on 2026-11-25\), env_01DEV on dev \(you confirmed it on 2026-11-25\)/);
  assert.deepEqual(loadEnvironments(sb.paths)?.environments.map((e) => e.repos), [['example/demo'], ['example/other']]);
  assert.match(loadEnvironments(sb.paths)?.account ?? '', /^sha256:/);
});

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', account: 'sha256:x' }),
    heads: () => HEADS_OK,
    ownerType: () => 'User',
    settings: () => ({ status: 'absent' }),
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    repoRole: () => 'admin',
    managedPolicy: () => ({ status: 'absent', file: 'f' }),
    setupScript: () => ({ status: 'found', text: SCRIPT }),
    ...over,
  };
}

function environmentCheck(sb: Sandbox, over: Partial<DoctorDeps> = {}) {
  const c = runDoctor(sb.paths, { now: T0, env: sb.env }, deps(over)).find((x) => x.name === 'demo: environment');
  return { level: c?.level, text: [c?.detail, ...(c?.fix ?? [])].join('\n') };
}

test('doctor: offers the assisted path when no environment is known to fit the repository', () => {
  const sb = sandbox();
  writeConfig(sb);
  const use = (repos: string[]) => saveEnvironments(sb.paths, [{ id: 'env_01TESTENVIRONMENT', routines: 1, last_used: null, repos }], T0, 'sha256:x');

  saveEnvironments(sb.paths, [], T0, 'sha256:x');
  assert.equal(environmentCheck(sb).level, 'warn');
  assert.match(environmentCheck(sb).text, /\/kharos:setup walks you through creating one for example\/demo/);

  use(['example/other']);
  assert.equal(environmentCheck(sb).level, 'warn');
  assert.match(environmentCheck(sb).text, /none on example\/demo, which ships tools\/cloud\/bootstrap\.sh/);
  assert.equal(environmentCheck(sb, { setupScript: () => ({ status: 'absent' }) }).level, 'ok');

  use(['example/demo']);
  assert.equal(environmentCheck(sb).level, 'ok');

  // Another account's routines say nothing about this one's environments.
  assert.equal(environmentCheck(sb, { auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', account: 'sha256:y' }) }).level, 'info');
});

test('doctor: a confirmed environment passes until the setup script changes', () => {
  const sb = sandbox();
  writeConfig(sb);
  saveEnvironments(sb.paths, [], T0, 'sha256:x');
  const confirm = (revision: string, script: string) =>
    recordSetup(sb.paths, { account: 'sha256:x', repo: 'Example/Demo', revision, environment: 'env_01TESTENVIRONMENT', confirmed_at: new Date(T0).toISOString(), script_sha256: scriptDigest(script) });
  confirm('main', SCRIPT);
  assert.equal(environmentCheck(sb).level, 'ok');
  assert.match(environmentCheck(sb).text, /you confirmed it for example\/demo@main on 2026-11-25/);
  // A confirmation on another branch of the same repository, whose script differs, leaves the one on main alone.
  confirm('dev', SCRIPT.replace('2026-01-02', '2026-03-04'));
  assert.equal(environmentCheck(sb).level, 'ok');
  const changed = environmentCheck(sb, { setupScript: () => ({ status: 'found', text: SCRIPT.replace('2026-01-02', '2026-02-03') }) });
  assert.equal(changed.level, 'warn');
  assert.equal(
    changed.text,
    [
      'the setup script changed on main; paste it again',
      'Copy the new script with `kharos env-guide --profile demo --copy` and paste it into the "Setup script" of env_01TESTENVIRONMENT on claude.ai/code.',
      'Then confirm it with /kharos:setup.',
    ].join('\n'),
  );
});

test('doctor: a confirmation made while the repository shipped no setup script warns once it ships one', () => {
  const sb = sandbox();
  writeConfig(sb);
  saveEnvironments(sb.paths, [], T0, 'sha256:x');
  recordSetup(sb.paths, { account: 'sha256:x', repo: 'example/demo', revision: 'main', environment: 'env_01TESTENVIRONMENT', confirmed_at: new Date(T0).toISOString(), script_sha256: null });
  assert.equal(environmentCheck(sb, { setupScript: () => ({ status: 'absent' }) }).level, 'ok');
  assert.equal(environmentCheck(sb, { setupScript: () => ({ status: 'unreadable', error: 'HTTP 502' }) }).level, 'ok');
  const added = environmentCheck(sb);
  assert.equal(added.level, 'warn');
  assert.match(added.text, /^the setup script changed on main; paste it again\n/);
});

test('setup --confirmed writes the id into the profile and records it for this account', async () => {
  const sb = sandbox();
  const env = tools(sb, { gh: 'printf "%s" "echo setup"' });
  const r = await captured(() => main(['setup', '--profile', 'demo', '--repo', 'example/demo', '--revision', 'main', '--environment', 'env_01NEW', '--confirmed', '--permissions', 'as-is', '--account-mode', 'as-is', '--max-open', '10'], env, () => ''));
  assert.equal(r.value, 0);
  assert.match(r.stdout, /^Ready: profile demo \(default\) launches on example\/demo@main in env_01NEW\./);
  const stored = Object.values(JSON.parse(fs.readFileSync(sb.paths.setups, 'utf8')) as Record<string, { account: string }>)[0]!;
  assert.equal(findSetup(loadSetups(sb.paths), stored.account, 'example/demo', 'main')?.script_sha256, scriptDigest('echo setup'));
  assert.equal(findSetup(loadSetups(sb.paths), stored.account, 'example/demo', 'dev'), null);
  assert.doesNotMatch(r.stdout, /bootstrap\.sh could not be read/);

  const failing = tools(sb, { gh: 'echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1' });
  const u = await captured(() => main(['setup', '--profile', 'demo', '--repo', 'example/demo', '--revision', 'main', '--environment', 'env_01NEW', '--confirmed', '--permissions', 'as-is', '--account-mode', 'as-is'], failing, () => ''));
  assert.equal(u.value, 0, u.stderr);
  assert.match(u.stdout, /tools\/cloud\/bootstrap\.sh could not be read \(gh: Bad Gateway \(HTTP 502\)\), so \/kharos:doctor will ask you to paste it again/);
  assert.equal(findSetup(loadSetups(sb.paths), stored.account, 'example/demo', 'main')?.script_sha256, null);
});

test('env-guide: copies the script, opens the page, and prints no value', async () => {
  const sb = sandbox();
  writeConfig(sb);
  const env = tools(sb, {
    git: 'printf "ref: refs/heads/main\\tHEAD\\n%040d\\trefs/heads/main\\n" 1',
    gh: 'case "$*" in *contents/tools/cloud/bootstrap.sh*) echo "echo setup";; */contents/*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; *) echo example/demo;; esac',
    pbcopy: `cat > "${sb.dir}/clip.txt"`,
    'wl-copy': `cat > "${sb.dir}/clip.txt"`,
    open: 'exit 0',
    'xdg-open': 'exit 0',
  });
  const r = await captured(() => main(['env-guide', '--copy', '--open'], env, () => ''));
  assert.equal(r.value, 0, r.stderr);
  assert.match(r.stdout, /cloud environment for example\/demo@main/);
  assert.match(r.stdout, /default environment before you start: none/);
  assert.equal(fs.readFileSync(path.join(sb.dir, 'clip.txt'), 'utf8'), 'echo setup\n');
  assert.match(r.stdout, /----- setup script \(tools\/cloud\/bootstrap\.sh\) -----\necho setup\n----- end of setup script -----/);
  const missing = await captured(() => main(['env-guide', '--repo', 'example/demo', '--revision', 'nope'], env, () => ''));
  assert.equal(missing.value, 1);
  assert.match(missing.stderr, /"nope" is not a branch or tag/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import type { RemoteSettings } from '../src/permissions.ts';
import { assess, isBroadRule, readRules, unifiedDiff } from '../src/settings.ts';
import { HEADS_OK, sandbox, T0, writeConfig } from './helpers.ts';

test('settings: the broad allow rules that auto mode drops are told from narrow ones', () => {
  for (const r of ['Bash', 'Bash(*)', 'PowerShell', 'Bash(* --version)', 'Bash(python*)', 'Bash(python3 *)', 'Bash(node scripts/*)', 'Bash(timeout *)', 'Bash(env:*)', 'Bash(npm run *)', 'Bash(pnpm run test *)', 'Bash(cargo run *)', 'Agent', 'Agent(Explore)', 'Monitor']) {
    assert.ok(isBroadRule(r), r);
  }
  for (const r of ['Bash(npm test)', 'Bash(npm run test)', 'Bash(git status *)', 'Bash(cargo test *)', 'Bash(pytest *)', 'Bash(node --version)', 'Bash(make test *)', 'Read', 'Edit', 'WebFetch']) {
    assert.ok(!isBroadRule(r), r);
  }
});

test('settings: assess names what would hold a session at a prompt', () => {
  const none = readRules({});
  assert.deepEqual(assess(none).map((f) => f.level), ['warn']);
  assert.match(assess(none)[0]!.text, /^no narrow allow rule for Bash: .*3 blocks in a row or 20/);
  const custom = readRules({ permissions: { allow: ['Bash(npm test)'], ask: ['Bash(git push *)', 'WebFetch', 'Edit', 'Write'], defaultMode: 'bypassPermissions' } });
  const found = assess(custom);
  assert.match(found[0]!.text, /^4 ask rule\(s\) \(Bash\(git push \*\), WebFetch, Edit, \.\.\.\) prompt even in auto mode/);
  assert.deepEqual(found.map((f) => f.level), ['warn', 'warn']);
  assert.match(found[1]!.text, /defaultMode "bypassPermissions" is ignored by cloud sessions/);
  // A repository that relies on broad rules gets nothing from them in a cloud session.
  const broad = assess(readRules({ permissions: { allow: ['Bash', 'Bash(npm run *)', 'Read'], defaultMode: 'dontAsk' }, autoMode: { allow: ['x'] } }));
  assert.deepEqual(broad.map((f) => f.level), ['warn', 'warn', 'warn', 'info']);
  assert.match(broad[0]!.text, /^2 broad allow rule\(s\) \(Bash, Bash\(npm run \*\)\) are dropped by auto mode/);
  assert.match(broad[1]!.text, /^no narrow allow rule for Bash/);
  assert.match(broad[2]!.text, /"dontAsk" is ignored/);
  assert.match(broad[3]!.text, /^autoMode settings are not read from a repository/);
  assert.deepEqual(assess(readRules({ permissions: { allow: ['Bash(npm test)'], defaultMode: 'auto' } })).map((f) => f.level), ['info']);
  assert.throws(() => readRules({ permissions: { allow: 'Bash' } }), /permissions\.allow must be a list of strings/);
});

test('settings: the diff is a unified diff with context', () => {
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

function deps(settings: RemoteSettings): DoctorDeps {
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', account: 'sha256:x' }),
    heads: () => HEADS_OK,
    ownerType: () => 'User',
    settings: () => settings,
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    managedPolicy: () => ({ status: 'absent', file: '/home/person/.claude/remote-settings.json' }),
    setupScript: () => ({ status: 'absent' }),
    repoRole: () => 'admin',
  };
}

test('doctor: reports the rules of the launch branch and warns when a launch would likely stall', () => {
  const sb = sandbox();
  writeConfig(sb);
  const check = (s: RemoteSettings) => runDoctor(sb.paths, { now: T0, env: sb.env }, deps(s)).find((c) => c.name === 'demo: permissions');
  const absent = check({ status: 'absent' });
  assert.equal(absent?.level, 'warn');
  assert.match(absent?.detail ?? '', /^example\/demo@main: no settings file; no narrow allow rule for Bash/);
  assert.match(absent?.fix?.[0] ?? '', /^Change \.claude\/settings\.json on main of example\/demo, or let `\/kharos:permissions` answer every prompt/);
  const asks = check({ status: 'found', text: JSON.stringify({ permissions: { allow: ['Bash(npm test)'], ask: ['Bash(git push *)'] } }) });
  assert.equal(asks?.level, 'warn');
  assert.match(asks?.detail ?? '', /^example\/demo@main: 1 allow, 1 ask, 0 deny; 1 ask rule\(s\)/);
  const broad = check({ status: 'found', text: JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'Edit'], defaultMode: 'bypassPermissions' } }) });
  assert.equal(broad?.level, 'warn');
  assert.match(broad?.detail ?? '', /1 broad allow rule\(s\) \(Bash\) are dropped by auto mode.*defaultMode "bypassPermissions" is ignored by cloud sessions/);
  const narrow = check({ status: 'found', text: JSON.stringify({ permissions: { allow: ['Read', 'Bash(npm test)'], deny: ['Bash(rm -rf *)'] } }) });
  assert.equal(narrow?.level, 'ok');
  assert.match(narrow?.detail ?? '', /^example\/demo@main: 2 allow, 0 ask, 1 deny$/);
  assert.equal(check({ status: 'unreadable', error: 'gh is not installed' })?.level, 'info');
  assert.equal(check({ status: 'found', text: '{' })?.level, 'warn');
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps({ status: 'absent' }))), /warn {2}demo: permissions: /);
});

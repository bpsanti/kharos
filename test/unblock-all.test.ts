import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import { loadConfirmation, saveConfirmation } from '../src/org-confirmations.ts';
import { parseManagedPolicy } from '../src/managed-policy.ts';
import { describeUnblockAll, readUnblockAll } from '../src/unblock-all.ts';
import { captured, HEADS_OK, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

const POLICY_JSON = { permissions: { ask: ['Bash(psql:*)', 'Bash(*.rds.amazonaws.com*)'], deny: ['Bash(rm -rf:*)'] } };

async function kharos(sb: Sandbox, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await captured(() => main(argv, sb.env, () => ''));
  return { code: r.value, out: r.stdout, err: r.stderr };
}

const tokenOf = (out: string) => /change ([0-9a-f]{12}):/.exec(out)?.[1] ?? '';

/** A sandbox whose account has managed settings and user settings of its own, both under its Claude config folder. */
function account(policy: unknown = POLICY_JSON, settings: unknown = { model: 'opus', permissions: { defaultMode: 'acceptEdits' } }): Sandbox & { settingsFile: string } {
  const sb = sandbox();
  const conf = path.join(sb.dir, 'claude-config');
  fs.mkdirSync(conf);
  if (policy !== null) fs.writeFileSync(path.join(conf, 'remote-settings.json'), JSON.stringify(policy));
  const settingsFile = path.join(conf, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return { ...sb, env: { ...sb.env, CLAUDE_CONFIG_DIR: conf }, settingsFile };
}

function mode(sb: { settingsFile: string }): unknown {
  return JSON.parse(fs.readFileSync(sb.settingsFile, 'utf8')).permissions?.defaultMode;
}

function switches(sb: Sandbox): boolean[] {
  const c = loadConfig(sb.paths).config;
  return [c.permission_hook, c.preflight_auto, c.permission_unblock];
}

function doctorDeps(sb: Sandbox): DoctorDeps {
  const policyFile = path.join(sb.env.CLAUDE_CONFIG_DIR as string, 'remote-settings.json');
  return {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', account: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    heads: () => HEADS_OK,
    ownerType: () => 'User',
    settings: () => ({ status: 'absent' }),
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    managedPolicy: () => (fs.existsSync(policyFile) ? parseManagedPolicy(fs.readFileSync(policyFile, 'utf8'), policyFile) : { status: 'absent', file: policyFile }),
    repoRole: () => 'admin',
    setupScript: () => ({ status: 'absent' }),
  };
}

test('unblock-all: one show lists everything it frees, one token confirms it, and on turns on the three parts in order', async () => {
  const sb = account();
  writeConfig(sb);
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show');
  assert.equal(shown.code, 0);
  for (const part of [
    /now off: none of the three parts is on/,
    /1\. the unblock preset, confirmed for the organization's managed settings as they are now \(fingerprint [0-9a-f]{16}\): off now; this turns it on/,
    /2\. automatic unblock: .*permission_hook, preflight_auto and permission_unblock/,
    /3\. this account's sessions start in auto mode \(permissions\.defaultMode "auto" in .*settings\.json\): off now; this turns it on/,
    /every permission prompt .* is allowed, of any tool, with no person asked/,
    /the organization's ask rules it answers \(2\)/,
    /Bash\(\*\.rds\.amazonaws\.com\*\) \(Amazon RDS\)/,
    /what stays: the organization's deny rules \(1\)/,
    /a side branch kharos\/<id>/,
    /every session of this Claude account starts in auto mode, not only kharos launches/,
    /-\s+"defaultMode": "acceptEdits"/,
    /\+\s+"defaultMode": "auto"/,
  ]) {
    assert.match(shown.out, part);
  }
  assert.equal(shown.out.match(/^change [0-9a-f]{12}:/gm)?.length, 1, 'one token for all of it');
  assert.match(shown.out, /kharos permissions unblock-all on --expect [0-9a-f]{12}/);
  assert.doesNotMatch(shown.out, /unblock confirm|auto unblock on|account-mode/, 'the separate commands are not suggested');
  assert.deepEqual(switches(sb), [false, false, false], 'show changes nothing');

  const wrong = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', '000000000000');
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /nothing was changed/);
  assert.equal(loadConfirmation(sb.paths, 'unblock'), null);
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'on')).code, 1, 'on needs the token');

  const on = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(shown.out));
  assert.equal(on.code, 0, on.err);
  const lines = on.out.split('\n');
  assert.match(lines[0] ?? '', /^1\. the confirmation of the unblock preset: confirmed the unblock preset .* fingerprint [0-9a-f]{16}/);
  assert.match(lines[1] ?? '', /^2\. automatic unblock: permission_hook, preflight_auto and permission_unblock are on/);
  assert.match(lines[2] ?? '', /^3\. auto mode for the account: wrote .*settings\.json: this account starts its sessions in auto mode.*Undo with `kharos permissions unblock-all show off`/);
  assert.match(on.out, /now on: all three parts/);
  assert.deepEqual(switches(sb), [true, true, true]);
  assert.equal(mode(sb), 'auto');
  assert.notEqual(loadConfirmation(sb.paths, 'unblock'), null);

  // Idempotent: nothing left to change, and running on again changes nothing.
  const again = await kharos(sb, 'permissions', 'unblock-all', 'show');
  assert.match(again.out, /nothing to change: all of it is on/);
  assert.equal(tokenOf(again.out), '');
  const twice = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(shown.out));
  assert.equal(twice.code, 0);
  assert.match(twice.out, /1\. the confirmation of the unblock preset: on already\n2\. automatic unblock: on already\n3\. auto mode for the account: on already/);

  // The doctor says it in one line.
  const report = formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, doctorDeps(sb)));
  assert.equal(report.split('\n').filter((l) => /unblock all|unblock preset:/.test(l)).length, 1, report);
  assert.match(report, /warn  unblock all: on: all three parts/);
});

test('unblock-all: off takes back the three parts, and the switches it found as they were', async () => {
  const sb = account();
  writeConfig(sb, { permission_hook: true });
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf((await kharos(sb, 'permissions', 'unblock-all', 'show')).out))).code, 0);
  assert.deepEqual(switches(sb), [true, true, true]);
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show', 'off');
  assert.match(shown.out, /1\. forgets your confirmation of the unblock preset: set now; this takes it back/);
  assert.match(shown.out, /permission_hook on, preflight_auto off and permission_unblock off, as they were before `kharos permissions unblock-all on`/);
  assert.match(shown.out, /\+\s+"defaultMode": "acceptEdits"/);
  assert.match(shown.out, /kharos permissions unblock-all off --expect [0-9a-f]{12}/);
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'off', '--expect', '000000000000')).code, 1);
  assert.equal(mode(sb), 'auto', 'a wrong token takes nothing back');
  const off = await kharos(sb, 'permissions', 'unblock-all', 'off', '--expect', tokenOf(shown.out));
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /now off: none of the three parts is on/);
  assert.deepEqual(switches(sb), [true, false, false], 'permission_hook stays on, as it was before');
  assert.equal(mode(sb), 'acceptEdits');
  assert.equal(loadConfirmation(sb.paths, 'unblock'), null);
  assert.match((await kharos(sb, 'permissions', 'unblock-all', 'show', 'off')).out, /nothing to take back/);
});

test('unblock-all: off leaves an account that was in auto mode before on as it was', async () => {
  const sb = account(POLICY_JSON, { permissions: { defaultMode: 'auto' } });
  writeConfig(sb);
  const on = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf((await kharos(sb, 'permissions', 'unblock-all', 'show')).out));
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /3\. auto mode for the account: on already/);
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show', 'off');
  assert.match(shown.out, /3\. this account's sessions start as before: not turned on by `kharos permissions unblock-all on`; it stays as it is/);
  const off = await kharos(sb, 'permissions', 'unblock-all', 'off', '--expect', tokenOf(shown.out));
  assert.equal(off.code, 0, off.err);
  assert.equal(mode(sb), 'auto', 'the mode the person set by hand stays');
  assert.deepEqual(switches(sb), [false, false, false]);
  assert.equal(loadConfirmation(sb.paths, 'unblock'), null);
});

test('unblock-all: off leaves permission_unblock and the confirmation that were on before on as they were', async () => {
  const sb = account();
  writeConfig(sb, { permission_unblock: true });
  confirmPreset(sb);
  const on = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf((await kharos(sb, 'permissions', 'unblock-all', 'show')).out));
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /1\. the confirmation of the unblock preset: on already/);
  assert.deepEqual(switches(sb), [true, true, true]);
  const off = await kharos(sb, 'permissions', 'unblock-all', 'off', '--expect', tokenOf((await kharos(sb, 'permissions', 'unblock-all', 'show', 'off')).out));
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /1\. the confirmation of the unblock preset: left as it is/);
  assert.deepEqual(switches(sb), [false, false, true], 'permission_unblock stays on, as it was before');
  assert.notEqual(loadConfirmation(sb.paths, 'unblock'), null, 'the confirmation made before on stays');
  assert.equal(mode(sb), 'acceptEdits');
  assert.match((await kharos(sb, 'permissions', 'unblock-all', 'show', 'off')).out, /nothing to take back/);
});

test('unblock-all: a record left by the first builds of on still reads, and off puts its two switches back', async () => {
  const sb = account();
  writeConfig(sb, { permission_hook: true, preflight_auto: true, permission_unblock: true });
  fs.mkdirSync(sb.paths.state, { recursive: true });
  fs.writeFileSync(path.join(sb.paths.state, 'unblock-all.json'), JSON.stringify({ permission_hook: true, preflight_auto: false }));
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show', 'off');
  assert.equal(shown.code, 0, shown.err);
  const off = await kharos(sb, 'permissions', 'unblock-all', 'off', '--expect', tokenOf(shown.out));
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(switches(sb), [true, false, false]);
  assert.equal(fs.existsSync(path.join(sb.paths.state, 'unblock-all.json')), false);
});

test('unblock-all: each part keeps its own guards; what the organization rules out is listed, skipped and named in the doctor', async () => {
  // Bypass mode disabled: no unblock preset, auto mode still possible.
  const strict = account({ permissions: { ...POLICY_JSON.permissions, disableBypassPermissionsMode: 'disable' } });
  writeConfig(strict);
  const shown = await kharos(strict, 'permissions', 'unblock-all', 'show');
  assert.match(shown.out, /1\. .*: not available here: the organization's managed settings set disableBypassPermissionsMode/);
  assert.match(shown.out, /2\. .*: not available here: /);
  assert.doesNotMatch(shown.out, /What the unblock preset frees/);
  const on = await kharos(strict, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(shown.out));
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /1\. the confirmation of the unblock preset: skipped, not available here/);
  assert.match(on.out, /2\. automatic unblock: skipped, not available here/);
  assert.deepEqual(switches(strict), [false, false, false]);
  assert.equal(mode(strict), 'auto');
  assert.match(on.out, /now partly on: on: auto mode for the account; missing: the confirmation of the unblock preset \(not available: .*disableBypassPermissionsMode/);
  const strictReport = formatChecks(runDoctor(strict.paths, { now: T0, env: strict.env }, doctorDeps(strict)));
  assert.match(strictReport, /warn  unblock all: partly on: on: auto mode for the account; missing: /);
  assert.match(strictReport, /Every part available here is on; `kharos permissions unblock-all show off` shows how to take back/);
  assert.doesNotMatch(strictReport, /turns on the rest/, 'nothing available is left to turn on');

  // Auto mode turned off by the organization: only that part is left out.
  const noAuto = account({ permissions: { ...POLICY_JSON.permissions, disableAutoMode: 'disable' } });
  writeConfig(noAuto);
  const s2 = await kharos(noAuto, 'permissions', 'unblock-all', 'show');
  assert.match(s2.out, /3\. .*: not available here: the organization's managed settings turn auto mode off/);
  assert.equal((await kharos(noAuto, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(s2.out))).code, 0);
  assert.deepEqual(switches(noAuto), [true, true, true]);
  assert.equal(mode(noAuto), 'acceptEdits');
  const byHand = account({ permissions: { ...POLICY_JSON.permissions, disableAutoMode: 'disable' } }, { permissions: { defaultMode: 'auto' } });
  writeConfig(byHand);
  assert.match(formatChecks(runDoctor(byHand.paths, { now: T0, env: byHand.env }, doctorDeps(byHand))), /Ask the organization's administrator about auto mode; if unblock all turned it on, `\/kharos:permissions off` takes back what unblock all turned on/);

  // No copy of the managed settings: never guessed.
  const none = account(null);
  writeConfig(none);
  assert.match((await kharos(none, 'permissions', 'unblock-all', 'show')).out, /1\. .*not available here: there is no copy of the organization's settings for this account/);

  // The confirmation is tied to the fingerprint: managed settings that change after the show refuse its token.
  const moving = account();
  writeConfig(moving);
  const before = await kharos(moving, 'permissions', 'unblock-all', 'show');
  fs.writeFileSync(path.join(moving.env.CLAUDE_CONFIG_DIR as string, 'remote-settings.json'), JSON.stringify({ permissions: { ask: ['Bash(mysql:*)'], deny: [] } }));
  const refused = await kharos(moving, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(before.out));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /the organization's managed settings, the kharos configuration or the account's settings changed/);
  assert.equal(loadConfirmation(moving.paths, 'unblock'), null);

  // A confirmation made for older managed settings is off now, and the show says what changed.
  const policy = parseManagedPolicy(JSON.stringify(POLICY_JSON), 'f');
  if (policy.status !== 'found') throw new Error('test policy');
  saveConfirmation(moving.paths, 'unblock', policy, T0);
  assert.match((await kharos(moving, 'permissions', 'unblock-all', 'show')).out, /1\. .*off now \(the organization's managed settings changed since you confirmed the unblock preset on .*ask rules added: Bash\(mysql:\*\)/);
});

test('unblock-all: a part that fails stops the rest, and the error says which parts are on', async () => {
  const sb = account();
  writeConfig(sb);
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show');
  const dir = path.dirname(sb.settingsFile);
  fs.chmodSync(dir, 0o500);
  try {
    const r = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(shown.out));
    assert.equal(r.code, 1);
    assert.match(r.err, /1\. the confirmation of the unblock preset: confirmed/);
    assert.match(r.err, /2\. automatic unblock: permission_hook, preflight_auto and permission_unblock are on/);
    assert.match(r.err, /3\. auto mode for the account: failed: /);
    assert.match(r.err, /stopped there; the parts after it were not touched\. Now partly on: on: the confirmation of the unblock preset, automatic unblock; missing: auto mode for the account/);
    assert.match(r.err, /`kharos permissions unblock-all show off` to take back what is on/);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.equal(mode(sb), 'acceptEdits');
  // Running it again finishes what is left.
  const rest = await kharos(sb, 'permissions', 'unblock-all', 'show');
  assert.match(rest.out, /1\. .*: on already/);
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(rest.out))).code, 0);
  assert.equal(describeUnblockAll(readUnblockAll(sb.paths, sb.env).parts).overall, 'on');
});

test('unblock-all: only the one command remains, and the doctor says what is on and what is missing', async () => {
  const sb = account();
  writeConfig(sb);
  for (const gone of [['unblock', 'show'], ['auto', 'unblock', 'on'], ['account-mode', 'diff', 'auto'], ['hook', 'enable'], ['show']]) {
    const r = await kharos(sb, 'permissions', ...gone);
    assert.equal(r.code, 1, gone.join(' '));
    assert.match(r.err, /permissions takes unblock-all, preflight or approvals/);
  }
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'bogus')).code, 1);
  // The doctor: off says how to free it; part of it says what is missing.
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, doctorDeps(sb))), /ok {4}unblock all: off: none of the three parts is on; `\/kharos:permissions` frees every prompt/);
  confirmPreset(sb);
  const report = formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, doctorDeps(sb)));
  assert.match(report, /warn  unblock all: partly on: on: the confirmation of the unblock preset; missing: automatic unblock; auto mode for the account/);
  assert.match(report, /`\/kharos:permissions` turns on the rest after you confirm once/);
});

/** The person's confirmation of the unblock preset, for the account's managed settings as they are. */
function confirmPreset(sb: Sandbox): void {
  const policy = parseManagedPolicy(fs.readFileSync(path.join(sb.env.CLAUDE_CONFIG_DIR as string, 'remote-settings.json'), 'utf8'), 'f');
  if (policy.status !== 'found') throw new Error('test policy');
  saveConfirmation(sb.paths, 'unblock', policy, T0);
}

test('unblock-all: with no copy of the managed settings, show says why and the one check, and offers the statement that the account has none in the same confirmation', async () => {
  const sb = account(null);
  writeConfig(sb);
  const policyFile = path.join(sb.env.CLAUDE_CONFIG_DIR as string, 'remote-settings.json');
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /Claude Code keeps no copy of the organization's settings for this account at .*remote-settings\.json: either the account has none, or Claude Code has not downloaded them on this machine/);
  assert.match(shown.out, /Check first: open an interactive Claude Code session with this account/);
  assert.match(shown.out, /say so in this same confirmation instead: kharos then reads them as empty \(0 ask rules, 0 deny rules; fingerprint [0-9a-f]{16}\)/);
  const plain = tokenOf(shown.out);
  const statement = /change ([0-9a-f]{12}), with the statement "this account has no organization settings"/.exec(shown.out)?.[1] ?? '';
  assert.ok(plain && statement && plain !== statement, 'two tokens: without and with the statement');
  assert.match(shown.out, new RegExp(`kharos permissions unblock-all on --no-org-settings --expect ${statement}`));
  const doctorLine = formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, doctorDeps(sb)), { verbose: true });
  assert.match(doctorLine, /info  managed policy: Claude Code keeps no copy .*; open an interactive Claude Code session with this account to check, and if there is still no copy, `kharos permissions unblock-all show` lets you confirm that this account has none/);

  // The token without the statement does not confirm it, nor the other way round: each covers only what it says.
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'on', '--no-org-settings', '--expect', plain)).code, 1);
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', statement)).code, 1);
  assert.equal(loadConfirmation(sb.paths, 'no-org-settings'), null, 'never assumed empty without the statement');

  // With the statement: all three parts, the settings read as empty, and the doctor says so in one line.
  const on = await kharos(sb, 'permissions', 'unblock-all', 'on', '--no-org-settings', '--expect', statement);
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /1\. the confirmation of the unblock preset: confirmed that this account has no organization settings, read as empty while there is no copy at /);
  assert.deepEqual(switches(sb), [true, true, true]);
  assert.equal(mode(sb), 'auto');
  assert.equal(describeUnblockAll(readUnblockAll(sb.paths, sb.env).parts).overall, 'on');
  assert.ok(loadConfirmation(sb.paths, 'no-org-settings')?.no_copy);
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, doctorDeps(sb)), { verbose: true }), /info  managed policy: no copy of organization managed settings at .*; you confirmed on \d{4}-\d\d-\d\d that this account has none, so kharos reads them as empty \(0 ask rules, 0 deny rules\), and asks again if a copy appears/);
  assert.match((await kharos(sb, 'permissions', 'unblock-all', 'show')).out, /The organization's settings: none for this account, as you confirmed on .*nothing to change: all of it is on/s);

  // A copy that appears later, even an empty one, is a change: the preset stops until the person confirms again.
  fs.writeFileSync(policyFile, '{}');
  const again = await kharos(sb, 'permissions', 'unblock-all', 'show');
  assert.match(again.out, /1\. .*off now \(the organization's managed settings changed since you confirmed the unblock preset on .*a copy of the organization's managed settings appeared at .*remote-settings\.json/);
  assert.doesNotMatch(again.out, /--no-org-settings/, 'with a copy, the statement is not offered');
  assert.equal(describeUnblockAll(readUnblockAll(sb.paths, sb.env).parts).overall, 'partly');
  const reconfirmed = await kharos(sb, 'permissions', 'unblock-all', 'on', '--expect', tokenOf(again.out));
  assert.equal(reconfirmed.code, 0, reconfirmed.err);
  assert.equal(loadConfirmation(sb.paths, 'no-org-settings'), null, 'the statement ends once the confirmation is made for a copy');
  assert.equal(describeUnblockAll(readUnblockAll(sb.paths, sb.env).parts).overall, 'on');
});

test('unblock-all: off takes back the statement that the account has no organization settings with the rest', async () => {
  const sb = account(null);
  writeConfig(sb);
  const shown = await kharos(sb, 'permissions', 'unblock-all', 'show');
  const statement = /change ([0-9a-f]{12}), with the statement "this account has no organization settings"/.exec(shown.out)?.[1] ?? '';
  assert.ok(statement);
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'on', '--no-org-settings', '--expect', statement)).code, 0);
  const offShown = await kharos(sb, 'permissions', 'unblock-all', 'show', 'off');
  assert.match(offShown.out, /1\. forgets your confirmation of the unblock preset, and your statement that this account has no organization settings: set now/);
  const off = await kharos(sb, 'permissions', 'unblock-all', 'off', '--expect', tokenOf(offShown.out));
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /forgot your confirmation of the unblock preset, and your statement that this account has no organization settings/);
  assert.equal(loadConfirmation(sb.paths, 'no-org-settings'), null);
  assert.equal(loadConfirmation(sb.paths, 'unblock'), null);
  assert.equal(readUnblockAll(sb.paths, sb.env).policy.status, 'absent');
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'show', '--no-org-settings')).code, 1, 'the statement goes only with on');
  assert.equal((await kharos(sb, 'permissions', 'unblock-all', 'show', 'off', '--no-org-settings')).code, 1, 'the statement goes only with on');
});

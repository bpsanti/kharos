// `kharos permissions unblock-all`: everything kharos can free for this Claude account, in one step, after
// one confirmation. It is three parts, each with the guards it has on its own:
//   1. confirm   the unblock preset, confirmed for the organization's managed settings as they are now
//                (their fingerprint), refused when bypass mode is disabled or no copy of them can be read;
//   2. auto      automatic unblock: the side branch of each launch gets the preset (permission_hook,
//                preflight_auto and permission_unblock in this account's kharos configuration);
//   3. account   this account's sessions start in auto mode (permissions.defaultMode "auto" in its own user
//                settings), unavailable when the organization turns auto mode off.
// `show` says what they free and where each one stands, with the token of that exact change; `on` and `off`
// apply it only with that token, part by part in that order, skip what is on (or off) already, and stop at the
// first part that fails, saying which parts are on then.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_AUTO_CAVEAT, ACCOUNT_AUTO_EFFECT, applyAccountMode, approveAccountMode, autoModeRefusal, planAccountMode, readAccountMode } from './account-mode.ts';
import { CommandError } from './commands.ts';
import { ConfigError, loadConfig, saveConfig, type Config } from './config.ts';
import { isObject, readState, writeJsonAtomic } from './fsutil.ts';
import { hooksBlocked, mirrorRefusal, readManagedPolicy, type ManagedPolicy } from './managed-policy.ts';
import { confirmationState, describeConfirmation, forgetConfirmation, loadConfirmation, policyFingerprint, saveConfirmation } from './org-confirmations.ts';
import { unblockOpens } from './permission-hook.ts';
import { unifiedDiff } from './permission-profiles.ts';
import type { Paths } from './paths.ts';

export type PartId = 'confirm' | 'auto' | 'account';
export type UnblockTarget = 'on' | 'off';

export const UNBLOCK_ALL_SHOW = 'kharos permissions unblock-all show';
export const UNBLOCK_ALL_UNDO = 'kharos permissions unblock-all show off';
/** The short command a person types in Claude Code. */
export const UNBLOCK_ALL_SKILL = '/kharos:permissions unblock-all';

export interface Part {
  id: PartId;
  title: string;
  /** In effect as set now: the confirmation matches, the three switches are on, the account starts in auto mode. */
  on: boolean;
  /** Something of it is set, which `off` takes back. */
  set: boolean;
  /** Why it cannot be on here, or null. */
  unavailable: string | null;
  /** Why it is off although it was set, such as managed settings that changed since the confirmation. */
  note: string | null;
}

const TITLE: Record<PartId, string> = {
  confirm: "the unblock preset, confirmed for the organization's managed settings as they are now",
  auto: 'automatic unblock: the side branch of each launch gets the unblock preset',
  account: "this account's sessions start in auto mode",
};

const SHORT: Record<PartId, string> = { confirm: 'the confirmation of the unblock preset', auto: 'automatic unblock', account: 'auto mode for the account' };

export interface UnblockAllState {
  policy: ManagedPolicy;
  config: Config;
  /** The account's user settings file, where auto mode is set. */
  accountFile: string;
  parts: Part[];
}

/** What `unblock-all on` changed in the configuration besides permission_unblock, so `off` puts it back. */
interface Before {
  permission_hook: boolean;
  preflight_auto: boolean;
}

function beforePath(paths: Paths): string {
  return path.join(paths.state, 'unblock-all.json');
}

function readBefore(paths: Paths): Before | null {
  return (
    readState<Before>(beforePath(paths), (v) => isObject(v) && typeof v.permission_hook === 'boolean' && typeof v.preflight_auto === 'boolean', 'the configuration before unblock-all on') ?? null
  );
}

/** Why the unblock preset is not available under this policy, or null. */
function presetRefusal(policy: ManagedPolicy): string | null {
  const refusal = mirrorRefusal(policy)?.replace(/^(mirroring is unavailable|refused): /, '') ?? null;
  return refusal ?? hooksBlocked(policy) ?? (policy.status === 'found' ? null : "the organization's managed settings cannot be read");
}

/** This account's kharos configuration, the defaults while it has none yet: the switches are written to it then. */
function loadedConfig(paths: Paths): Config {
  try {
    return loadConfig(paths).config;
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
}

/** Where each of the three parts stands for this account now. */
export function readUnblockAll(paths: Paths, env: NodeJS.ProcessEnv, policy: ManagedPolicy = readManagedPolicy(env), config: Config = loadedConfig(paths)): UnblockAllState {
  const preset = presetRefusal(policy);
  const saved = loadConfirmation(paths, 'unblock');
  const confirmed = confirmationState(saved, policy);
  const auto = config.permission_hook && config.preflight_auto && config.permission_unblock;
  const acct = readAccountMode(env);
  const acctAuto = !('error' in acct) && acct.mode === 'auto';
  const parts: Part[] = [
    {
      id: 'confirm',
      title: TITLE.confirm,
      on: confirmed.state === 'valid',
      set: saved !== null,
      unavailable: preset,
      note: confirmed.state === 'changed' ? describeConfirmation(confirmed, 'unblock') : null,
    },
    {
      id: 'auto',
      title: TITLE.auto,
      on: auto,
      set: config.permission_unblock || readBefore(paths) !== null,
      unavailable: preset,
      note: config.permission_unblock && !auto ? 'permission_unblock is on, but it does nothing until permission_hook and preflight_auto are on too' : null,
    },
    {
      id: 'account',
      title: TITLE.account,
      on: acctAuto,
      set: acctAuto,
      unavailable: autoModeRefusal(policy) ?? ('error' in acct ? `${acct.file} cannot be read (${acct.error})` : null),
      note: null,
    },
  ];
  return { policy, config, accountFile: acct.file, parts };
}

export type Overall = 'on' | 'partly' | 'off';

/** All on, partly on, or off, in one line that names what is missing and why. */
export function describeUnblockAll(parts: readonly Part[]): { overall: Overall; text: string } {
  const working = parts.filter((p) => p.on && !p.unavailable);
  if (working.length === parts.length) return { overall: 'on', text: 'on: all three parts (the unblock preset confirmed, automatic unblock, auto mode for the account)' };
  const inert = parts.filter((p) => p.on && p.unavailable);
  const missing = parts.filter((p) => !p.on);
  const why = (p: Part) => (p.unavailable ? ` (not available: ${p.unavailable})` : p.note ? ` (${p.note})` : '');
  if (working.length === 0 && inert.length === 0) {
    const out = missing.filter((p) => p.unavailable);
    return { overall: 'off', text: `off: none of the three parts is on${out.length ? `; not available here: ${out.map((p) => `${SHORT[p.id]} (${p.unavailable})`).join('; ')}` : ''}` };
  }
  return {
    overall: 'partly',
    text: [
      `partly on: on: ${working.map((p) => SHORT[p.id]).join(', ') || 'nothing in effect'}`,
      ...(inert.length ? [`set but without effect: ${inert.map((p) => `${SHORT[p.id]}${why(p)}`).join('; ')}`] : []),
      ...(missing.length ? [`missing: ${missing.map((p) => `${SHORT[p.id]}${why(p)}`).join('; ')}`] : []),
    ].join('; '),
  };
}

interface Plan {
  target: UnblockTarget;
  state: UnblockAllState;
  /** The parts this change turns on (or takes back), in order. */
  todo: PartId[];
  account: { file: string; before: string | null; after: string; token: string; summary: string } | null;
  /** Why the account part cannot be taken back here, for off. */
  accountProblem: string | null;
  before: Before | null;
  token: string | null;
}

function token(fields: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12);
}

function plan(paths: Paths, env: NodeJS.ProcessEnv, target: UnblockTarget, policy: ManagedPolicy): Plan {
  const state = readUnblockAll(paths, env, policy);
  const { config, parts } = state;
  const before = readBefore(paths);
  let todo: PartId[];
  let account: Plan['account'] = null;
  let accountProblem: string | null = null;
  if (target === 'on') {
    todo = parts.filter((p) => !p.on && !p.unavailable).map((p) => p.id);
    if (todo.includes('account')) {
      const a = planAccountMode(paths, env, 'auto', policy);
      if (a.after && a.token) account = { file: a.file, before: a.before, after: a.after, token: a.token, summary: a.summary };
    }
  } else {
    todo = parts.filter((p) => p.set).map((p) => p.id);
    if (todo.includes('account')) {
      try {
        const a = planAccountMode(paths, env, 'off', policy);
        if (a.after !== null && a.token) account = { file: a.file, before: a.before, after: a.after, token: a.token, summary: a.summary };
      } catch (err) {
        if (!(err instanceof CommandError)) throw err;
        accountProblem = err.message;
        todo = todo.filter((id) => id !== 'account');
      }
    }
  }
  const t = todo.length
    ? token({
        target,
        todo,
        fingerprint: policy.status === 'found' ? policyFingerprint(policy) : null,
        account: account?.token ?? null,
        config: [config.permission_hook, config.preflight_auto, config.permission_unblock],
        before,
      })
    : null;
  return { target, state, todo, account, accountProblem, before, token: t };
}

function stateWord(p: Part, todo: readonly PartId[], target: UnblockTarget): string {
  if (target === 'on') {
    if (p.on && p.unavailable) return `set, but without effect: ${p.unavailable}`;
    if (p.on) return 'on already';
    if (p.unavailable) return `not available here: ${p.unavailable}; it stays off`;
    return `off now${p.note ? ` (${p.note})` : ''}; this turns it on`;
  }
  return todo.includes(p.id) ? 'set now; this takes it back' : 'off already';
}

function onLines(p: Plan, paths: Paths): string[] {
  const { policy, parts } = p.state;
  const [confirm, auto, account] = parts as [Part, Part, Part];
  const fp = policy.status === 'found' ? ` (fingerprint ${policyFingerprint(policy)})` : '';
  const lines = [
    `kharos permissions unblock-all: frees every permission prompt kharos can free for this Claude account, in one step, after you confirm once.`,
    `now ${describeUnblockAll(parts).text}`,
    'In this order:',
    `  1. ${confirm.title}${fp}: ${stateWord(confirm, p.todo, 'on')}`,
    `  2. ${auto.title} (permission_hook, preflight_auto and permission_unblock in ${paths.config}): ${stateWord(auto, p.todo, 'on')}`,
    `  3. ${account.title} (permissions.defaultMode "auto" in ${p.state.accountFile}): ${stateWord(account, p.todo, 'on')}`,
  ];
  if (p.todo.includes('confirm') || p.todo.includes('auto')) {
    lines.push(
      'What the unblock preset frees, in every cloud session kharos launches:',
      ...unblockOpens(policy).map((l) => `  ${l}`),
      "  at each launch kharos writes the preset to a side branch kharos/<id>, made from the branch the profile launches from, and the session starts there; that branch never changes, and /kharos:close deletes the side branch",
      "  when the organization's managed settings change, kharos stops applying the preset until you confirm again, with this same command",
    );
  }
  if (p.todo.includes('account')) {
    lines.push(`What auto mode for the account frees: ${ACCOUNT_AUTO_EFFECT}; launches need no approval prompt, ${ACCOUNT_AUTO_CAVEAT}.`);
    if (p.account) lines.push(`The change to ${p.account.file}:`, unifiedDiff(p.account.before, p.account.after, path.basename(p.account.file)));
  }
  return lines;
}

function offLines(p: Plan, paths: Paths): string[] {
  const [confirm, auto, account] = p.state.parts as [Part, Part, Part];
  const b = p.before;
  const restore = b
    ? `permission_hook back to ${b.permission_hook ? 'on' : 'off'} and preflight_auto back to ${b.preflight_auto ? 'on' : 'off'}, as they were before \`kharos permissions unblock-all on\``
    : 'permission_hook and preflight_auto stay as they are';
  const lines = [
    'kharos permissions unblock-all off: takes back all of what `kharos permissions unblock-all on` frees, in this order:',
    `  1. forgets your confirmation of the unblock preset: ${stateWord(confirm, p.todo, 'off')}`,
    `  2. turns automatic unblock off (permission_unblock off in ${paths.config}; ${restore}): ${stateWord(auto, p.todo, 'off')}`,
    `  3. this account's sessions start as before: ${p.accountProblem ? `cannot be taken back here: ${p.accountProblem}` : stateWord(account, p.todo, 'off')}`,
    'Afterwards cloud sessions wait at permission prompts until a person answers them, and each launch asks for your approval again.',
    'A branch that has the unblock preset committed in its own kharos permission hook keeps it until it is removed there; /kharos:doctor names such a branch.',
  ];
  if (p.account) lines.push(p.account.summary, unifiedDiff(p.account.before, p.account.after, path.basename(p.account.file)));
  return lines;
}

/** What `on` (or `off`) would change, every part of it in plain words, and the token of that exact change. */
export function showUnblockAll(paths: Paths, env: NodeJS.ProcessEnv, target: UnblockTarget, policy: ManagedPolicy = readManagedPolicy(env)): string {
  return preview(paths, env, target, policy).text;
}

/** The text of `show`, with the token it names (null when there is nothing to change) and where each part stands. */
export function preview(paths: Paths, env: NodeJS.ProcessEnv, target: UnblockTarget, policy: ManagedPolicy = readManagedPolicy(env)): { text: string; token: string | null; parts: Part[] } {
  const p = plan(paths, env, target, policy);
  const lines = target === 'on' ? onLines(p, paths) : offLines(p, paths);
  if (!p.token) {
    if (target === 'off') lines.push('nothing to take back.');
    else if (describeUnblockAll(p.state.parts).overall === 'on') lines.push(`nothing to change: all of it is on. \`${UNBLOCK_ALL_UNDO}\` shows how to take it back.`);
    else lines.push(`nothing to change: every part that is available here is on already. \`${UNBLOCK_ALL_UNDO}\` shows how to take it back.`);
  } else {
    lines.push(
      target === 'on'
        ? `change ${p.token}: nothing changes until the person confirms all of the above, once; then run \`kharos permissions unblock-all on --expect ${p.token}\`. \`${UNBLOCK_ALL_UNDO}\` shows how to take all of it back.`
        : `change ${p.token}: nothing changes until the person confirms it; then run \`kharos permissions unblock-all off --expect ${p.token}\`.`,
    );
  }
  return { text: lines.join('\n'), token: p.token, parts: p.state.parts };
}

/** The token a `show` printed, checked against everything as it is now; throws, having changed nothing, when it no longer matches. */
export function approveUnblockAll(paths: Paths, env: NodeJS.ProcessEnv, target: UnblockTarget, expect: string | undefined, policy: ManagedPolicy = readManagedPolicy(env)): Plan {
  if (!expect) throw new CommandError(`--expect needs the change token that \`kharos permissions unblock-all show${target === 'off' ? ' off' : ''}\` printed, so only what the person confirmed changes`);
  const p = plan(paths, env, target, policy);
  if (p.token !== null && p.token !== expect) {
    throw new CommandError(
      `this is not what that token was made from (the organization's managed settings, the kharos configuration or the account's settings changed, or the token was for another change); nothing was changed. Run \`kharos permissions unblock-all show${target === 'off' ? ' off' : ''}\` again.`,
    );
  }
  return p;
}

/** Turns on, or takes back, every part in order; each part that fails stops the rest, and the error says which parts are on. */
export function applyUnblockAll(paths: Paths, env: NodeJS.ProcessEnv, target: UnblockTarget, expect: string | undefined, now: number, policy: ManagedPolicy = readManagedPolicy(env)): string {
  const p = approveUnblockAll(paths, env, target, expect, policy);
  const out: string[] = [];
  const steps: Record<PartId, () => string> =
    target === 'on'
      ? {
          confirm: () => {
            if (p.state.policy.status !== 'found') throw new CommandError("the organization's managed settings cannot be read");
            const c = saveConfirmation(paths, 'unblock', p.state.policy, now);
            return `confirmed the unblock preset for the organization's managed settings with fingerprint ${c.fingerprint}; kharos asks again when they change`;
          },
          auto: () => {
            const c = loadedConfig(paths);
            if (!readBefore(paths)) writeJsonAtomic(beforePath(paths), { permission_hook: c.permission_hook, preflight_auto: c.preflight_auto } satisfies Before);
            saveConfig(paths, { ...c, permission_hook: true, preflight_auto: true, permission_unblock: true });
            return `permission_hook, preflight_auto and permission_unblock are on in ${paths.config}: each launch gets the unblock preset on a side branch kharos/<id>, while your confirmation matches the organization's managed settings`;
          },
          account: () => applyAccountMode(paths, env, approveAccountMode(paths, env, 'auto', p.account?.token, p.state.policy), `\`${UNBLOCK_ALL_UNDO}\``),
        }
      : {
          confirm: () => (forgetConfirmation(paths, 'unblock') ? 'forgot your confirmation of the unblock preset' : 'no confirmation of the unblock preset was remembered'),
          auto: () => {
            const c = loadedConfig(paths);
            const b = readBefore(paths);
            saveConfig(paths, { ...c, permission_unblock: false, ...(b ? { permission_hook: b.permission_hook, preflight_auto: b.preflight_auto } : {}) });
            fs.rmSync(beforePath(paths), { force: true });
            return `permission_unblock is off in ${paths.config}${b ? `; permission_hook is ${b.permission_hook ? 'on' : 'off'} and preflight_auto is ${b.preflight_auto ? 'on' : 'off'} again, as before` : ''}`;
          },
          account: () => applyAccountMode(paths, env, approveAccountMode(paths, env, 'off', p.account?.token, p.state.policy), `\`${UNBLOCK_ALL_UNDO}\``),
        };
  const parts = p.state.parts;
  for (const [i, part] of parts.entries()) {
    const n = `${i + 1}. ${SHORT[part.id]}`;
    if (!p.todo.includes(part.id)) {
      if (target === 'off' && part.id === 'account' && p.accountProblem) out.push(`${n}: not taken back: ${p.accountProblem}`);
      else if (target === 'on' && part.unavailable && !part.on) out.push(`${n}: skipped, not available here: ${part.unavailable}`);
      else out.push(`${n}: ${target === 'on' ? 'on already' : 'off already'}`);
      continue;
    }
    try {
      out.push(`${n}: ${steps[part.id]()}`);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      const now2 = describeUnblockAll(readUnblockAll(paths, env, policy).parts).text;
      throw new CommandError(
        [
          ...out,
          `${n}: failed: ${(err as Error).message}`,
          `stopped there; the parts after it were not touched. Now ${now2}.`,
          `Fix what failed, then run \`kharos permissions unblock-all show${target === 'off' ? ' off' : ''}\` again${target === 'on' ? `, or \`${UNBLOCK_ALL_UNDO}\` to take back what is on` : ''}.`,
        ].join('\n'),
      );
    }
  }
  if (p.todo.length === 0) out.push(target === 'on' ? 'nothing to change.' : 'nothing to take back.');
  const after = describeUnblockAll(readUnblockAll(paths, env, policy).parts).text;
  out.push(`now ${after}.`);
  if (target === 'on') out.push(`\`kharos permissions approvals\` lists what the preset allowed; \`${UNBLOCK_ALL_UNDO}\` shows how to take all of it back.`);
  return out.join('\n');
}

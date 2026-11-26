// The permission mode this Claude account starts its sessions in, from its own user settings
// (CLAUDE_CONFIG_DIR/settings.json, ~/.claude/settings.json by default). Only `permissions.defaultMode`
// changes, only to "auto" or back to what it was, and only through a diff the person approved: in auto
// mode Claude Code's classifier reviews each kharos launch instead of an approval prompt, in this account's
// interactive and headless sessions alike, and every other session of the account starts in auto mode too.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError } from './commands.ts';
import { isObject, readState, writeJsonAtomic } from './fsutil.ts';
import type { ManagedPolicy } from './managed-policy.ts';
import type { Paths } from './paths.ts';
import { changeToken, renderSettings } from './settings.ts';

export type AccountTarget = 'auto' | 'off';

export function userSettingsFile(env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

export type AccountMode = { file: string; text: string | null; settings: Record<string, unknown>; mode: string | null } | { file: string; error: string };

/** The account's user settings and the mode its sessions start in; an error when the file cannot be read as JSON. */
export function readAccountMode(env: NodeJS.ProcessEnv): AccountMode {
  const file = userSettingsFile(env);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { file, error: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  }
  if (text === null || text.trim() === '') return { file, text, settings: {}, mode: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return { file, error: `not valid JSON (${(err as Error).message})` };
  }
  if (!isObject(v)) return { file, error: 'it does not hold a JSON object' };
  const perms = v.permissions;
  if (perms !== undefined && !isObject(perms)) return { file, error: '"permissions" is not an object' };
  const mode = perms && typeof perms.defaultMode === 'string' ? perms.defaultMode : null;
  return { file, text, settings: v, mode };
}

/** Why this account cannot start its sessions in auto mode, or null when it can. */
export function autoModeRefusal(policy: ManagedPolicy): string | null {
  if (policy.status === 'found' && policy.autoModeDisabled) return "the organization's managed settings turn auto mode off (permissions.disableAutoMode)";
  return null;
}

/** Claude Code lets a folder's project and local settings override the account's mode. */
export const ACCOUNT_AUTO_CAVEAT = 'unless the folder you launch from sets another permissions.defaultMode in its .claude/settings.json or .claude/settings.local.json';

export const ACCOUNT_AUTO_EFFECT =
  "every session of this Claude account starts in auto mode, not only kharos launches: Claude Code's classifier decides each action that no rule settles instead of asking you, and blocks what it judges risky";

interface Previous {
  file: string;
  /** The defaultMode before kharos set "auto"; null when there was none. */
  mode: string | null;
}

function statePath(paths: Paths): string {
  return path.join(paths.state, 'account-mode.json');
}

function previous(paths: Paths): Previous | null {
  return readState<Previous>(statePath(paths), (v) => isObject(v) && typeof v.file === 'string', 'a kharos account mode record') ?? null;
}

export interface Plan {
  file: string;
  before: string | null;
  after: string | null;
  token: string | null;
  summary: string;
}

/** The change to the account's user settings that `target` needs; `after` is null when there is nothing to change. Throws when it is not available. */
export function planAccountMode(paths: Paths, env: NodeJS.ProcessEnv, target: AccountTarget, policy: ManagedPolicy): Plan {
  const cur = readAccountMode(env);
  if ('error' in cur) throw new CommandError(`${cur.file} cannot be read (${cur.error}); kharos does not edit it`);
  if (target === 'auto') {
    const refusal = autoModeRefusal(policy);
    if (refusal) throw new CommandError(`not available: ${refusal}`);
    if (cur.mode === 'auto') return { file: cur.file, before: cur.text, after: null, token: null, summary: `${cur.file} already starts this account's sessions in auto mode; nothing to change.` };
  } else if (cur.mode !== 'auto') {
    return { file: cur.file, before: cur.text, after: null, token: null, summary: `${cur.file} does not set auto mode (defaultMode ${cur.mode ?? 'not set'}); nothing to change.` };
  }
  const restore = target === 'off' ? (previous(paths)?.mode ?? null) : 'auto';
  const settings = structuredClone(cur.settings);
  const perms = isObject(settings.permissions) ? settings.permissions : {};
  if (restore === null) delete perms.defaultMode;
  else perms.defaultMode = restore;
  if (Object.keys(perms).length) settings.permissions = perms;
  else delete settings.permissions;
  const after = renderSettings(settings, cur.text);
  const summary =
    target === 'auto'
      ? `${cur.file}: permissions.defaultMode from ${cur.mode ?? 'not set'} to "auto". Effect: ${ACCOUNT_AUTO_EFFECT}.`
      : `${cur.file}: permissions.defaultMode from "auto" back to ${restore ?? 'not set'}; each kharos launch asks for your approval again.`;
  return { file: cur.file, before: cur.text, after, token: changeToken(cur.text, after), summary };
}

export interface ApprovedChange {
  target: AccountTarget;
  plan: Plan;
}

/** The change an approved diff names, checked against the file as it is now; throws, having written nothing, when it no longer matches. */
export function approveAccountMode(paths: Paths, env: NodeJS.ProcessEnv, target: AccountTarget, expect: string | undefined, policy: ManagedPolicy): ApprovedChange {
  if (!expect) throw new CommandError('the change to the account mode needs the token of the diff the person approved, so only an approved diff is written');
  const p = planAccountMode(paths, env, target, policy);
  if (p.after && p.token !== expect) throw new CommandError(`${p.file} is not what that diff was made from (the file changed, or the diff was for another change); nothing was written. Show the diff again.`);
  return { target, plan: p };
}

export function applyAccountMode(paths: Paths, env: NodeJS.ProcessEnv, { target, plan: p }: ApprovedChange, undo: string): string {
  if (!p.after) return p.summary;
  if (target === 'auto') {
    const cur = readAccountMode(env);
    writeJsonAtomic(statePath(paths), { file: p.file, mode: 'error' in cur ? null : cur.mode } satisfies Previous);
  }
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  const tmp = `${p.file}.kharos-${process.pid}.tmp`;
  fs.writeFileSync(tmp, p.after, { mode: p.before === null ? 0o600 : fs.statSync(p.file).mode & 0o777 });
  fs.renameSync(tmp, p.file);
  return target === 'auto'
    ? `wrote ${p.file}: this account starts its sessions in auto mode from the next session on, ${ACCOUNT_AUTO_CAVEAT}. Undo with ${undo}.`
    : `wrote ${p.file}: this account's sessions start as before; each kharos launch asks for your approval again.`;
}

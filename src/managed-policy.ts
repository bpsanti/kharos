// The organization's server-managed settings, as Claude Code caches them on this machine. Claude Code
// fetches them at startup and keeps a copy in ~/.claude/remote-settings.json (server-managed settings
// docs); a cloud session gets the same settings from Anthropic's servers when it starts.
// kharos reads only the permission rules, whether bypass mode or auto mode is disabled and whether only
// managed hooks run, never any other key, and never writes the file. With no readable copy, nothing is guessed: what depends on it is unavailable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { broadRuleWhy } from '../cloud/kharos-permission.mjs';

export type ManagedPolicy =
  | { status: 'found'; file: string; ask: string[]; deny: string[]; bypassDisabled: boolean; managedHooksOnly: boolean; autoModeDisabled?: boolean }
  | { status: 'absent'; file: string }
  | { status: 'unreadable'; file: string; error: string };

export function managedPolicyFile(env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(dir, 'remote-settings.json');
}

function rules(v: unknown): string[] | null {
  if (v === undefined) return [];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** A restricting key counts as set for any value but an absent or false one, so a value kharos does not know never reads as permissive. */
function disabled(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

export function parseManagedPolicy(text: string, file: string): ManagedPolicy {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return { status: 'unreadable', file, error: `invalid JSON (${(err as Error).message})` };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { status: 'unreadable', file, error: 'it does not hold a JSON object' };
  const o = v as Record<string, unknown>;
  const p = o.permissions === undefined ? {} : o.permissions;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { status: 'unreadable', file, error: '"permissions" is not an object' };
  const perms = p as Record<string, unknown>;
  const ask = rules(perms.ask);
  const deny = rules(perms.deny);
  if (ask === null || deny === null) return { status: 'unreadable', file, error: 'permissions.ask or permissions.deny is not a list of strings' };
  return {
    status: 'found',
    file,
    ask,
    deny,
    bypassDisabled: disabled(perms.disableBypassPermissionsMode) || disabled(o.disableBypassPermissionsMode),
    managedHooksOnly: disabled(o.allowManagedHooksOnly),
    autoModeDisabled: disabled(perms.disableAutoMode),
  };
}

export function readManagedPolicy(env: NodeJS.ProcessEnv): ManagedPolicy {
  const file = managedPolicyFile(env);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'absent', file };
    return { status: 'unreadable', file, error: code ?? (err as Error).message };
  }
  return parseManagedPolicy(text, file);
}

/** Why a managed policy cannot be mirrored, or null when it can. */
export function mirrorRefusal(policy: ManagedPolicy): string | null {
  if (policy.status === 'absent') {
    return `mirroring is unavailable: there is no copy of the organization's managed settings at ${policy.file} (this account has none, or Claude Code has not fetched them on this machine yet); kharos never guesses them`;
  }
  if (policy.status === 'unreadable') return `mirroring is unavailable: ${policy.file} cannot be read (${policy.error}); kharos never guesses the organization's rules`;
  if (policy.bypassDisabled) {
    return (
      "refused: the organization's managed settings set disableBypassPermissionsMode, so its ask rules bind every session, including the ones on your machine; " +
      'kharos does not turn them into an allow. Ask the organization\'s administrator to narrow the rules instead.'
    );
  }
  return null;
}

/** Why mirrored rules must go: the organization disabled bypass mode after they were mirrored. Null while they may stay. */
export function staleMirror(policy: ManagedPolicy, mirror: readonly string[]): string | null {
  if (policy.status !== 'found' || !policy.bypassDisabled || mirror.length === 0) return null;
  return (
    `the hook mirrors ${mirror.length} organization ask rule(s), but the organization's managed settings now set disableBypassPermissionsMode, so those rules bind every session; ` +
    'take them out of the branch\'s .claude/kharos-permissions.json, or remove the hook from the branch'
  );
}

/** Why no repository hook runs under this policy, or null when repository hooks run. */
export function hooksBlocked(policy: ManagedPolicy): string | null {
  if (policy.status !== 'found' || !policy.managedHooksOnly) return null;
  return "the organization's managed settings set allowManagedHooksOnly, so Claude Code runs no repository hook and the kharos permission hook never answers a prompt";
}

export interface MirrorPlan {
  /** Ask rules that become a cloud-only allow. */
  converted: string[];
  /** The converted rules that are broad: they allow any command they cover. */
  broad: string[];
  /** Ask rules that stay as they are, each with why; `broad` marks the ones a mirror of broad rules converts. */
  kept: { rule: string; why: string; broad?: true }[];
}

/**
 * Which managed ask rules can become a cloud-only allow: Bash rules that name their program. A rule
 * for every command, for a program it does not name, or for a shell, an interpreter or a wrapper, would
 * allow anything, so it stays a prompt unless the person asked for broad rules; so does any rule for
 * another tool, always. Deny rules are not part of this at all.
 */
export function planMirror(ask: readonly string[], allowBroad = false): MirrorPlan {
  const converted: string[] = [];
  const broad: string[] = [];
  const kept: { rule: string; why: string; broad?: true }[] = [];
  for (const rule of ask) {
    if (rule !== 'Bash' && !/^Bash\(.+\)$/s.test(rule)) {
      kept.push({ rule, why: 'only Bash rules are mirrored' });
      continue;
    }
    const why = broadRuleWhy(rule);
    if (why !== null && !allowBroad) {
      kept.push({ rule, why, broad: true });
      continue;
    }
    converted.push(rule);
    if (why !== null) broad.push(rule);
  }
  return { converted, broad, kept };
}

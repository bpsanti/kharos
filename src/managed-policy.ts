// The organization's server-managed settings, as Claude Code caches them on this machine. Claude Code
// fetches them at startup and keeps a copy in ~/.claude/remote-settings.json (server-managed settings
// docs); a cloud session gets the same settings from Anthropic's servers when it starts.
// kharos reads only the permission rules and whether bypass mode is disabled, never any other key, and
// never writes the file. With no readable copy, nothing is guessed: what depends on it is unavailable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runsOtherCommands } from '../cloud/kharos-permission.mjs';

export type ManagedPolicy =
  | { status: 'found'; file: string; ask: string[]; deny: string[]; bypassDisabled: boolean }
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

/** Bypass mode counts as disabled for any value but an absent or false one, so a value kharos does not know never reads as allowed. */
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
  return { status: 'found', file, ask, deny, bypassDisabled: disabled(perms.disableBypassPermissionsMode) || disabled(o.disableBypassPermissionsMode) };
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

export interface MirrorPlan {
  /** Ask rules that become a cloud-only allow. */
  converted: string[];
  /** Ask rules that stay as they are, each with why. */
  kept: { rule: string; why: string }[];
}

/**
 * Which managed ask rules can become a cloud-only allow: Bash rules that name what they cover. A rule
 * for every command, or for a shell, an interpreter or a wrapper, would allow anything, so it stays a
 * prompt; so does any rule for another tool. Deny rules are not part of this at all.
 */
export function planMirror(ask: readonly string[]): MirrorPlan {
  const converted: string[] = [];
  const kept: { rule: string; why: string }[] = [];
  for (const rule of ask) {
    const m = /^Bash\((.*)\)$/s.exec(rule);
    if (!m) {
      kept.push({ rule, why: rule === 'Bash' ? 'it covers every command' : 'only Bash rules are mirrored' });
      continue;
    }
    const body = (m[1] as string).trim();
    if (body.replace(/[*:\s]/g, '') === '') {
      kept.push({ rule, why: 'it covers every command' });
      continue;
    }
    const program = body.split(/[\s:]/)[0] as string;
    if (!program.includes('*') && runsOtherCommands(program)) {
      kept.push({ rule, why: `${program} runs other commands, so an allow would cover anything` });
      continue;
    }
    converted.push(rule);
  }
  return { converted, kept };
}

// The person's confirmations about the organization's rules, remembered so that each is asked once:
//   mirror   the organization's ask rules may be mirrored (narrow ones, or broad ones with --broad);
//   unblock  the unblock preset may allow every permission prompt in cloud sessions.
// Each is stored with a fingerprint of what the organization's managed settings said then (the ask
// rules, the deny rules and disableBypassPermissionsMode), and holds only while they still say the
// same. When the fingerprint changes, kharos shows what changed and asks again.
// A confirmation replaces only the repeated question; every other safeguard stays: kharos refuses when
// bypass mode is disabled, and deny rules are never touched.

import crypto from 'node:crypto';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { ManagedPolicy } from './managed-policy.ts';
import type { Paths } from './paths.ts';

export type ConfirmationKind = 'mirror' | 'unblock';

export interface Confirmation {
  fingerprint: string;
  confirmed_at: string;
  /** What the organization's managed settings said when the person confirmed, to show what changed. */
  ask: string[];
  deny: string[];
  bypass_disabled: boolean;
  /** For mirror: the person confirmed broad rules too (--broad). The unblock preset always covers them. */
  broad?: boolean;
}

type FoundPolicy = Extract<ManagedPolicy, { status: 'found' }>;

export function policyFingerprint(p: { ask: readonly string[]; deny: readonly string[]; bypassDisabled: boolean }): string {
  const canon = JSON.stringify({ ask: [...p.ask].sort(), deny: [...p.deny].sort(), bypass_disabled: p.bypassDisabled });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

type Book = Partial<Record<ConfirmationKind, Confirmation>>;

function one(v: unknown): boolean {
  return isObject(v) && typeof v.fingerprint === 'string' && typeof v.confirmed_at === 'string' && Array.isArray(v.ask) && Array.isArray(v.deny);
}

function loadBook(paths: Paths): Book {
  const valid = (v: unknown) => isObject(v) && Object.values(v).every(one);
  return readState<Book>(paths.confirmations, valid, 'confirmations by kind (fingerprint, confirmed_at, ask, deny)') ?? {};
}

export function loadConfirmation(paths: Paths, kind: ConfirmationKind): Confirmation | null {
  return loadBook(paths)[kind] ?? null;
}

export function saveConfirmation(paths: Paths, kind: ConfirmationKind, policy: FoundPolicy, now: number, broad = false): Confirmation {
  const c: Confirmation = {
    fingerprint: policyFingerprint(policy),
    confirmed_at: new Date(now).toISOString(),
    ask: [...policy.ask],
    deny: [...policy.deny],
    bypass_disabled: policy.bypassDisabled,
    ...(broad ? { broad: true } : {}),
  };
  withLock(paths.confirmations, () => writeJsonAtomic(paths.confirmations, { ...loadBook(paths), [kind]: c }));
  return c;
}

/** Forgets one remembered confirmation; true when there was one. */
export function forgetConfirmation(paths: Paths, kind: ConfirmationKind): boolean {
  return withLock(paths.confirmations, () => {
    const book = loadBook(paths);
    if (!book[kind]) return false;
    delete book[kind];
    writeJsonAtomic(paths.confirmations, book);
    return true;
  });
}

export type ConfirmationState ={ state: 'none' } | { state: 'valid'; at: string } | { state: 'changed'; at: string; changes: string[] };

function listChange(what: string, before: readonly string[], now: readonly string[]): string[] {
  const added = now.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !now.includes(r));
  return [...(added.length ? [`${what} added: ${added.join(', ')}`] : []), ...(removed.length ? [`${what} removed: ${removed.join(', ')}`] : [])];
}

/** Whether a remembered confirmation still holds for the organization's managed settings as they are now. */
export function confirmationState(c: Confirmation | null, policy: ManagedPolicy, broad = false): ConfirmationState {
  if (!c || policy.status !== 'found') return { state: 'none' };
  if (broad && c.broad !== true) return { state: 'changed', at: c.confirmed_at, changes: ['that confirmation covered narrow rules only, and this change mirrors broad ones'] };
  if (c.fingerprint === policyFingerprint(policy)) return { state: 'valid', at: c.confirmed_at };
  const changes = [...listChange('ask rules', c.ask, policy.ask), ...listChange('deny rules', c.deny, policy.deny)];
  if (c.bypass_disabled !== policy.bypassDisabled) changes.push(`disableBypassPermissionsMode is now ${policy.bypassDisabled ? 'set' : 'not set'}`);
  return { state: 'changed', at: c.confirmed_at, changes: changes.length ? changes : ['the rules changed'] };
}

const WHAT: Record<ConfirmationKind, string> = { mirror: "mirroring the organization's ask rules", unblock: 'the unblock preset' };

/** One line on a remembered confirmation, for a diff or a preflight; null when there is none. */
export function describeConfirmation(s: ConfirmationState, kind: ConfirmationKind = 'mirror'): string | null {
  if (s.state === 'valid') return `you confirmed ${WHAT[kind]} on ${s.at.slice(0, 10)}, and the organization's managed settings have not changed since: no new confirmation is needed`;
  if (s.state === 'changed') return `the organization's managed settings changed since you confirmed ${WHAT[kind]} on ${s.at.slice(0, 10)} (${s.changes.join('; ')}): it needs your confirmation again`;
  return null;
}

// The person's confirmations about the organization's rules, remembered so that each is asked once
// (an older kharos also kept a confirmation to mirror the organization's ask rules here; it is left in the file, unused):
//   unblock  the unblock preset may allow every permission prompt in cloud sessions;
//   no-org-settings  this account has no organization settings: with no copy of them on this machine, they read
//            as empty (0 ask rules, 0 deny rules) until a copy appears, which changes the fingerprint and ends
//            the statement for good: a copy removed later does not bring it back.
// Each is stored with a fingerprint of what the organization's managed settings said then (the ask
// rules, the deny rules and disableBypassPermissionsMode), and holds only while they still say the
// same. When the fingerprint changes, kharos shows what changed and asks again.
// A confirmation replaces only the repeated question; every other safeguard stays: kharos refuses when
// bypass mode is disabled, and deny rules are never touched.

import crypto from 'node:crypto';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import { declaredEmpty, readManagedPolicy, type FoundPolicy, type ManagedPolicy } from './managed-policy.ts';
import type { Paths } from './paths.ts';

export type ConfirmationKind = 'unblock' | 'no-org-settings';

export interface Confirmation {
  fingerprint: string;
  confirmed_at: string;
  /** What the organization's managed settings said when the person confirmed, to show what changed. */
  ask: string[];
  deny: string[];
  bypass_disabled: boolean;
  /** There was no copy of the managed settings: the person declared this account has none. */
  no_copy?: true;
}

/** The fingerprint of what the managed settings say; settings declared empty for want of a copy have one of their own, so a copy that appears later, even an empty one, is a change. */
export function policyFingerprint(p: { ask: readonly string[]; deny: readonly string[]; bypassDisabled: boolean; noCopy?: true }): string {
  const canon = JSON.stringify({ ask: [...p.ask].sort(), deny: [...p.deny].sort(), bypass_disabled: p.bypassDisabled, ...(p.noCopy ? { no_copy: true } : {}) });
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

export function saveConfirmation(paths: Paths, kind: ConfirmationKind, policy: FoundPolicy, now: number): Confirmation {
  const c: Confirmation = {
    fingerprint: policyFingerprint(policy),
    confirmed_at: new Date(now).toISOString(),
    ask: [...policy.ask],
    deny: [...policy.deny],
    bypass_disabled: policy.bypassDisabled,
    ...(policy.noCopy ? { no_copy: true as const } : {}),
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

/**
 * The managed settings as kharos reads them for this account: the copy Claude Code keeps, or, with no copy at all,
 * empty settings when the person declared this account has none. The first read that finds a copy, readable or not,
 * forgets the declaration, so a copy removed later never brings it back: the person declares again.
 */
export function accountPolicy(paths: Paths, policy: ManagedPolicy): ManagedPolicy {
  if (!loadConfirmation(paths, 'no-org-settings')) return policy;
  if (policy.status !== 'absent') {
    forgetConfirmation(paths, 'no-org-settings');
    return policy;
  }
  return declaredEmpty(policy.file);
}

export function readAccountPolicy(paths: Paths, env: NodeJS.ProcessEnv): ManagedPolicy {
  return accountPolicy(paths, readManagedPolicy(env));
}

export type ConfirmationState = { state: 'none' } | { state: 'valid'; at: string } | { state: 'changed'; at: string; changes: string[] };

function listChange(what: string, before: readonly string[], now: readonly string[]): string[] {
  const added = now.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !now.includes(r));
  return [...(added.length ? [`${what} added: ${added.join(', ')}`] : []), ...(removed.length ? [`${what} removed: ${removed.join(', ')}`] : [])];
}

/** Whether a remembered confirmation still holds for the organization's managed settings as they are now. */
export function confirmationState(c: Confirmation | null, policy: ManagedPolicy): ConfirmationState {
  if (!c || policy.status !== 'found') return { state: 'none' };
  if (c.fingerprint === policyFingerprint(policy)) return { state: 'valid', at: c.confirmed_at };
  const changes = [
    ...(c.no_copy && !policy.noCopy ? [`a copy of the organization's managed settings appeared at ${policy.file}, where there was none when you declared this account has no organization settings`] : []),
    ...(!c.no_copy && policy.noCopy ? [`there is no copy of the organization's managed settings at ${policy.file} any more`] : []),
    ...listChange('ask rules', c.ask, policy.ask),
    ...listChange('deny rules', c.deny, policy.deny),
  ];
  if (c.bypass_disabled !== policy.bypassDisabled) changes.push(`disableBypassPermissionsMode is now ${policy.bypassDisabled ? 'set' : 'not set'}`);
  return { state: 'changed', at: c.confirmed_at, changes: changes.length ? changes : ['the rules changed'] };
}

const WHAT: Record<ConfirmationKind, string> = {
  unblock: 'the unblock preset',
  'no-org-settings': 'that this account has no organization settings',
};

/** One line on a remembered confirmation; null when there is none. */
export function describeConfirmation(s: ConfirmationState, kind: ConfirmationKind): string | null {
  if (s.state === 'valid') return `you confirmed ${WHAT[kind]} on ${s.at.slice(0, 10)}, and the organization's managed settings have not changed since: no new confirmation is needed`;
  if (s.state === 'changed') return `the organization's managed settings changed since you confirmed ${WHAT[kind]} on ${s.at.slice(0, 10)} (${s.changes.join('; ')}): it needs your confirmation again`;
  return null;
}

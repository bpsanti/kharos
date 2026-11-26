// Small state files besides the registry: intents (what a command asked the next RemoteTrigger answer
// to be turned into), the environments seen in the account's routines, and the account logged in.

import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { EnvironmentUse } from './remote.ts';
import type { Paths } from './paths.ts';

/**
 * A command that needs the model to call RemoteTrigger records what it expects first. The hook then
 * turns that one answer into what the command shows, and leaves every other call alone.
 */
export type Intent =
  | { kind: 'log'; id: string; lines: number; claude_session: string; expires_at: number }
  | { kind: 'environments'; claude_session: string; account?: string | null; repo?: string | null; expires_at: number };

const INTENT_TTL_MS = 10 * 60_000;

function loadIntents(paths: Paths, now: number): Intent[] {
  return (readState<Intent[]>(paths.intents, (v) => Array.isArray(v) && v.every(isObject), 'a list of intents') ?? []).filter((i) => i.expires_at > now);
}

type WithoutExpiry<T> = T extends unknown ? Omit<T, 'expires_at'> : never;

export function addIntent(paths: Paths, intent: WithoutExpiry<Intent>, now: number): void {
  withLock(paths.intents, () => {
    const list = loadIntents(paths, now).filter((i) => !(i.kind === intent.kind && i.claude_session === intent.claude_session));
    list.push({ ...intent, expires_at: now + INTENT_TTL_MS } as Intent);
    writeJsonAtomic(paths.intents, list);
  });
}

/** Takes the intent that matches, so one answer serves one command. */
export function takeIntent<K extends Intent['kind']>(
  paths: Paths,
  kind: K,
  claudeSession: string,
  match: (i: Extract<Intent, { kind: K }>) => boolean,
  now: number,
): Extract<Intent, { kind: K }> | null {
  return withLock(paths.intents, () => {
    const list = loadIntents(paths, now);
    const idx = list.findIndex((i) => i.kind === kind && i.claude_session === claudeSession && match(i as Extract<Intent, { kind: K }>));
    if (idx < 0) return null;
    const [found] = list.splice(idx, 1);
    writeJsonAtomic(paths.intents, list);
    return found as Extract<Intent, { kind: K }>;
  });
}

export interface EnvironmentBook {
  read_at: string;
  /** The account whose routines were read; null or absent when it is not known. */
  account?: string | null;
  environments: EnvironmentUse[];
}

export function loadEnvironments(paths: Paths): EnvironmentBook | null {
  return readState<EnvironmentBook>(paths.environments, (v) => isObject(v) && Array.isArray(v.environments), 'an object with an "environments" list') ?? null;
}

export function saveEnvironments(paths: Paths, environments: EnvironmentUse[], now: number, account: string | null = null): void {
  writeJsonAtomic(paths.environments, { read_at: new Date(now).toISOString(), account, environments });
}

/** An environment a person said is set up for a repository on one revision. Environments belong to one account. */
export interface EnvironmentSetup {
  account: string;
  /** owner/name, lowercase. */
  repo: string;
  /** The branch or tag whose setup script the person pasted. */
  revision: string;
  environment: string;
  confirmed_at: string;
  /** The repository's setup script at that time, to tell when it changed since; null when it ships none or it was not read. */
  script_sha256: string | null;
}

export type SetupBook = Record<string, EnvironmentSetup>;

export function loadSetups(paths: Paths): SetupBook {
  return readState<SetupBook>(paths.setups, (v) => isObject(v) && Object.values(v).every(isObject), 'an object of environment setups') ?? {};
}

const setupKey = (account: string, repo: string, revision: string): string => `${account} ${repo.toLowerCase()} ${revision}`;

export function findSetup(book: SetupBook, account: string | null, repo: string, revision: string): EnvironmentSetup | null {
  return account ? (book[setupKey(account, repo, revision)] ?? null) : null;
}

/** The confirmations of this account for the repository, one per revision. */
export function setupsFor(book: SetupBook, account: string | null, repo: string): EnvironmentSetup[] {
  if (!account) return [];
  return Object.entries(book)
    .filter(([key, s]) => typeof s.revision === 'string' && key === setupKey(account, repo, s.revision))
    .map(([, s]) => s);
}

export function recordSetup(paths: Paths, setup: EnvironmentSetup): void {
  withLock(paths.setups, () => {
    const all = loadSetups(paths);
    const repo = setup.repo.toLowerCase();
    all[setupKey(setup.account, repo, setup.revision)] = { ...setup, repo };
    writeJsonAtomic(paths.setups, all);
  });
}

/** The routines read for this account; another account's environments say nothing about this one's. */
export function environmentsOf(book: EnvironmentBook | null, account: string | null): EnvironmentBook | null {
  return book && (!book.account || !account || book.account === account) ? book : null;
}

/** The account logged in when kharos last read it, kept as a hash, to tell a switched login from a finished session. */
export interface LoginState {
  account: string | null;
  read_at: string | null;
}

export function loadLogin(paths: Paths): LoginState {
  const l = readState<Partial<LoginState>>(paths.login, isObject, 'an object');
  return { account: typeof l?.account === 'string' ? l.account : null, read_at: typeof l?.read_at === 'string' ? l.read_at : null };
}

export function saveLogin(paths: Paths, login: LoginState): void {
  withLock(paths.login, () => writeJsonAtomic(paths.login, login));
}

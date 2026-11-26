// One Claude account's kharos files, taken out of the folders every account on the machine shared before
// kharos scoped them. It runs once per account, from /kharos:setup: the profiles this account wrote (its
// stamp, or launches it made with them) and its own sessions move to its files; a profile nobody can tell
// the owner of moves only when the person says it is theirs. Nothing of another account is read beyond
// telling whose it is, and nothing of it changes.

import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, loadConfig, saveConfig, type Config, type Profile } from './config.ts';
import { isObject, readState, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';
import { loadRegistry, updateRegistry, type Session } from './registry.ts';

export interface Migration {
  /** Profiles of the shared files that are this account's. */
  mine: string[];
  /** Profiles whose account cannot be told: the person says which are theirs. */
  unknown: string[];
  /** Sessions this account launched, kept in the shared registry. */
  sessions: string[];
}

interface Marker {
  at: string;
  profiles: string[];
  sessions: string[];
}

export function loadMarker(paths: Paths): Marker | null {
  return readState<Marker>(paths.migration, (v) => isObject(v) && typeof v.at === 'string', 'a kharos migration record') ?? null;
}

/** Whose each profile of the shared files is, and which shared sessions this account launched; null when there is nothing to take. */
export function planMigration(shared: Paths, account: string): Migration | null {
  const config = loadConfig(shared);
  const reg = loadRegistry(shared);
  const sessions = Object.values(reg.sessions).filter((s) => s.account === account).map((s) => s.id);
  const mine: string[] = [];
  const unknown: string[] = [];
  for (const [name, p] of Object.entries(config.config.profiles)) {
    const owners = p.account ? new Set([p.account]) : new Set(Object.values(reg.sessions).filter((s) => s.profile === name).map((s) => s.account));
    if (owners.size === 1 && owners.has(account)) mine.push(name);
    else if (owners.size === 0 || (owners.size > 1 && owners.has(account))) unknown.push(name);
  }
  if (mine.length === 0 && unknown.length === 0 && sessions.length === 0) return null;
  return { mine, unknown, sessions };
}

function move(from: string, to: string): void {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export type MigrationResult =
  | { state: 'none' }
  | { state: 'done'; profiles: string[]; sessions: number; at: string }
  | { state: 'ask'; unknown: string[] };

/**
 * Takes this account's profiles and sessions out of the shared files, once. `adopt` names the profiles
 * of unknown account the person said are theirs (an empty list for none); while it is null and some
 * profile's account cannot be told, nothing moves and the result asks.
 */
export function migrate(paths: Paths, shared: Paths | null, account: string | null, adopt: string[] | null, now: number): MigrationResult {
  if (!shared || !account) return { state: 'none' };
  const done = loadMarker(paths);
  if (done) return done.profiles.length || done.sessions.length ? { state: 'done', profiles: done.profiles, sessions: done.sessions.length, at: done.at } : { state: 'none' };
  const plan = planMigration(shared, account);
  const at = new Date(now).toISOString();
  if (!plan) {
    writeJsonAtomic(paths.migration, { at, profiles: [], sessions: [] } satisfies Marker);
    return { state: 'none' };
  }
  if (plan.unknown.length && adopt === null) return { state: 'ask', unknown: plan.unknown };
  const take = [...plan.mine, ...plan.unknown.filter((n) => adopt?.includes(n))];

  if (take.length) {
    const from = loadConfig(shared).config;
    const own = loadConfig(paths);
    // Watcher thresholds and outputs are the machine's, so a first configuration starts from the shared one;
    // account_mode is the answer about one account's own user settings, so it is not copied.
    const { account_mode: _sharedAccountMode, ...machine } = from;
    const to: Config = own.exists ? own.config : { ...defaultConfig(), ...machine, profiles: {}, default_profile: null };
    for (const name of take) {
      if (to.profiles[name]) continue; // this account's own profile of the same name wins
      to.profiles[name] = { ...(from.profiles[name] as Profile), account };
      delete from.profiles[name];
    }
    if (to.default_profile === null) to.default_profile = from.default_profile && take.includes(from.default_profile) ? from.default_profile : (take.find((n) => to.profiles[n]) ?? null);
    if (from.default_profile && !from.profiles[from.default_profile]) from.default_profile = null;
    saveConfig(paths, to);
    saveConfig(shared, from);
  }

  const moved: Session[] = [];
  if (plan.sessions.length) {
    updateRegistry(shared, (reg) => {
      const mineNow = loadRegistry(paths).sessions;
      for (const id of plan.sessions) {
        const s = reg.sessions[id];
        if (!s || mineNow[id]) continue;
        moved.push(s);
        delete reg.sessions[id];
      }
    });
    updateRegistry(paths, (reg) => {
      for (const s of moved) reg.sessions[s.id] = s;
      reg.next_seq = Math.max(reg.next_seq, loadRegistry(shared).next_seq);
    });
    for (const s of moved) {
      move(path.join(shared.logs, `${s.id}.jsonl`), path.join(paths.logs, `${s.id}.jsonl`));
      move(path.join(shared.bodies, `${s.id}.json`), path.join(paths.bodies, `${s.id}.json`));
      move(path.join(shared.followers, `${s.id}.json`), path.join(paths.followers, `${s.id}.json`));
    }
  }
  const marker: Marker = { at, profiles: take, sessions: moved.map((s) => s.id) };
  writeJsonAtomic(paths.migration, marker);
  return take.length || moved.length ? { state: 'done', profiles: take, sessions: moved.length, at } : { state: 'none' };
}

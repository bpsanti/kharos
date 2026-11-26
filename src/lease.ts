// The follower lease: a `kharos wait` that reads a session holds `followers/<id>.json` with its pid and a
// heartbeat, so one process reads a session at a time, the watcher leaves that session to it, and
// `kharos health` counts it as followed. A lease whose process is gone or whose heartbeat is old is free.
// A wait that returns for the next one to go on (a follower agent started again, or the next turn of a
// shell loop) hands the lease over instead of dropping it: for a short while the session still counts as
// followed, so nothing starts a second follower in between.

import fs from 'node:fs';
import path from 'node:path';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

/**
 * A lease older than this is free even when its pid is alive, which covers a reused pid.
 * The holder renews it on every turn of its loop, and a turn lasts at most the longest interval
 * between reads plus one read. A live process whose lease is this old is a follower that is stuck.
 */
export const LEASE_STALE_MS = 3 * 60_000;

/**
 * How long a handed-over lease keeps its session followed: a follower agent is started again within
 * seconds of its report, and the next wait of a shell loop within milliseconds.
 */
export const HANDOVER_MS = 2 * 60_000;

/** Who holds the lease: a kharos:follow agent's wait, or the loop of a follower process (`kharos follow`). */
export type FollowerKind = 'agent' | 'shell';

export interface Lease {
  pid: number;
  beat: string;
  since: string;
  kind?: FollowerKind;
  /** The holder returned for the next follower to go on; the lease is free, and still counts as followed for HANDOVER_MS. */
  handover_at?: string;
}

function leasePath(paths: Paths, id: string): string {
  return path.join(paths.followers, `${id}.json`);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLease(paths: Paths, id: string): Lease | null {
  return readState<Lease>(leasePath(paths, id), (v) => isObject(v) && typeof v.pid === 'number' && typeof v.beat === 'string', 'a follower lease') ?? null;
}

function isLive(l: Lease | null, now: number): boolean {
  return l !== null && !l.handover_at && now - Date.parse(l.beat) < LEASE_STALE_MS && pidAlive(l.pid);
}

function inHandover(l: Lease | null, now: number): boolean {
  return l?.handover_at !== undefined && now - Date.parse(l.handover_at) < HANDOVER_MS;
}

/** Takes or renews the lease of a session for this process; false when another live process holds it. */
export function takeLease(paths: Paths, id: string, now: number, pid = process.pid, kind?: FollowerKind): boolean {
  const file = leasePath(paths, id);
  return withLock(file, () => {
    let cur: Lease | null = null;
    try {
      cur = readLease(paths, id);
    } catch {
      // An unreadable lease holds nothing: it is written again below.
    }
    if (cur && cur.pid !== pid && isLive(cur, now)) return false;
    const iso = new Date(now).toISOString();
    const mine = cur?.pid === pid;
    const k = kind ?? (mine ? cur?.kind : undefined);
    writeJsonAtomic(file, { pid, beat: iso, since: mine ? (cur as Lease).since : iso, ...(k ? { kind: k } : {}) } satisfies Lease);
    return true;
  });
}

/**
 * Gives the lease back, only when this process holds it. With `handoverAt`, the next follower is about
 * to go on: the lease stays as a handover, free to take, that counts as followed for HANDOVER_MS.
 */
export function releaseLease(paths: Paths, id: string, pid = process.pid, handoverAt: number | null = null): void {
  const file = leasePath(paths, id);
  withLock(file, () => {
    let cur: Lease | null;
    try {
      cur = readLease(paths, id);
    } catch {
      return;
    }
    if (cur?.pid !== pid) return;
    if (handoverAt === null) fs.rmSync(file, { force: true });
    else writeJsonAtomic(file, { ...cur, handover_at: new Date(handoverAt).toISOString() } satisfies Lease);
  });
}

/**
 * Marks that a follower agent is about to start on the session, when no live follower holds it, so the
 * session counts as followed while the agent starts.
 */
export function expectFollower(paths: Paths, id: string, now: number): void {
  const file = leasePath(paths, id);
  withLock(file, () => {
    let cur: Lease | null = null;
    try {
      cur = readLease(paths, id);
    } catch {
      // rewritten below
    }
    if (isLive(cur, now)) return;
    const iso = new Date(now).toISOString();
    writeJsonAtomic(file, { pid: process.pid, beat: iso, since: iso, kind: 'agent', handover_at: iso } satisfies Lease);
  });
}

/**
 * Starts a follower process on the session unless one follows it already (a live lease or a handover),
 * under the lease's lock so two callers never start two. `spawn` returns the new process's pid, which
 * gets the lease at once; its own waits then renew it.
 */
export function claimFollower(paths: Paths, id: string, now: number, spawn: () => number | null): { started: number } | { busy: true } | { failed: true } {
  const file = leasePath(paths, id);
  return withLock(file, () => {
    let cur: Lease | null = null;
    try {
      cur = readLease(paths, id);
    } catch {
      // rewritten below
    }
    if (isLive(cur, now) || inHandover(cur, now)) return { busy: true as const };
    const pid = spawn();
    if (pid === null) return { failed: true as const };
    const iso = new Date(now).toISOString();
    writeJsonAtomic(file, { pid, beat: iso, since: iso, kind: 'shell' } satisfies Lease);
    return { started: pid };
  });
}

/**
 * A session fired less than this long ago may have its follower still starting: it is not reported as
 * unfollowed yet, so nobody starts a second one.
 */
export const FOLLOWER_GRACE_MS = 60_000;

export function followerMayBeStarting(s: { fired_at: string | null }, now: number): boolean {
  return s.fired_at !== null && now - Date.parse(s.fired_at) < FOLLOWER_GRACE_MS;
}

/**
 * What a lease says about its follower: `live` (its process runs and beats), `handover` (the next one is
 * about to go on), `stale` (its process runs but has not beaten for LEASE_STALE_MS: it looks stuck), or
 * `gone` (its process ended without giving the lease back).
 */
export type FollowerState = 'live' | 'handover' | 'stale' | 'gone';

export interface FollowerInfo {
  id: string;
  pid: number;
  kind: FollowerKind | null;
  beat: string;
  state: FollowerState;
}

function stateOf(l: Lease, now: number): FollowerState | null {
  if (isLive(l, now)) return 'live';
  if (l.handover_at) return inHandover(l, now) ? 'handover' : null;
  return pidAlive(l.pid) ? 'stale' : 'gone';
}

/** Every follower lease and what it says, by session; an expired handover says nothing. */
export function followerReport(paths: Paths, now: number): FollowerInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.followers);
  } catch {
    return [];
  }
  const out: FollowerInfo[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    let l: Lease | null;
    try {
      l = readLease(paths, id);
    } catch {
      // An unreadable lease follows nothing; the next takeLease rewrites it.
      continue;
    }
    if (!l) continue;
    const state = stateOf(l, now);
    if (state) out.push({ id, pid: l.pid, kind: l.kind ?? null, beat: l.beat, state });
  }
  return out;
}

/** The sessions a follower reads now, or is about to read again after a handover. */
export function liveFollowers(paths: Paths, now: number): Set<string> {
  return new Set(followerReport(paths, now).filter((f) => f.state === 'live' || f.state === 'handover').map((f) => f.id));
}

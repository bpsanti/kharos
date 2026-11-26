// The follower lease: a `kharos wait` that reads a session holds `followers/<id>.json` with its pid and a
// heartbeat, so one process reads a session at a time, the watcher leaves that session to it, and
// `kharos health` counts it as followed. A lease whose process is gone or whose heartbeat is old is free.

import fs from 'node:fs';
import path from 'node:path';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

/**
 * A lease older than this is free even when its pid is alive, which covers a reused pid.
 * The holder renews it on every turn of its loop, and a turn lasts at most the longest interval
 * between reads plus one read.
 */
export const LEASE_STALE_MS = 3 * 60_000;

export interface Lease {
  pid: number;
  beat: string;
  since: string;
}

function leasePath(paths: Paths, id: string): string {
  return path.join(paths.followers, `${id}.json`);
}

function pidAlive(pid: number): boolean {
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

function isLive(l: Lease | null, now: number): l is Lease {
  return l !== null && now - Date.parse(l.beat) < LEASE_STALE_MS && pidAlive(l.pid);
}

/** Takes or renews the lease of a session for this process; false when another live process holds it. */
export function takeLease(paths: Paths, id: string, now: number, pid = process.pid): boolean {
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
    writeJsonAtomic(file, { pid, beat: iso, since: cur?.pid === pid ? cur.since : iso } satisfies Lease);
    return true;
  });
}

/** Gives the lease back, only when this process holds it. */
export function releaseLease(paths: Paths, id: string, pid = process.pid): void {
  const file = leasePath(paths, id);
  withLock(file, () => {
    try {
      if (readLease(paths, id)?.pid !== pid) return;
    } catch {
      return;
    }
    fs.rmSync(file, { force: true });
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

/** The sessions a live follower reads now. */
export function liveFollowers(paths: Paths, now: number): Set<string> {
  let names: string[];
  try {
    names = fs.readdirSync(paths.followers);
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    try {
      if (isLive(readLease(paths, id), now)) out.add(id);
    } catch {
      // An unreadable lease follows nothing; the next takeLease rewrites it.
    }
  }
  return out;
}

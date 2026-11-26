// The watcher: `/loop 10m /kharos:watch` in a session of its own. Each pass asks `kharos due` which reads
// to make (no network), the model makes them, the hooks classify and queue the events, and
// `kharos pass-end` answers with one line about what changed. The heartbeat lets `kharos health` and the SessionStart hook tell a
// stopped watcher from a quiet one.

import { readAuthStatus } from './account.ts';
import { clean } from './body.ts';
import type { WatchConfig } from './config.ts';
import { oneLine, readOutbox, type KharosEvent } from './events.ts';
import type { Paths } from './paths.ts';
import { followerMayBeStarting, liveFollowers } from './lease.ts';
import { collectGarbage, isFollowed, loadRegistry, startedAt, updateRegistry, type Session } from './registry.ts';
import { loadWatch, updateWatch } from './state.ts';
import { settle, watchConfig } from './track.ts';

const MIN = 60_000;
const ACCOUNT_TTL_MS = 10 * MIN;
const MAX_WATCHERS = 10;
const TITLE_MAX = 40;

export interface Read {
  session: string;
  action: 'get_run_log' | 'list_runs';
  params: Record<string, string>;
}

/** How often a session is read, as a multiple of the interval: often while young or in trouble. */
export function cadence(s: Session, now: number): number {
  // A permission prompt that waits for the next read to count: a person may be needed.
  if (s.notice || s.pending_state?.key) return 1;
  const age = now - startedAt(s);
  if (age < 20 * MIN) return 1;
  if (age < 120 * MIN) return 2;
  return 3;
}

export function isDue(s: Session, now: number, intervalMin: number): boolean {
  // A session with no log read yet (a list_runs during the launch does not count): read now.
  if (!s.last_read_at || (s.session_id && s.reads === 0)) return true;
  if (s.pending_cursor) return true;
  // A /loop pass can come up to half an interval late, so the threshold has that slack.
  const wait = (cadence(s, now) * intervalMin - intervalMin / 2) * MIN;
  return now - Date.parse(s.last_read_at) >= wait;
}

export function readsFor(s: Session): Read[] {
  if (!s.trigger_id) return [];
  if (!s.session_id) return [{ session: s.id, action: 'list_runs', params: { trigger_id: s.trigger_id } }];
  const out: Read[] = [];
  if (s.pending_cursor) out.push({ session: s.id, action: 'get_run_log', params: { session_id: s.session_id, cursor: s.pending_cursor } });
  else out.push({ session: s.id, action: 'get_run_log', params: { session_id: s.session_id } });
  // Every sixth read also checks whether the session was archived.
  if (s.reads % 6 === 5) out.push({ session: s.id, action: 'list_runs', params: { trigger_id: s.trigger_id } });
  return out;
}

export interface DueOptions {
  watcher: string | null;
  all: boolean;
  now: number;
  env: NodeJS.ProcessEnv;
  /** Test seam: the account currently logged in. */
  account?: () => string | null;
}

export interface DueResult {
  reads: Read[];
  open: number;
  events: KharosEvent[];
  /** Open sessions left to a live follower in this pass. */
  followers: number;
}

/** The current account, read at most every ten minutes and kept as a hash; `read` is a test seam. */
export function currentAccount(paths: Paths, now: number, env: NodeJS.ProcessEnv, read?: () => string | null): string | null {
  const w = loadWatch(paths);
  if (!read && w.account && w.account_read_at && now - Date.parse(w.account_read_at) < ACCOUNT_TTL_MS) return w.account;
  const account = read ? read() : (readAuthStatus(env)?.account ?? null);
  updateWatch(paths, (x) => {
    x.account = account;
    x.account_read_at = new Date(now).toISOString();
  });
  return account;
}

export function due(paths: Paths, opts: DueOptions): DueResult {
  const watch = watchConfig(paths);
  const nowIso = new Date(opts.now).toISOString();
  if (opts.watcher) {
    updateWatch(paths, (w) => {
      w.last_beat = nowIso;
      w.interval_min = watch.interval_min;
      w.pass_started_at = nowIso;
      w.watchers[opts.watcher as string] = nowIso;
      const ids = Object.entries(w.watchers).sort((a, b) => b[1].localeCompare(a[1])).map(([k]) => k);
      for (const old of ids.slice(MAX_WATCHERS)) delete w.watchers[old];
    });
  }
  const account = currentAccount(paths, opts.now, opts.env, opts.account);
  const events: KharosEvent[] = [];
  const reads: Read[] = [];
  // A session a follower (`kharos wait`) reads now is left to it, unless the person asked for every read.
  const followers = opts.all ? new Set<string>() : liveFollowers(paths, opts.now);
  let leftToFollowers = 0;
  const open = updateRegistry(paths, (reg) => {
    collectGarbage(paths, reg, opts.now);
    const followed = Object.values(reg.sessions).filter(isFollowed);
    for (const s of followed) {
      if (account && s.account !== account) {
        // Another login cannot see this session: say so, and never read it as finished.
        events.push(...settle({ paths, now: opts.now, env: opts.env }, s, { state: 'invisible', notice: 'invisible', reason: 'the account logged in now is not the one that launched this session' }, watch));
        continue;
      }
      if (followers.has(s.id)) {
        leftToFollowers++;
        continue;
      }
      if (opts.all || isDue(s, opts.now, watch.interval_min)) reads.push(...readsFor(s));
    }
    return followed.length;
  });
  return { reads, open, events, followers: leftToFollowers };
}

/**
 * Whether a Claude Code session runs the watcher now: it listed the reads of a pass less than three
 * intervals ago. A session that ran /kharos:watch once and stopped is an ordinary session again.
 */
export function isActiveWatcher(paths: Paths, claudeSession: string | undefined, now: number): boolean {
  if (!claudeSession) return false;
  const w = loadWatch(paths);
  const at = w.watchers[claudeSession];
  if (!at) return false;
  const every = w.interval_min ?? watchConfig(paths).interval_min;
  return now - Date.parse(at) < 3 * every * MIN;
}

export function formatReads(r: DueResult): string {
  if (r.open === 0) return 'nothing open: no session to follow. Stop the loop that runs /kharos:watch.';
  const lines = r.events.map((e) => `event: ${oneLine(e)}`);
  if (r.reads.length === 0) lines.push(`${r.open} open session(s), none due for a read in this pass${r.followers ? ` (${r.followers} read by a follower)` : ''}.`);
  else {
    lines.push(`Make these RemoteTrigger calls, one by one, exactly as written:`);
    for (const x of r.reads) lines.push(`- action "${x.action}", ${Object.entries(x.params).map(([k, v]) => `${k} "${v}"`).join(', ')}`);
  }
  return lines.join('\n');
}

/** The one line a watcher pass ends with: what changed since the pass began, or that nothing did. */
export function passEnd(paths: Paths, opts: { watcher: string | null; now: number; delivered?: string[] }): string {
  const w = loadWatch(paths);
  const nowIso = new Date(opts.now).toISOString();
  if (opts.watcher) {
    updateWatch(paths, (x) => {
      x.last_beat = nowIso;
    });
  }
  const since = w.pass_started_at ?? nowIso;
  const reg = loadRegistry(paths);
  const changed = Object.values(reg.sessions).filter((s) => s.state_since >= since || (s.last_notice && s.last_notice.at >= since));
  const open = Object.values(reg.sessions).filter(isFollowed).length;
  const pending = readOutbox(paths).length;
  const parts = changed.map((s) => `${s.id} ${s.state.replace(/_/g, ' ')}${s.last_notice && s.last_notice.at >= since ? ` (${s.last_notice.event.slice(8).replace(/_/g, ' ')})` : ''}`);
  const tail = pending ? `; ${pending} event(s) still waiting for an output` : '';
  if (open === 0 && changed.length === 0) return `watch: nothing open${tail}. Stop the loop that runs /kharos:watch.`;
  return parts.length ? `watch: ${parts.join('; ')}${tail}` : `watch: ${open} open, no change${tail}`;
}

/** A session's id, with its title when the title is short enough for one line. */
function named(s: Session): string {
  const title = clean(s.title, TITLE_MAX + 1);
  return title && title.length <= TITLE_MAX ? `${s.id} "${title}"` : s.id;
}

export interface Health {
  ok: boolean;
  line: string;
}

/**
 * Fails when a session is open that no live follower reads and the watcher has not beaten for three
 * intervals: nobody would notice when that session needs the person.
 */
export function health(paths: Paths, now: number, watch: WatchConfig = watchConfig(paths)): Health {
  const reg = loadRegistry(paths);
  const open = Object.values(reg.sessions)
    .filter(isFollowed)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (open.length === 0) return { ok: true, line: 'kharos: no open session' };
  const followers = liveFollowers(paths, now);
  const nobody = open.filter((s) => !followers.has(s.id) && !followerMayBeStarting(s, now));
  const byFollowers = open.length - nobody.length;
  if (nobody.length === 0) return { ok: true, line: `kharos: ${open.length} open session(s), each read by a follower` };
  const w = loadWatch(paths);
  const every = w.interval_min ?? watch.interval_min;
  const followerPart = byFollowers ? ` (${byFollowers} more read by a follower)` : '';
  const names = nobody.map((s) => named(s)).join(', ');
  const fix = `Type /kharos:follow in a Claude Code session to follow them there, or start /loop ${every}m /kharos:watch in a separate session.`;
  if (!w.last_beat) return { ok: false, line: `kharos: ${nobody.length} open session(s) with no follower: ${names}${followerPart}, and the watcher never ran. ${fix}` };
  const ago = now - Date.parse(w.last_beat);
  if (ago > 3 * every * MIN) {
    return { ok: false, line: `kharos: ${nobody.length} open session(s) with no follower: ${names}${followerPart}, and no watcher heartbeat for ${Math.round(ago / MIN)} min. ${fix}` };
  }
  return { ok: true, line: `kharos: ${open.length} open session(s)${byFollowers ? `, ${byFollowers} read by a follower` : ''}, watcher heartbeat ${Math.round(ago / MIN)} min ago` };
}

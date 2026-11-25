// The watcher: `/loop 10m /nuvem:watch` in a session of its own. Each pass asks `nuvem due` which reads
// to make (no network), the model makes them, the hooks classify, and `nuvem pass-end` delivers the
// events and answers with one line. The heartbeat lets `nuvem health` and the SessionStart hook tell a
// stopped watcher from a quiet one.

import { readAuthStatus } from './account.ts';
import type { WatchConfig } from './config.ts';
import { oneLine, readOutbox, type NuvemEvent } from './events.ts';
import type { Paths } from './paths.ts';
import { collectGarbage, isFollowed, loadRegistry, updateRegistry, type Session } from './registry.ts';
import { loadWatch, updateWatch } from './state.ts';
import { settle, watchConfig } from './track.ts';

const MIN = 60_000;
const ACCOUNT_TTL_MS = 10 * MIN;
const MAX_WATCHERS = 10;

export interface Read {
  session: string;
  action: 'get_run_log' | 'list_runs';
  params: Record<string, string>;
}

/** How often a session is read, as a multiple of the interval: often while young or in trouble. */
export function cadence(s: Session, now: number): number {
  if (s.notice) return 1;
  const age = now - Date.parse(s.created_at);
  if (age < 20 * MIN) return 1;
  if (age < 120 * MIN) return 2;
  return 3;
}

export function isDue(s: Session, now: number, intervalMin: number): boolean {
  if (!s.last_read_at) return true;
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
  events: NuvemEvent[];
}

/** The current account, read at most every ten minutes and kept as a hash. */
function currentAccount(paths: Paths, opts: DueOptions): string | null {
  const w = loadWatch(paths);
  if (!opts.account && w.account && w.account_read_at && opts.now - Date.parse(w.account_read_at) < ACCOUNT_TTL_MS) return w.account;
  const account = opts.account ? opts.account() : (readAuthStatus(opts.env)?.account ?? null);
  updateWatch(paths, (x) => {
    x.account = account;
    x.account_read_at = new Date(opts.now).toISOString();
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
  const account = currentAccount(paths, opts);
  const events: NuvemEvent[] = [];
  const reads: Read[] = [];
  const open = updateRegistry(paths, (reg) => {
    collectGarbage(paths, reg, opts.now);
    const followed = Object.values(reg.sessions).filter(isFollowed);
    for (const s of followed) {
      if (account && s.account !== account) {
        // Another login cannot see this session: say so, and never read it as finished.
        events.push(...settle({ paths, now: opts.now, env: opts.env }, s, { state: 'invisible', notice: 'invisible', reason: 'the account logged in now is not the one that launched this session' }, watch));
        continue;
      }
      if (opts.all || isDue(s, opts.now, watch.interval_min)) reads.push(...readsFor(s));
    }
    return followed.length;
  });
  return { reads, open, events };
}

export function formatReads(r: DueResult): string {
  if (r.open === 0) return 'nothing open: no session to follow. Stop the loop that runs /nuvem:watch.';
  const lines = r.events.map((e) => `event: ${oneLine(e)}`);
  if (r.reads.length === 0) lines.push(`${r.open} open session(s), none due for a read in this pass.`);
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
  if (open === 0 && changed.length === 0) return `watch: nothing open${tail}. Stop the loop that runs /nuvem:watch.`;
  return parts.length ? `watch: ${parts.join('; ')}${tail}` : `watch: ${open} open, no change${tail}`;
}

export interface Health {
  ok: boolean;
  line: string;
}

/** Fails when sessions are open and the watcher has not beaten for three intervals. */
export function health(paths: Paths, now: number, watch: WatchConfig = watchConfig(paths)): Health {
  const reg = loadRegistry(paths);
  const open = Object.values(reg.sessions).filter(isFollowed).length;
  const w = loadWatch(paths);
  const every = w.interval_min ?? watch.interval_min;
  if (open === 0) return { ok: true, line: 'nuvem: no open session' };
  if (!w.last_beat) return { ok: false, line: `nuvem: ${open} open session(s) and the watcher never ran. Start /loop ${every}m /nuvem:watch in a separate session.` };
  const ago = now - Date.parse(w.last_beat);
  if (ago > 3 * every * MIN) {
    return { ok: false, line: `nuvem: ${open} open session(s) and no watcher heartbeat for ${Math.round(ago / MIN)} min. Start /loop ${every}m /nuvem:watch again.` };
  }
  return { ok: true, line: `nuvem: ${open} open session(s), watcher heartbeat ${Math.round(ago / MIN)} min ago` };
}

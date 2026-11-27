// Closing a session whose pull requests ended. A session that opened a pull request and sits idle once
// that pull request is merged or closed holds a watch.max_open slot for work that is over: nobody runs
// /kharos:close on it, and it may never write the end mark. The follower that holds its lease closes it
// then, with a terminal event that names the pull request. Only an idle session: its turn closed, no call
// open, nothing left in the background that could wake it, and quiet for unmarked_end_min, so a session
// a pull request's merge woke shows it first. A session that is working is never closed, and a session
// that opened no pull request is never closed this way.

import { openBackgroundTasks } from './classify.ts';
import type { WatchConfig } from './config.ts';
import { enqueue, transition } from './events.ts';
import type { PullRequestReader, PullRequestState } from './forge.ts';
import { readStoredEvents, type LogEvent } from './logparse.ts';
import type { Paths } from './paths.ts';
import { loadRegistry, logPath, TERMINAL_STATES, updateRegistry, type Session } from './registry.ts';

const MIN = 60_000;

/**
 * How long kharos keeps a pull request's state before it asks GitHub again. Reads of an idle session come
 * every minute at most, so this keeps one gh call per pull request every few reads; a merge is final and
 * is never asked again.
 */
export const PR_STATE_TTL_MS = 5 * MIN;

/**
 * The session sits idle: its last read shows a closed turn with no end mark, no call left open, no
 * background task that could still wake it, quiet for unmarked_end_min, and no question kharos sent it
 * lately that it may still be answering.
 */
export function idleForPrClose(s: Session, events: readonly LogEvent[], now: number, watch: WatchConfig): boolean {
  if (s.step !== 'open' || TERMINAL_STATES.has(s.state) || s.state !== 'turn_closed') return false;
  const last = events.at(-1);
  if (!last || last.kind !== 'result' || now - last.t < watch.unmarked_end_min * MIN) return false;
  if (openBackgroundTasks(events, now) > 0) return false;
  return !(s.end_probe && now - Date.parse(s.end_probe.at) <= watch.unmarked_end_min * MIN);
}

interface Asked {
  fresh: Record<string, { state: PullRequestState; at: string }>;
  /** Why gh could not tell, when it could not. */
  failed: string | null;
}

/** Where the pull request stands, from the cache while it is fresh, else from GitHub; null when gh cannot tell. */
function stateOf(s: Session, pr: string, now: number, read: PullRequestReader, asked: Asked): PullRequestState | null {
  const cached = s.pr_states?.[pr];
  if (cached && (cached.state === 'merged' || now - Date.parse(cached.at) < PR_STATE_TTL_MS)) return cached.state;
  const r = read(pr);
  if (!r.ok) {
    asked.failed = r.error;
    return null;
  }
  asked.fresh[pr] = { state: r.state, at: new Date(now).toISOString() };
  return r.state;
}

/** gh failed lately: it is asked again only after PR_STATE_TTL_MS, so a gh that keeps failing does not hold up every read. */
function backingOff(s: Session, now: number): boolean {
  return Boolean(s.pr_check_failed && now - Date.parse(s.pr_check_failed.at) < PR_STATE_TTL_MS);
}

function closeReason(prs: readonly string[], states: Record<string, PullRequestState>): string {
  const idle = 'and it sits idle: its turn closed, with nothing left that could wake it';
  if (prs.length === 1) return `closed because the pull request it opened, ${prs[0]}, was ${states[prs[0] as string]}, ${idle}`;
  return `closed because every pull request it opened ended (${prs.map((pr) => `${pr} ${states[pr]}`).join(', ')}), ${idle}`;
}

/**
 * Closes the session when it is idle and every pull request it opened is merged or closed; true when it
 * did. GitHub is asked outside the registry lock, and the session is closed only if no read changed it
 * meanwhile. A session the person closed already is closed quietly, as its other ends are.
 */
export function closeIfPrEnded(paths: Paths, id: string, now: number, watch: WatchConfig, read: PullRequestReader): boolean {
  const s = loadRegistry(paths).sessions[id];
  const prs = s?.prs_opened ?? [];
  if (!s || prs.length === 0) return false;
  const events = readStoredEvents(logPath(paths, id));
  if (!idleForPrClose(s, events, now, watch) || backingOff(s, now)) return false;
  const asked: Asked = { fresh: {}, failed: null };
  const { fresh } = asked;
  const states: Record<string, PullRequestState> = {};
  let ended = true;
  for (const pr of prs) {
    const state = stateOf(s, pr, now, read, asked);
    if (state === null || state === 'open') {
      ended = false;
      break;
    }
    states[pr] = state;
  }
  return updateRegistry(paths, (reg) => {
    const cur = reg.sessions[id];
    if (!cur) return false;
    if (Object.keys(fresh).length) cur.pr_states = { ...cur.pr_states, ...fresh };
    cur.pr_check_failed = asked.failed === null ? null : { at: new Date(now).toISOString(), error: asked.failed };
    // A read that landed meanwhile may show the session at work again.
    if (!ended || cur.last_event_at !== s.last_event_at || cur.state !== s.state || cur.step !== 'open' || (cur.prs_opened?.length ?? 0) !== prs.length) return false;
    if (!cur.closing_at) enqueue(paths, transition(cur, { state: cur.state, notice: 'auto_closed', reason: closeReason(prs, states) }, now, watch.renotify_min, false));
    cur.step = 'closed';
    cur.closed_at = new Date(now).toISOString();
    cur.notice = null;
    cur.end_probe_due = null;
    return true;
  });
}

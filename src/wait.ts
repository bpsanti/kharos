// `kharos wait <id>`: blocks until one cloud session changes in a way a person cares about, and prints one
// JSON line. The kharos:follow agent runs it in a loop, so a follower spends no model call while nothing
// happens. A cloud session's log is readable only through the RemoteTrigger tool, which only a model calls,
// so a read is a minimal `claude -p` that makes the calls; the followers due at the same moment share one
// in a read round (round.ts). The plugin's own hook stores, classifies and queues each answer, and the
// reader model sees one short line per call.

import path from 'node:path';
import { readAuthStatus } from './account.ts';
import { clean, endProbe } from './body.ts';
import { CommandError, sendMessage } from './commands.ts';
import { expectFollower, liveFollowers, releaseLease, takeLease } from './lease.ts';
import type { Paths } from './paths.ts';
import { findSession, isFollowed, loadRegistry, TERMINAL_STATES, updateRegistry, type Session } from './registry.ts';
import { loadLogin, saveLogin } from './state.ts';
import { settle, watchConfig } from './track.ts';
import { categoryText, type PermissionCategory } from './permission-request.ts';
import { appendMark, buildEvent, enqueue, type AlertRef } from './events.ts';
import { headlessRead, JOIN_AHEAD_MS, PLUGIN_ROOT, readInRound, roundOpen, type Read, type Reader } from './round.ts';

export { headlessRead, PLUGIN_ROOT, READER_ROLE, ROLE_ENV, type Read, type Reader, type ReaderRun } from './round.ts';

export const WAIT_DEFAULTS = { maxS: 540, minIntervalS: 15, maxIntervalS: 60 } as const;

/** The reads of one pass on a session: its log, or list_runs while its session id is unknown. */
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

const ACCOUNT_TTL_MS = 10 * 60_000;

/** The current account, read at most every ten minutes and kept as a hash; `read` is a test seam. */
export function currentAccount(paths: Paths, now: number, env: NodeJS.ProcessEnv, read?: () => string | null): string | null {
  const l = loadLogin(paths);
  if (!read && l.account && l.read_at && now - Date.parse(l.read_at) < ACCOUNT_TTL_MS) return l.account;
  const account = read ? read() : (readAuthStatus(env)?.account ?? null);
  saveLogin(paths, { account, read_at: new Date(now).toISOString() });
  return account;
}

/** How often a wait looks at the registry between its own reads, to see what another process recorded. */
const SLICE_MS = 5_000;
/** How often a wait whose read is due within JOIN_AHEAD_MS looks for a round it may join. */
const JOIN_POLL_MS = 500;
/** Reads in a row that did not reach the registry before the wait gives up and says why. */
const MAX_READER_FAILURES = 3;

/**
 * What a follower compares to know whether something changed. It is the open notice, not the state:
 * /kharos:send moves the state to running at once while the notice stays open until the next read
 * closes it, and that is no news for the follower. A question answered that way is no news either, nor
 * the notice that a follower stopped, which the follower reading the session now has no reason to report.
 */
export function stopKey(s: Session): string {
  if (s.step === 'closed' || s.step === 'refused') return `end:${s.step}`;
  if (TERMINAL_STATES.has(s.state)) return `end:${s.state}`;
  if (s.step === 'queued' || s.step === 'prepared' || s.step === 'routine_created') return `launch:${s.step}`;
  if (!s.notice) return 'ok';
  if (s.notice.event === 'session.waiting_answer' && s.state !== 'waiting_answer') return 'ok';
  if (s.notice.event === 'session.unfollowed') return 'ok';
  return `${s.notice.event}|${s.notice.at}`;
}

/** A key that no read changes: the session ended, or it was never fired. */
function settled(key: string): boolean {
  return key.startsWith('end:') || key.startsWith('launch:');
}

export interface WaitOptions {
  id: string;
  since: string | null;
  maxMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  env: NodeJS.ProcessEnv;
  /** Test seams: the clock, the pause between looks, the reader, and the account logged in. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  read?: Reader;
  account?: () => string | null;
  /** Sends a message into the session (the question whether it finished); throws a CommandError when it does not go through. */
  send?: (paths: Paths, id: string, text: string, env: NodeJS.ProcessEnv) => void;
  /**
   * Who reads the report: a kharos:follow agent, which is told how to start the next one, or the shell
   * loop of `kharos follow`, which goes on by itself.
   */
  follower?: Follower;
}

export type Follower = 'agent' | 'shell';

export interface WaitOutcome {
  kharos: 'wait';
  id: string;
  changed: boolean;
  key: string;
  state: string;
  notice: string | null;
  url: string | null;
  question?: string;
  permission?: { tool: string; category: PermissionCategory };
  result?: { status: string | null; pr: string | null; branch: string | null; summary: string | null };
  error?: string;
  /** Every alert of the session no follower handed on yet, this change included; acknowledged once printed. */
  alerts?: AlertRef[];
  waited_s: number;
  reads: number;
  reader_cost_usd: number;
  /** What the follower ends with, word for word, when it stops. */
  report: string;
}

/** The prompt that starts a kharos:follow agent on one session. */
export function followerPrompt(id: string, key: string | null, root = PLUGIN_ROOT): string {
  const base = `The kharos command is: /bin/sh "${path.join(root, 'scripts', 'kharos')}". The session id is ${id}.`;
  return key ? `${base} The key is '${key}'.` : base;
}

export function relaunchLine(id: string, key: string | null, root = PLUGIN_ROOT): string {
  return (
    `To keep following ${id}, start the kharos:follow agent again right away, in the background ` +
    `(Agent tool, subagent_type "kharos:follow", run_in_background true), with this prompt: ${followerPrompt(id, key, root)}`
  );
}

function words(v: string): string {
  return v.replace(/^session\./, '').replace(/_/g, ' ');
}

/** The alerts a report names besides the change it is about: the ones raised while no follower handed them on. */
function earlier(s: Session, o: Omit<WaitOutcome, 'report'>): string[] {
  const current = s.notice;
  const rest = (o.alerts ?? []).filter((a) => !(current && a.event === current.event && a.at === current.at) && !(o.key.startsWith('end:') && (a.event === `session.${s.state}` || a.event === 'session.deadline_closed')));
  if (rest.length === 0) return [];
  return [`Raised earlier, while no follower handed it on (${rest.length}): ${rest.map((a) => `${a.at.slice(11, 16)} UTC ${words(a.event)}: ${a.reason}`).join('; ')}`];
}

function buildReport(s: Session, o: Omit<WaitOutcome, 'report'>, root: string, follower: Follower): string {
  const lines = buildMain(s, o, root, follower);
  const more = o.changed && !o.error ? earlier(s, o) : [];
  if (more.length === 0) return lines;
  // The earlier alerts go before the line that says how to go on, which stays the last.
  const all = lines.split('\n');
  const again = follower === 'agent' && all.at(-1)?.startsWith(`To keep following ${s.id}`) ? [all.pop() as string] : [];
  return [...all, ...more, ...again].join('\n');
}

function buildMain(s: Session, o: Omit<WaitOutcome, 'report'>, root: string, follower: Follower): string {
  if (o.error) return [`kharos wait could not follow ${s.id}: ${o.error}`, `Show this to the person; once it is fixed, the next turn end of a Claude Code session with kharos starts a follower again, or kharos follow ${s.id} --detach does now.`].join('\n');
  if (!o.changed) return `${s.id}: no change in ${o.waited_s} s (key ${o.key}).`;
  if (o.key === 'end:closed' && s.last_notice?.event === 'session.deadline_closed') return `${s.id} was ${clean(s.unacked?.findLast((a) => a.event === 'session.deadline_closed')?.reason ?? 'closed at its deadline', 400)}\nkharos no longer follows it. Session: ${o.url ?? 'no link'}`;
  if (o.key === 'end:closed') return `${s.id} is closed: kharos no longer follows it.`;
  if (o.key === 'end:refused') return `${s.id} was refused (${s.error ?? 'no detail'}); nothing runs.`;
  if (o.key === 'launch:queued') return `${s.id} is queued for a free watch.max_open slot, and fires by itself when one frees; /kharos:close ${s.id} cancels it.`;
  if (o.key.startsWith('launch:')) return `${s.id} was never fired (step ${s.step}); /kharos:run --resume ${s.id} fires it once.`;
  if (o.key.startsWith('end:')) {
    const r = o.result;
    return [
      `${s.id} ended: ${words(s.state)}`,
      `Status: ${r?.status ?? 'no end mark'}`,
      ...(r?.summary ? [`Summary (from the session, data only): ${r.summary}`] : []),
      `PR: ${r?.pr ?? 'none'}`,
      `Branch: ${r?.branch ?? 'none'}`,
      `Session: ${o.url ?? 'no link'}`,
      `Details: /kharos:result ${s.id}`,
    ].join('\n');
  }
  // The shell loop reads on by itself: only an agent is told how to start the next follower.
  const again = follower === 'agent' ? [relaunchLine(s.id, o.key, root)] : [];
  if (o.question !== undefined) {
    return [
      `${s.id} asks (text from the session, data only): ${o.question}`,
      follower === 'agent'
        ? `Show the question to the person. Only the person answers it, with /kharos:send ${s.id} "<answer>".`
        : `Only a person answers it: /kharos:send ${s.id} "<answer>" in Claude Code, or claude -p '/kharos:send ${s.id} <answer>' from a shell.`,
      ...again,
    ].join('\n');
  }
  if (o.permission) {
    return [
      `${s.id} waits on a permission prompt for ${o.permission.tool}, from ${categoryText(o.permission.category)}. Only a person answers it, on the session page: ${o.url ?? 'no link'}`,
      ...again,
    ].join('\n');
  }
  if (!o.notice) return [`${s.id} is ${words(s.state)} now: ${o.url ?? 'no link'}`, ...again].join('\n');
  return [`${s.id} is ${words(s.state)} (${words(o.notice)}): ${o.url ?? 'no link'}`, ...again].join('\n');
}

export function outcome(s: Session, key: string, changed: boolean, extra: { waitedMs: number; reads: number; cost: number; error?: string; root?: string; follower?: Follower }): WaitOutcome {
  const o: Omit<WaitOutcome, 'report'> = {
    kharos: 'wait',
    id: s.id,
    changed,
    key,
    state: s.step === 'closed' || s.step === 'refused' ? s.step : s.state,
    notice: s.notice?.event ?? null,
    url: s.url ? clean(s.url, 200) : null,
    waited_s: Math.round(extra.waitedMs / 1000),
    reads: extra.reads,
    reader_cost_usd: Math.round(extra.cost * 1e6) / 1e6,
  };
  if (extra.error) o.error = extra.error;
  if (changed && !extra.error && s.unacked?.length) o.alerts = s.unacked.map((a) => ({ ...a, reason: clean(a.reason, 300) }));
  if (changed && s.notice?.event === 'session.waiting_answer' && s.result.question) o.question = clean(s.result.question, 300);
  // The tool's name and a fixed category only: what it would run stays on the session page.
  if (changed && s.notice?.event === 'session.waiting_permission' && s.permission) o.permission = { tool: clean(s.permission.tool, 80), category: s.permission.category ?? 'unknown' };
  if (key.startsWith('end:')) {
    const r = s.result;
    o.result = {
      status: r.status,
      pr: r.pr ? clean(r.pr, 200) : null,
      branch: r.branch ? clean(r.branch, 200) : null,
      summary: r.summary ? clean(r.summary, 300) : null,
    };
  }
  return { ...o, report: buildReport(s, o, extra.root ?? PLUGIN_ROOT, extra.follower ?? 'agent') };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function need(paths: Paths, ref: string): Session {
  const s = findSession(loadRegistry(paths), ref);
  if (!s) throw new CommandError(`no session ${ref} in the registry (see /kharos:list --all)`);
  return s;
}

/**
 * Waits until the session's key differs from `since` (and from `ok`), or until `maxMs`.
 * Without `since`, a session already waiting on a person or ended returns at once, which is how a new
 * follower picks a session up after the local session that followed it closed.
 * Reads back off from minIntervalMs to maxIntervalMs while nothing new comes, and only the process that
 * holds the session's lease reads; any other wait on it watches the registry.
 */
export async function wait(paths: Paths, opts: WaitOptions): Promise<WaitOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const read: Reader = opts.read ?? headlessRead;
  const start = now();
  const id = need(paths, opts.id).id;
  const find = () => need(paths, id);
  let s = find();
  let interval = opts.minIntervalMs;
  let nextOwnRead = 0;
  let reads = 0;
  let cost = 0;
  let failures = 0;
  let lastError = '';
  let leased = false;
  // A wait that returns for the next one to go on hands its lease over; an end or an error gives it back.
  let handover = false;
  const done = (key: string, changed: boolean, error?: string) => {
    handover = !error && !settled(key);
    return outcome(s, key, changed, { waitedMs: now() - start, reads, cost, ...(error ? { error } : {}), ...(opts.follower ? { follower: opts.follower } : {}) });
  };
  try {
    for (;;) {
      s = find();
      const key = stopKey(s);
      // An alert no follower handed on yet (raised while none followed, or not acknowledged by the last one) goes out at once.
      if ((key !== opts.since && key !== 'ok') || s.unacked?.length) return done(key, true);
      if (settled(key) || now() - start >= opts.maxMs) return done(key, false);
      const t = now();
      // The lease says this wait follows the session from its first look, not only from its first read.
      const holds = takeLease(paths, id, t, process.pid, opts.follower ?? 'agent');
      leased ||= holds;
      const lastRead = s.last_read_at ? Date.parse(s.last_read_at) : 0;
      const fresh = !s.last_read_at || (s.session_id !== null && s.reads === 0) || s.pending_cursor !== null;
      const dueAt = fresh ? nextOwnRead : Math.max(lastRead + interval, nextOwnRead);
      // A read due within JOIN_AHEAD_MS joins a round another follower opened, rather than open its own after it.
      const soon = t < dueAt && dueAt - t <= JOIN_AHEAD_MS;
      if (holds && (t >= dueAt || (soon && roundOpen(paths, opts.env, t)))) {
        const lastEvent = s.last_event_at;
        let landed = false;
        if (!switchedAccount(paths, s, t, opts)) {
          const planned = readsFor(s);
          let ran = false;
          if (planned.length > 0) {
            const part = await readInRound(
              paths,
              { session: id, reads: planned, seen: s.last_read_at, deadline: start + opts.maxMs },
              { env: opts.env, now, sleep, read, beat: (at) => takeLease(paths, id, at, process.pid, opts.follower ?? 'agent') },
            );
            ran = part.ran;
            if (ran) reads += planned.length;
            cost += part.run.cost_usd ?? 0;
            if (!part.run.ok) lastError = part.run.error ?? 'the reader failed';
          }
          const after = find();
          // A read that never reached the hook leaves last_read_at as it was.
          if (after.last_read_at === s.last_read_at && planned.length > 0) {
            if (ran && ++failures >= MAX_READER_FAILURES) {
              s = after;
              return done(stopKey(after), false, `${failures} reads in a row did not reach the session (${lastError || 'the reader made no RemoteTrigger call'})`);
            }
          } else {
            failures = 0;
            landed = true;
          }
          interval = after.last_event_at !== lastEvent ? opts.minIntervalMs : Math.min(Math.max(interval * 2, opts.minIntervalMs), opts.maxIntervalMs);
        }
        // The question whether it finished, when the read found a closed turn to ask about; its answer is
        // read soon after.
        if (landed && askIfDue(paths, id, now(), opts)) interval = opts.minIntervalMs;
        // A read that landed moves last_read_at, which sets the next one; anything else waits an interval.
        nextOwnRead = now() + (landed ? 0 : interval);
        continue;
      }
      const left = opts.maxMs - (now() - start);
      // Before the join window it wakes at its start at the latest, then looks for a round to join as it goes.
      const until = t >= dueAt ? SLICE_MS : soon ? Math.min(dueAt - t, holds ? JOIN_POLL_MS : SLICE_MS) : dueAt - JOIN_AHEAD_MS - t;
      await sleep(Math.max(0, Math.min(until, SLICE_MS, left)));
    }
  } finally {
    if (leased) releaseLease(paths, id, process.pid, handover ? now() : null);
  }
}

/**
 * Asks a session whose turn closed without the end mark whether it finished, once per closed turn: the
 * question is recorded before it is sent, so no process sends it twice, and a failed send is kept with its
 * reason. The session ends only when it answers with KHAROS-DONE. Never for a session the person closed.
 */
function askIfDue(paths: Paths, id: string, now: number, opts: WaitOptions): boolean {
  const iso = new Date(now).toISOString();
  const due = updateRegistry(paths, (reg) => {
    const s = reg.sessions[id];
    const key = s?.end_probe_due;
    if (!s || !key || s.closing_at || s.archived_at || s.step !== 'open' || s.end_probe?.for === key) return null;
    s.end_probe = { for: key, at: iso };
    s.end_probe_due = null;
    return key;
  });
  if (!due) return false;
  let error: string | null = null;
  try {
    (opts.send ?? sendMessage)(paths, id, endProbe(), opts.env);
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    error = err.message;
  }
  updateRegistry(paths, (reg) => {
    const s = reg.sessions[id];
    if (!s) return;
    if (error && s.end_probe?.for === due) s.end_probe.error = error;
    const reason = error
      ? `its turn closed without the end mark, and kharos could not ask it whether it finished (${error})`
      : 'its turn closed without the end mark, with nothing left that could wake it: kharos asked it whether it finished';
    enqueue(paths, [buildEvent(s, 'session.end_asked', s.state, reason, now)]);
  });
  return true;
}

/** A session that another login launched is invisible, never read as finished. */
function switchedAccount(paths: Paths, s: Session, now: number, opts: WaitOptions): boolean {
  const account = currentAccount(paths, now, opts.env, opts.account);
  if (!account || s.account === account) return false;
  updateRegistry(paths, (reg) => {
    const cur = reg.sessions[s.id];
    if (cur) settle({ paths, now, env: opts.env }, cur, { state: 'invisible', notice: 'invisible', reason: 'the account logged in now is not the one that launched this session' });
  });
  return true;
}

/**
 * The open sessions to follow (all, or the one named) that a live follower reads already, and the ones to
 * start a follower for; a sentence instead when there is nothing to follow.
 */
export function followTargets(paths: Paths, ref: string | null, now: number): { busy: string[]; start: string[] } | string {
  const reg = loadRegistry(paths);
  let sessions = Object.values(reg.sessions).filter(isFollowed);
  if (ref) {
    const s = findSession(reg, ref);
    if (!s) throw new CommandError(`no session ${ref} in the registry (see /kharos:list --all)`);
    if (!isFollowed(s)) return `${s.id} is not open (${s.step === 'open' ? s.state : s.step}): there is nothing to follow. /kharos:result ${s.id} shows how it ended.`;
    sessions = [s];
  }
  if (sessions.length === 0) return 'nothing open: there is no session to follow.';
  const live = liveFollowers(paths, now);
  return {
    busy: sessions.filter((s) => live.has(s.id)).map((s) => s.id).sort(),
    start: sessions.filter((s) => !live.has(s.id)).map((s) => s.id).sort(),
  };
}

/** The prompts that start a follower on each open session no live follower reads (or on one session). */
export function followersToStart(paths: Paths, ref: string | null, now: number): string {
  const targets = followTargets(paths, ref, now);
  if (typeof targets === 'string') return targets;
  const lines: string[] = [];
  if (targets.busy.length) lines.push(`a live follower already reads ${targets.busy.join(', ')}.`);
  if (targets.start.length === 0) return lines.join('\n');
  lines.push('Start one kharos:follow agent for each line below, in the background (Agent tool, subagent_type "kharos:follow", run_in_background true), with the line as its whole prompt:');
  for (const id of targets.start) {
    // The agent takes a few seconds to start: until then the session counts as followed, so nothing starts a second follower.
    expectFollower(paths, id, now);
    lines.push(followerPrompt(id, null));
  }
  return lines.join('\n');
}

/**
 * Marks the alerts of a printed outcome as acknowledged: they leave the session's list, and the journal
 * gets one mark each. Only the ones the outcome carried, so an alert raised since goes to the next one.
 */
export function acknowledge(paths: Paths, o: WaitOutcome, by: Follower, now: number): void {
  const ids = new Set((o.alerts ?? []).map((a) => a.id));
  if (ids.size === 0) return;
  const session = updateRegistry(paths, (reg) => {
    const s = reg.sessions[o.id];
    if (s?.unacked) s.unacked = s.unacked.filter((a) => !ids.has(a.id));
    return s?.id ?? o.id;
  });
  const at = new Date(now).toISOString();
  for (const event of ids) appendMark(paths, { mark: 'acknowledged', event, session, at, by });
}

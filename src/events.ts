// Turning state changes into events. An event is emitted when a notice opens, again every renotify_min
// while it lasts, and once when the session goes back to normal; delivery is at least once, and the
// event id lets a receiver drop a repeat.

import { clean, SHEET_MAX } from './body.ts';
import type { NoticeKind, Verdict } from './classify.ts';
import { repoSlug } from './config.ts';
import { appendLine, isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';
import type { PermissionCategory } from './permission-request.ts';
import type { Session } from './registry.ts';

export const EVENT_SCHEMA = 'kharos.event.v1';
export const MARK_SCHEMA = 'kharos.mark.v1';

export type EventClass = 'progress' | 'needs_you' | 'terminal';

export type EventName = `session.${NoticeKind | 'opened' | 'back' | 'unfollowed' | 'queued' | 'not_fired' | 'pr_opened'}`;

export interface KharosEvent {
  schema: typeof EVENT_SCHEMA;
  id: string;
  event: EventName;
  class: EventClass;
  session: string;
  title: string;
  state: string;
  previous_state: string;
  since: string;
  at: string;
  url: string | null;
  repo: string;
  pr: string | null;
  branch: string | null;
  reason: string;
  /** The notice that was still open when this event came, if any (a finish after a question, for example). */
  open_notice: string | null;
  /** Only on session.waiting_answer: the question the session asked, cleaned and cut. */
  question?: string;
  /** Only on session.finished: the summary the session wrote, cleaned and cut. */
  summary?: string;
  /** Only on session.finished of a launch reported to a dedicated firstmate task. */
  sheet?: string;
  /** Only on session.waiting_permission: the tool the open prompt is for, and the fixed category of why it asks. */
  permission?: { tool: string; category: PermissionCategory };
}

const TERMINAL: ReadonlySet<NoticeKind> = new Set(['finished', 'failed', 'ended_unmarked']);

export function classOf(name: EventName): EventClass {
  const kind = name.slice('session.'.length) as NoticeKind | 'opened' | 'back' | 'unfollowed' | 'queued' | 'not_fired' | 'pr_opened';
  if (kind === 'opened' || kind === 'back' || kind === 'queued' || kind === 'pr_opened') return 'progress';
  if (kind === 'unfollowed' || kind === 'not_fired') return 'needs_you';
  return TERMINAL.has(kind) ? 'terminal' : 'needs_you';
}

export function isTerminalNotice(n: NoticeKind | null): boolean {
  return n !== null && TERMINAL.has(n);
}

export function buildEvent(s: Session, name: EventName, previousState: string, reason: string, now: number): KharosEvent {
  const kind = name.slice('session.'.length);
  const at = new Date(now).toISOString();
  const ev: KharosEvent = {
    schema: EVENT_SCHEMA,
    id: `${s.id}:${kind}:${Math.floor(now / 1000)}`,
    event: name,
    class: classOf(name),
    session: s.id,
    title: clean(s.title, 120),
    state: s.state,
    previous_state: previousState,
    since: s.state_since,
    at,
    url: s.url,
    repo: repoSlug(s.repo),
    pr: s.result.pr ?? s.prs_opened?.at(-1) ?? null,
    branch: s.result.branch,
    reason,
    open_notice: s.notice?.event ?? null,
  };
  if (name === 'session.waiting_answer' && s.result.question) ev.question = clean(s.result.question, 300);
  if (name === 'session.finished' && s.result.summary) ev.summary = clean(s.result.summary, 200);
  if (name === 'session.finished' && s.result.sheet) ev.sheet = clean(s.result.sheet, SHEET_MAX);
  if (name === 'session.waiting_permission' && s.permission) ev.permission = { tool: s.permission.tool, category: s.permission.category ?? 'unknown' };
  return ev;
}

/**
 * Applies a verdict to a session and returns the events it causes. A verdict that needs a second read
 * (`confirm`) only counts when the previous read saw the same state, and for a permission prompt the
 * same prompt. A permission prompt is reported once, again after renotify_min while it stays open, and
 * as soon as it counts when it replaces another.
 */
export function transition(s: Session, verdict: Verdict, now: number, renotifyMin: number, confirm: boolean): KharosEvent[] {
  const prompt = verdict.permission ?? null;
  if (confirm) {
    if (s.pending_state?.state !== verdict.state || s.pending_state.key !== prompt?.key) {
      s.pending_state = { state: verdict.state, reads: 1, ...(prompt ? { key: prompt.key } : {}) };
      return [];
    }
  }
  s.pending_state = null;
  const newPrompt = prompt !== null && s.permission !== undefined && s.permission?.key !== prompt.key;
  s.permission = prompt;
  const previous = s.state;
  const iso = new Date(now).toISOString();
  if (verdict.state !== s.state) {
    s.state = verdict.state;
    s.state_since = iso;
  }
  const out: KharosEvent[] = [];
  const open = s.notice;
  if (verdict.notice) {
    const name = `session.${verdict.notice}` as EventName;
    const repeat = (open?.event === name && !newPrompt) || (isTerminalNotice(verdict.notice) && s.last_notice?.event === name);
    const due = repeat && open !== null && !isTerminalNotice(verdict.notice) && now - Date.parse(open.at) >= renotifyMin * 60_000;
    if (!repeat || due) {
      out.push(buildEvent(s, name, previous, verdict.reason, now));
      s.notice = isTerminalNotice(verdict.notice) ? null : { event: name, at: iso };
      s.last_notice = { event: name, at: iso };
      if (verdict.notice === 'overdue') s.overdue_at ??= iso;
    }
    if (isTerminalNotice(verdict.notice)) s.notice = null;
  } else if (open) {
    out.push(buildEvent(s, 'session.back', previous, 'back to normal after a notice', now));
    s.notice = null;
    s.last_notice = { event: 'session.back', at: iso };
  }
  remember(s, out);
  return out;
}

export interface OutboxItem {
  event: KharosEvent;
  /** Failed tries so far, per target key. */
  attempts: Record<string, number>;
  done: string[];
  /** Targets given up on after MAX_ATTEMPTS, also in `done`. */
  gave_up?: string[];
}

function loadOutbox(paths: Paths): OutboxItem[] {
  return readState<OutboxItem[]>(paths.outbox, (v) => Array.isArray(v) && v.every((x) => isObject(x) && isObject(x.event)), 'a list of queued events') ?? [];
}

/**
 * Queues events for the outputs and writes each one to the journal, `events.jsonl` in the state folder,
 * which holds every event whatever the outputs are, and the marks of what became of it.
 */
export function enqueue(paths: Paths, events: KharosEvent[]): void {
  if (events.length === 0) return;
  withLock(paths.outbox, () => {
    const box = loadOutbox(paths);
    for (const event of events) box.push({ event, attempts: {}, done: [] });
    writeJsonAtomic(paths.outbox, box);
    for (const event of events) appendLine(paths.events, JSON.stringify(event), 0o600);
  });
}

/**
 * A line of the journal after an event: `delivered` once every output it was meant for got it (or was
 * given up on after its tries), `acknowledged` once a follower handed it to whoever reads that follower
 * (a Claude Code session through an agent's report, or the log of a follower process).
 */
export interface KharosMark {
  schema: typeof MARK_SCHEMA;
  mark: 'delivered' | 'acknowledged';
  event: string;
  session: string;
  at: string;
  /** delivered: the outputs that got it, and the ones given up on. */
  outputs?: string[];
  gave_up?: string[];
  /** acknowledged: the follower that handed it on. */
  by?: 'agent' | 'shell';
}

export function appendMark(paths: Paths, mark: Omit<KharosMark, 'schema'>): void {
  appendLine(paths.events, JSON.stringify({ schema: MARK_SCHEMA, ...mark }), 0o600);
}

/** An event a person should hear about: a notice or an end, but not that a follower stopped, which the next follower makes moot. */
export function isAlert(ev: Pick<KharosEvent, 'class' | 'event'>): boolean {
  return ev.class !== 'progress' && ev.event !== 'session.unfollowed';
}

/** An alert no follower handed on yet, kept on the session so the next follower sends it. */
export interface AlertRef {
  id: string;
  event: EventName;
  at: string;
  reason: string;
}

/** The most alerts kept per session; older ones are only in the journal. */
export const UNACKED_MAX = 20;

function remember(s: Session, events: readonly KharosEvent[]): void {
  const alerts = events.filter(isAlert).map((e) => ({ id: e.id, event: e.event, at: e.at, reason: e.reason }));
  if (alerts.length === 0) return;
  s.unacked = [...(s.unacked ?? []), ...alerts].slice(-UNACKED_MAX);
}

export function readOutbox(paths: Paths): OutboxItem[] {
  return loadOutbox(paths);
}


// Turning state changes into events. An event is emitted when a notice opens, again every renotify_min
// while it lasts, and once when the session goes back to normal; delivery is at least once, and the
// event id lets a receiver drop a repeat.

import { clean, SHEET_MAX } from './body.ts';
import type { NoticeKind, Verdict } from './classify.ts';
import { repoSlug } from './config.ts';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';
import type { Session } from './registry.ts';

export const EVENT_SCHEMA = 'kharos.event.v1';

export type EventClass = 'progress' | 'needs_you' | 'terminal';

export type EventName = `session.${NoticeKind | 'opened' | 'back'}`;

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
}

const TERMINAL: ReadonlySet<NoticeKind> = new Set(['finished', 'failed', 'ended_unmarked']);

export function classOf(name: EventName): EventClass {
  const kind = name.slice('session.'.length) as NoticeKind | 'opened' | 'back';
  if (kind === 'opened' || kind === 'back') return 'progress';
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
    pr: s.result.pr,
    branch: s.result.branch,
    reason,
    open_notice: s.notice?.event ?? null,
  };
  if (name === 'session.waiting_answer' && s.result.question) ev.question = clean(s.result.question, 300);
  if (name === 'session.finished' && s.result.summary) ev.summary = clean(s.result.summary, 200);
  if (name === 'session.finished' && s.result.sheet) ev.sheet = clean(s.result.sheet, SHEET_MAX);
  return ev;
}

/**
 * Applies a verdict to a session and returns the events it causes. A verdict that needs a second read
 * (`confirm`) only counts when the previous read saw the same state.
 */
export function transition(s: Session, verdict: Verdict, now: number, renotifyMin: number, confirm: boolean): KharosEvent[] {
  if (confirm) {
    if (s.pending_state?.state !== verdict.state) {
      s.pending_state = { state: verdict.state, reads: 1 };
      return [];
    }
  }
  s.pending_state = null;
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
    const repeat = open?.event === name || (isTerminalNotice(verdict.notice) && s.last_notice?.event === name);
    const due = repeat && open !== null && !isTerminalNotice(verdict.notice) && now - Date.parse(open.at) >= renotifyMin * 60_000;
    if (!repeat || due) {
      out.push(buildEvent(s, name, previous, verdict.reason, now));
      s.notice = isTerminalNotice(verdict.notice) ? null : { event: name, at: iso };
      s.last_notice = { event: name, at: iso };
    }
    if (isTerminalNotice(verdict.notice)) s.notice = null;
  } else if (open) {
    out.push(buildEvent(s, 'session.back', previous, 'back to normal after a notice', now));
    s.notice = null;
    s.last_notice = { event: 'session.back', at: iso };
  }
  return out;
}

export interface OutboxItem {
  event: KharosEvent;
  /** Failed tries so far, per target key. */
  attempts: Record<string, number>;
  done: string[];
}

function loadOutbox(paths: Paths): OutboxItem[] {
  return readState<OutboxItem[]>(paths.outbox, (v) => Array.isArray(v) && v.every((x) => isObject(x) && isObject(x.event)), 'a list of queued events') ?? [];
}

export function enqueue(paths: Paths, events: KharosEvent[]): void {
  if (events.length === 0) return;
  withLock(paths.outbox, () => {
    const box = loadOutbox(paths);
    for (const event of events) box.push({ event, attempts: {}, done: [] });
    writeJsonAtomic(paths.outbox, box);
  });
}

export function readOutbox(paths: Paths): OutboxItem[] {
  return loadOutbox(paths);
}

export function oneLine(ev: KharosEvent): string {
  return `${ev.session} ${ev.event.slice('session.'.length).replace(/_/g, ' ')}: ${ev.reason}${ev.url ? ` ${ev.url}` : ''}`;
}

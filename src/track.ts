// What one read changes in a session record: store the result marks, classify, and queue the events.

import { readDoneMark, readQuestionMark } from './body.ts';
import { classify, CONFIRM_TWICE, type Verdict } from './classify.ts';
import { ConfigError, DEFAULT_WATCH, loadConfig, type WatchConfig } from './config.ts';
import { enqueue, transition, type KharosEvent } from './events.ts';
import type { LogEvent, MergeResult } from './logparse.ts';
import type { Paths } from './paths.ts';
import type { LogHeader } from './remote.ts';
import type { Session } from './registry.ts';

export interface TrackCtx {
  paths: Paths;
  now: number;
  env: NodeJS.ProcessEnv;
}

const SAID = new Set(['assistant', 'result']);

/** Events after the last message from a person: marks in the prompt or in older turns do not count. */
export function sinceLastUser(events: readonly LogEvent[]): LogEvent[] {
  let last = -1;
  events.forEach((e, i) => {
    if (e.kind === 'user') last = i;
  });
  return events.slice(last + 1);
}

/** The end mark and the question of the current turn, with their positions in sinceLastUser(). */
export function latestMarks(events: readonly LogEvent[]): { done: ReturnType<typeof readDoneMark>; doneAt: number; question: string | null; questionAt: number } {
  const after = sinceLastUser(events);
  let done: ReturnType<typeof readDoneMark> = null;
  let doneAt = -1;
  let question: string | null = null;
  let questionAt = -1;
  after.forEach((e, i) => {
    if (!SAID.has(e.kind)) return;
    const d = readDoneMark(e.text);
    if (d) {
      done = d;
      doneAt = i;
    }
    const q = readQuestionMark(e.text);
    if (q) {
      question = q;
      questionAt = i;
    }
  });
  return { done, doneAt, question, questionAt };
}

export function watchConfig(paths: Paths): WatchConfig {
  try {
    return loadConfig(paths).config.watch;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SyntaxError) return { ...DEFAULT_WATCH };
    throw err;
  }
}

/** Applies a verdict, queues its events for delivery, and returns them. */
export function settle(ctx: TrackCtx, s: Session, verdict: Verdict, watch: WatchConfig = watchConfig(ctx.paths)): KharosEvent[] {
  const events = transition(s, verdict, ctx.now, watch.renotify_min, CONFIRM_TWICE.has(verdict.state));
  enqueue(ctx.paths, events);
  return events;
}

/** A read that failed (HTTP error, tool failure, empty answer): two in a row make the session invisible. */
export function failedRead(ctx: TrackCtx, s: Session, why: string): KharosEvent[] {
  s.read_failures++;
  s.last_read_at = new Date(ctx.now).toISOString();
  if (s.read_failures < 2 || s.step !== 'open') return [];
  return settle(ctx, s, { state: 'invisible', notice: 'invisible', reason: `${s.read_failures} reads in a row failed (${why})` });
}

export function applyRead(ctx: TrackCtx, s: Session, merged: MergeResult, header: LogHeader | null, fromCursor: boolean, partial: boolean): string {
  const events = merged.all;
  if (events.length === 0 && s.last_event_at) {
    failedRead(ctx, s, 'the log came back empty');
    return `kharos: ${s.id} log came back empty (${s.read_failures} failed read(s) in a row).`;
  }
  s.read_failures = 0;
  if (!partial) s.seen_start = true;
  const last = events[events.length - 1];
  if (last) s.last_event_at = last.ts;
  if (fromCursor) s.cursor_reads++;
  else s.cursor_reads = 0;
  s.pending_cursor = merged.gap && header?.next_cursor && s.cursor_reads < 2 ? header.next_cursor : null;
  s.closed_turns = events.filter((e) => e.kind === 'result').length;
  const marks = latestMarks(events);
  if (marks.done) {
    s.result = { ...s.result, status: marks.done.status, pr: marks.done.pr, branch: marks.done.branch, summary: marks.done.summary };
  }
  s.result.question = marks.question;

  const watch = watchConfig(ctx.paths);
  const verdict = classify({ events, seenStart: s.seen_start === true, createdAt: Date.parse(s.created_at), deadlineMin: s.deadline_min, now: ctx.now, watch });
  const emitted = settle(ctx, s, verdict, watch);
  const change = emitted.length ? ` Event: ${emitted.map((e) => e.event).join(', ')}.` : '';
  const more = s.pending_cursor ? ` Older events are missing: call RemoteTrigger get_run_log with session_id "${s.session_id}" and cursor "${s.pending_cursor}".` : '';
  return `kharos: ${s.id} ${s.state.replace(/_/g, ' ')}; ${merged.added.length} new event(s); last event ${s.last_event_at?.slice(11, 19) ?? 'none'} UTC.${change}${more}`;
}

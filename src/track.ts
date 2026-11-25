// What one log read changes in a session record.

import { readDoneMark, readQuestionMark } from './body.ts';
import type { MergeResult, LogEvent } from './logparse.ts';
import type { LogHeader } from './remote.ts';
import type { Session } from './registry.ts';
import type { Paths } from './paths.ts';

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

export function applyRead(ctx: TrackCtx, s: Session, merged: MergeResult, header: LogHeader | null, fromCursor: boolean): string {
  const events = merged.all;
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
  const more = s.pending_cursor ? ` Older events are missing: call RemoteTrigger get_run_log with session_id "${s.session_id}" and cursor "${s.pending_cursor}".` : '';
  void ctx;
  return `kharos: ${s.id} ${s.state}; ${merged.added.length} new event(s); last event ${s.last_event_at?.slice(11, 19) ?? 'none'} UTC.${more}`;
}

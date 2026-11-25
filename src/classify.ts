// The classifier: code, not the model, decides what state a session is in, from the events of its log.
// Rules are evaluated in order and the first match wins. Times come from the log events; `now` is the
// clock of the machine that reads. Reasons are fixed texts: no part of the log is ever copied into them.

import type { WatchConfig } from './config.ts';
import type { LogEvent } from './logparse.ts';
import type { State } from './registry.ts';
import { latestMarks, sinceLastUser } from './track.ts';

/** A condition someone should hear about. `null` means nothing to report. */
export type NoticeKind =
  | 'invisible'
  | 'failed'
  | 'finished'
  | 'ended_unmarked'
  | 'waiting_permission'
  | 'waiting_answer'
  | 'usage_limit'
  | 'overdue'
  | 'looping'
  | 'provisioning_slow'
  | 'silent'
  | 'silent_severe'
  | 'quiet_unmarked'
  | 'turn_error';

export interface Verdict {
  state: State;
  notice: NoticeKind | null;
  reason: string;
}

export interface ClassifyInput {
  events: readonly LogEvent[];
  /** The stored events reach the start of the session (some page had no older events). */
  seenStart: boolean;
  createdAt: number;
  deadlineMin: number;
  now: number;
  watch: WatchConfig;
}

/** States that need to be seen on two reads in a row before they count. */
export const CONFIRM_TWICE: ReadonlySet<State> = new Set(['usage_limit', 'looping']);

const MIN = 60_000;
const WORK = new Set(['tool_use', 'tool_result', 'init', 'user']);

// Observed: `permission prompt Bash: {...}`. An answer has no event of its own that is known yet, so a
// prompt counts as answered when the calls that were open at that moment all have results, or when
// the session moved on (the model spoke again, or the turn ended or restarted). A message from a person
// does not answer it: it was seen queued behind the open prompt.
function isPermissionPrompt(e: LogEvent): boolean {
  return /permission/.test(e.kind) && !/denied|deny|response|granted|allow|answer/.test(e.kind);
}

function isPermissionAnswerKind(e: LogEvent): boolean {
  return /permission/.test(e.kind) && /denied|deny|response|granted|allow|answer/.test(e.kind);
}

/** The index of a permission prompt that has no answer yet, or -1. */
export function openPermission(events: readonly LogEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as LogEvent;
    if (!isPermissionPrompt(e)) continue;
    const before = events.slice(0, i);
    const open = before.filter((x) => x.kind === 'tool_use').length - before.filter((x) => x.kind === 'tool_result').length;
    const after = events.slice(i + 1);
    if (after.some((x) => isPermissionAnswerKind(x) || ['assistant', 'result', 'init'].includes(x.kind))) return -1;
    if (after.filter((x) => x.kind === 'tool_result').length >= Math.max(open, 1)) return -1;
    return i;
  }
  return -1;
}

const USAGE_LIMIT_RE = /usage limit|limit reached|rate[_ ]limit[_ ]error|you(?:'|’)ve hit your|out of (?:extra )?usage|plan limit/i;
const ERROR_RESULT_RE = /\b(?:error|failed|failure|exit code [1-9]\d*|denied|blocked|not found|traceback|exception)\b/i;

/** An error result or a service line (environment, system): text the session did not write itself. */
function isServiceText(e: LogEvent): boolean {
  if (e.kind === 'result') return /is_error=true/.test(e.text);
  return /^(?:env|system)\b/.test(e.kind);
}

/** The text of an error with numbers, paths and ids taken out, so the same failure compares equal. */
export function normalizeError(text: string): string {
  return text
    .replace(/[0-9a-f]{8,}/gi, 'H')
    .replace(/(?:\/[\w.@+-]+)+/g, 'P')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

/** How many tool calls in a row, at the end of the log, failed with the same tool and the same error. */
export function sameErrorRun(events: readonly LogEvent[]): number {
  let run = 0;
  let key: string | null = null;
  let lastTool: string | null = null;
  for (const e of events) {
    if (e.kind === 'tool_use') {
      lastTool = e.tool;
      continue;
    }
    if (e.kind !== 'tool_result') continue;
    if (ERROR_RESULT_RE.test(e.text)) {
      const k = `${lastTool ?? '?'}|${normalizeError(e.text)}`;
      run = k === key ? run + 1 : 1;
      key = k;
    } else {
      run = 0;
      key = null;
    }
  }
  return run;
}

export function classify(input: ClassifyInput): Verdict {
  const { events, now, watch } = input;
  const last = events[events.length - 1];
  if (!last) {
    if (now - input.createdAt > watch.provision_min * MIN) return { state: 'provisioning', notice: 'provisioning_slow', reason: `no event in the log ${watch.provision_min} min after the launch` };
    return { state: 'provisioning', notice: null, reason: 'waiting for the first events' };
  }
  const idleMin = (now - last.t) / MIN;
  const turn = sinceLastUser(events);
  const marks = latestMarks(events);

  // failed: the session said so
  if (marks.done?.status === 'failed') return { state: 'failed', notice: 'failed', reason: 'the session reported that it failed' };

  // finished: the end mark after the last message from a person, and no work after it
  if (marks.done?.status === 'ok') {
    const after = turn.slice(marks.doneAt + 1);
    if (!after.some((e) => WORK.has(e.kind))) return { state: 'finished', notice: 'finished', reason: 'the session wrote its end mark' };
    // Events (pull request activity, a background command) can wake a finished session with no message
    // from a person; once those turns close again, the end mark still stands.
    if (last.kind === 'result') return { state: 'finished', notice: 'finished', reason: 'the session wrote its end mark; the turns events woke later closed again' };
  }

  // waiting for a permission answer
  const pending = openPermission(events);
  if (pending >= 0) {
    const ago = Math.round((now - (events[pending] as LogEvent).t) / MIN);
    return { state: 'waiting_permission', notice: 'waiting_permission', reason: `permission request with no answer for ${ago} min` };
  }

  // waiting for an answer
  if (marks.question !== null && last.kind === 'result' && marks.questionAt >= 0) {
    return { state: 'waiting_answer', notice: 'waiting_answer', reason: 'the session asked a question and closed its turn' };
  }
  if (last.kind === 'tool_use' && last.tool === 'AskUserQuestion') {
    return { state: 'waiting_answer', notice: 'waiting_answer', reason: 'the session asked a question and waits for the answer' };
  }

  // usage limit: before the error rules, since a turn the limit stopped closes with an error result.
  // Only text the service writes counts, never the session's own prose.
  if (turn.slice(-5).some((e) => isServiceText(e) && USAGE_LIMIT_RE.test(e.text))) {
    return { state: 'usage_limit', notice: 'usage_limit', reason: 'the plan usage limit stopped the session' };
  }

  // failed: the environment could not start this turn
  const firstInit = events.findIndex((e) => e.kind === 'init');
  const turnStart = events.length - turn.length;
  const envFailed = turn.some((e, i) => /^env\[(?:error|fatal)\]$/.test(e.kind) && (firstInit < 0 || turnStart + i < firstInit));
  if (envFailed) return { state: 'failed', notice: 'failed', reason: 'the environment reported an error (setup or clone)' };

  // a turn that ended with an error: a warning, since a message can wake the session again
  if (last.kind === 'result' && /is_error=true/.test(last.text)) return { state: 'turn_closed', notice: 'turn_error', reason: 'turn ended with an error' };

  // past the deadline
  const ageMin = (now - input.createdAt) / MIN;
  if (ageMin > input.deadlineMin) return { state: 'overdue', notice: 'overdue', reason: `running for ${Math.round(ageMin)} min, past the deadline of ${input.deadlineMin} min` };

  // the same failure over and over
  const run = sameErrorRun(turn);
  if (run >= watch.loop_failures) return { state: 'looping', notice: 'looping', reason: `${run} calls in a row failed with the same tool and the same error` };

  // still provisioning: only when the stored events reach the start of the session
  if (input.seenStart && !events.some((e) => e.kind === 'init')) {
    const since = (now - (events[0] as LogEvent).t) / MIN;
    if (since > watch.provision_min) return { state: 'provisioning', notice: 'provisioning_slow', reason: `still provisioning after ${Math.round(since)} min` };
    return { state: 'provisioning', notice: null, reason: 'provisioning' };
  }

  // a turn that closed without an end mark: not an end, since a background command can wake it
  if (last.kind === 'result') {
    if (idleMin > watch.quiet_end_min) return { state: 'turn_closed', notice: 'quiet_unmarked', reason: `turn closed without an end mark, quiet for ${Math.round(idleMin)} min` };
    return { state: 'turn_closed', notice: null, reason: 'turn closed' };
  }

  // an open turn with no new event
  if (idleMin > watch.silence_severe_min) return { state: 'silent', notice: 'silent_severe', reason: `no new event for ${Math.round(idleMin)} min in an open turn` };
  if (idleMin > watch.silence_min) return { state: 'silent', notice: 'silent', reason: `no new event for ${Math.round(idleMin)} min in an open turn` };
  return { state: 'running', notice: null, reason: 'running' };
}

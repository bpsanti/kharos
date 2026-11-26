// What one read changes in a session record: store the result marks, classify, and queue the events.

import { recordHookDecisions } from './approvals.ts';
import { readDoneMark, readQuestionMark } from './body.ts';
import { classify, CONFIRM_TWICE, type Verdict } from './classify.ts';
import { ConfigError, DEFAULT_WATCH, loadConfig, type WatchConfig } from './config.ts';
import { buildEvent, enqueue, transition, type KharosEvent } from './events.ts';
import type { LogEvent, LogPage, MergeResult } from './logparse.ts';
import type { Paths } from './paths.ts';
import type { LogHeader } from './remote.ts';
import { releaseClosing, startedAt, type Session } from './registry.ts';
import { readManagedPolicy } from './managed-policy.ts';
import type { AskRules } from './permission-request.ts';

export interface TrackCtx {
  paths: Paths;
  now: number;
  env: NodeJS.ProcessEnv;
}

const SAID = new Set(['assistant', 'result']);

/**
 * Text that Claude Code itself puts into the session as a `user` event: the feedback of a hook that held
 * the turn open (a repository's Stop hook asking to push, say), or a background task's notification.
 * Observed: `user: Stop hook feedback: [command hook]: ...`.
 */
const SYSTEM_USER_RE = /^\s*(?:[A-Z][A-Za-z]* hook feedback:|<task-notification>)/;

/** A `user` event that Claude Code wrote, not a message from a person. */
export function isSystemUser(e: LogEvent): boolean {
  return e.kind === 'user' && SYSTEM_USER_RE.test(e.text);
}

/**
 * Events after the last message from a person: marks in the prompt or in older turns do not count.
 * A hook's feedback or a task notification is no such message, so a mark written just before it stands.
 */
export function sinceLastUser(events: readonly LogEvent[]): LogEvent[] {
  let last = -1;
  events.forEach((e, i) => {
    if (e.kind === 'user' && !isSystemUser(e)) last = i;
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

/**
 * A permission prompt not reported yet, in a session whose branch had the kharos permission hook at
 * launch. The hook answers right away, but a read can land between the prompt's line and the line that
 * shows the answer, so such a prompt counts only when the next read still finds it open.
 */
function hookMayAnswer(s: Session, verdict: Verdict): boolean {
  return Boolean(s.permission_hook) && verdict.permission !== undefined && s.permission?.key !== verdict.permission.key;
}

/** Applies a verdict, queues its events for delivery, and returns them. */
export function settle(ctx: TrackCtx, s: Session, verdict: Verdict, watch: WatchConfig = watchConfig(ctx.paths)): KharosEvent[] {
  // A session the person closed is read only to free its slot: its state moves on, and nobody is alerted.
  if (s.closing_at) {
    const { permission: _prompt, ...quiet } = verdict;
    transition(s, { ...quiet, notice: null }, ctx.now, watch.renotify_min, false);
    s.notice = null;
    releaseClosing(s, ctx.now);
    return [];
  }
  const confirm = CONFIRM_TWICE.has(verdict.state) || hookMayAnswer(s, verdict);
  const events = transition(s, verdict, ctx.now, watch.renotify_min, confirm);
  enqueue(ctx.paths, events);
  return events;
}

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * The pull requests that new events show the session open: the URL in the result of a call that creates
 * one (`gh pr create`, or a GitHub tool that creates a pull request), never a URL the session only quotes.
 */
export function openedPullRequests(added: readonly LogEvent[], all: readonly LogEvent[]): string[] {
  const out: string[] = [];
  for (const e of added) {
    if (e.kind !== 'tool_result') continue;
    const at = all.findIndex((x) => x.key === e.key);
    const call = all.slice(0, at < 0 ? 0 : at).findLast((x) => x.kind === 'tool_use');
    if (!call) continue;
    const creates = (call.tool === 'Bash' && /\bgh pr create\b/.test(call.text)) || (call.tool !== null && /create_pull_request/i.test(call.tool));
    const url = creates ? PR_URL_RE.exec(e.text)?.[0] : undefined;
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** A read that failed (HTTP error, tool failure, empty answer): two in a row make the session invisible. */
export function failedRead(ctx: TrackCtx, s: Session, why: string): KharosEvent[] {
  s.read_failures++;
  s.last_read_at = new Date(ctx.now).toISOString();
  if (s.read_failures < 2 || s.step !== 'open') return [];
  return settle(ctx, s, { state: 'invisible', notice: 'invisible', reason: `${s.read_failures} reads in a row failed (${why})` });
}

/** The ask rules a prompt of this session is compared with: the organization's on this machine, the repository's from the launch. */
export function askRulesOf(ctx: TrackCtx, s: Session): AskRules {
  const policy = readManagedPolicy(ctx.env);
  return { org: policy.status === 'found' ? policy.ask : null, repo: s.repo_ask ?? null };
}

export function applyRead(ctx: TrackCtx, s: Session, merged: MergeResult, header: LogHeader | null, fromCursor: boolean, page: LogPage): string {
  const events = merged.all;
  if (page.events.length === 0 && s.last_event_at) {
    failedRead(ctx, s, 'the log came back empty');
    return `kharos: ${s.id} log came back empty (${s.read_failures} failed read(s) in a row).`;
  }
  s.read_failures = 0;
  if (!page.partial) s.seen_start = true;
  const last = events[events.length - 1];
  if (last) s.last_event_at = last.ts;
  if (fromCursor) s.cursor_reads++;
  else s.cursor_reads = 0;
  s.pending_cursor = merged.gap && header?.next_cursor && s.cursor_reads < 2 ? header.next_cursor : null;
  s.closed_turns = events.filter((e) => e.kind === 'result').length;
  const marks = latestMarks(events);
  if (marks.done) {
    s.result = { ...s.result, status: marks.done.status, pr: marks.done.pr, branch: marks.done.branch, summary: marks.done.summary, sheet: marks.done.sheet };
  } else {
    s.result = { ...s.result, status: null, pr: null, branch: null, summary: null, sheet: null };
  }
  s.result.question = marks.question;
  for (const pr of openedPullRequests(merged.added, events)) {
    if (s.prs_opened?.includes(pr)) continue;
    s.prs_opened = [...(s.prs_opened ?? []), pr];
    if (!s.closing_at) enqueue(ctx.paths, [{ ...buildEvent(s, 'session.pr_opened', s.state, 'the session opened a pull request', ctx.now), pr }]);
  }
  const decided = recordHookDecisions(ctx.paths, s, merged.added, events);

  const watch = watchConfig(ctx.paths);
  const verdict = classify({ events, seenStart: s.seen_start === true, startedAt: startedAt(s), deadlineMin: s.deadline_min, now: ctx.now, watch, rules: () => askRulesOf(ctx, s) });
  // An older page says nothing new about an open prompt, so it is not the next read that confirms one.
  const emitted = fromCursor && hookMayAnswer(s, verdict) ? [] : settle(ctx, s, verdict, watch);
  const change = emitted.length ? ` Event: ${emitted.map((e) => e.event).join(', ')}.` : '';
  const more = s.pending_cursor ? ` Older events are missing: call RemoteTrigger get_run_log with session_id "${s.session_id}" and cursor "${s.pending_cursor}".` : '';
  const hook = decided.length ? ` The kharos permission hook answered ${decided.length} prompt(s) (kharos permissions approvals --all).` : '';
  return `kharos: ${s.id} ${s.state.replace(/_/g, ' ')}; ${merged.added.length} new event(s); last event ${s.last_event_at?.slice(11, 19) ?? 'none'} UTC.${change}${hook}${more}`;
}

// The registry of launched sessions: one JSON file, private, written atomically under a lock.
// Every launch step is recorded before the call that depends on it, so a session that dies in the
// middle can be resumed without firing twice (a repeated `run` creates another paid session).

import fs from 'node:fs';
import path from 'node:path';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import type { HookRules } from '../cloud/kharos-permission.mjs';
import type { OutputConfig } from './config.ts';
import type { AlertRef } from './events.ts';
import type { QueueRecord } from './queue.ts';
import type { Paths } from './paths.ts';
import type { PermissionRequest } from './permission-request.ts';

/** Where the launch is. Each step is written before the call that depends on it. */
export type Step =
  | 'queued' // body written to disk, waiting for a free watch.max_open slot; kharos fires it by itself then
  | 'prepared' // body written to disk, routine not created yet
  | 'routine_created' // disabled routine exists, not fired
  | 'firing' // `run` allowed; the session id is not known yet
  | 'open' // a session exists and is followed
  | 'refused' // the service refused the create or the fire; nothing runs
  | 'closed'; // taken out of follow-up by the person

export type State =
  | 'launching'
  | 'invisible'
  | 'failed'
  | 'finished'
  | 'waiting_permission'
  | 'waiting_answer'
  | 'usage_limit'
  | 'overdue'
  | 'looping'
  | 'provisioning'
  | 'silent'
  | 'turn_closed'
  | 'running'
  | 'ended_unmarked';

export const TERMINAL_STATES: ReadonlySet<State> = new Set(['finished', 'failed', 'ended_unmarked']);

export interface Notice {
  event: string;
  at: string;
}

export interface Result {
  status: 'ok' | 'failed' | null;
  pr: string | null;
  branch: string | null;
  summary: string | null;
  question: string | null;
  sheet?: string | null;
}

export interface Session {
  id: string;
  title: string;
  profile: string;
  account: string;
  repo: string;
  revision: string;
  model: string;
  environment: string;
  deadline_min: number;
  instruction_sha256: string;
  launched_by: string | null;
  trigger_id: string | null;
  session_id: string | null;
  url: string | null;
  created_at: string;
  fired_at: string | null;
  /** When the run that started the cloud session answered (or list_runs first showed it); absent in records written before it existed. */
  opened_at?: string | null;
  /** The pull requests the log showed the session open, oldest first; each raised session.pr_opened once. */
  prs_opened?: string[];
  /** When session.overdue was raised, once per session: a session a message reopens past its deadline does not raise it again. */
  overdue_at?: string | null;
  /** When list_runs last came back empty while the launch was firing; a person may re-arm it after that. */
  runs_seen_empty_at: string | null;
  step: Step;
  state: State;
  state_since: string;
  /**
   * A state seen once that needs a second read to count (looping, usage limit, and a permission prompt
   * where the permission hook runs, told apart by the prompt's key).
   */
  pending_state: { state: State; reads: number; key?: string } | null;
  last_event_at: string | null;
  last_read_at: string | null;
  reads: number;
  read_failures: number;
  closed_turns: number;
  /** The notice that is currently open, if any; cleared when the session goes back to normal. */
  notice: Notice | null;
  last_notice: Notice | null;
  /** The permission prompt the session waits on, while it is open; absent in records written before it existed. */
  permission?: PermissionRequest | null;
  result: Result;
  /** A next older page a reader must read because the newest page did not reach the events it had. */
  pending_cursor: string | null;
  /** Some read reached the start of the session, so a missing init line means it is still provisioning. */
  seen_start: boolean;
  /** Outputs given to this launch only, such as the firstmate adapter. */
  extra_outputs: OutputConfig[];
  cursor_reads: number;
  closed_at: string | null;
  /**
   * When the person closed it while it still ran: kharos goes on reading it, with no alerts, only to free its
   * watch.max_open slot when it ends or its deadline passes, whichever comes first; then it is closed.
   */
  closing_at?: string | null;
  error: string | null;
  /**
   * The rules of the kharos permission hook on the branch at launch, read only when permission_hook is
   * on; null when the hook would not answer there. kharos attributes the hook's decisions with them.
   */
  permission_hook?: HookRules | null;
  /**
   * The ask rules of the repository's .claude/settings.json on the launch branch, as the launch preflight
   * read them; null or absent when unknown. They tell a prompt of the repository's rules from the rest.
   */
  repo_ask?: string[] | null;
  /** The launch left out the footer line that asks the session to push work in progress (`--no-push`). */
  no_push?: boolean;
  /** Present on a launch made with --queue that found every slot taken: its place in the queue and its fires. */
  queue?: QueueRecord;
  /**
   * The question kharos sent after a turn closed without the end mark, quiet, with nothing left to wake it:
   * the key of that turn's result, when it was sent (written before the send, so it goes once), and why the
   * send failed when it did.
   */
  end_probe?: { for: string; at: string; error?: string | null } | null;
  /** When list_runs first showed the session archived; the next log read without an end mark ends it unmarked. */
  archived_at?: string | null;
  /** A closed turn a read found to ask about: the key of its result. The follower that holds the lease sends the question. */
  end_probe_due?: string | null;
  /** Alerts (notices and ends) that no follower handed on yet, oldest first; the next follower sends them. */
  unacked?: AlertRef[];
  /** What automatic permission preflight did at launch; absent or null when it was off. */
  preflight?: Preflight | null;
}

/**
 * Automatic permission preflight at launch. `creating` is written before the side branch is made, so a
 * launch that stopped midway still names the branch; `applied` once the session starts on it.
 */
export type Preflight =
  | { status: 'creating'; branch: string; base: string; applied: string[] }
  | { status: 'applied'; branch: string; base: string; commit: string; applied: string[]; deleted_at: string | null; mirrored?: string[]; unblock?: boolean; note?: string | null }
  | { status: 'skipped'; reason: string };

export interface Registry {
  version: 1;
  next_seq: number;
  sessions: Record<string, Session>;
}

function empty(): Registry {
  return { version: 1, next_seq: 1, sessions: {} };
}

export function loadRegistry(paths: Paths): Registry {
  const valid = (v: unknown) => isObject(v) && typeof v.next_seq === 'number' && isObject(v.sessions) && Object.values(v.sessions).every(isObject);
  return readState<Registry>(paths.registry, valid, 'a kharos registry (it needs "next_seq" and "sessions" of objects)') ?? empty();
}

/** Reads, changes and writes the registry under its lock. */
export function updateRegistry<T>(paths: Paths, fn: (reg: Registry) => T): T {
  return withLock(paths.registry, () => {
    const reg = loadRegistry(paths);
    const out = fn(reg);
    writeJsonAtomic(paths.registry, reg);
    return out;
  });
}

export function formatId(seq: number): string {
  return `k-${String(seq).padStart(4, '0')}`;
}

export function findSession(reg: Registry, ref: string): Session | undefined {
  const direct = reg.sessions[ref];
  if (direct) return direct;
  const num = /^\d+$/.test(ref) ? formatId(Number(ref)) : null;
  if (num && reg.sessions[num]) return reg.sessions[num];
  return Object.values(reg.sessions).find((s) => s.session_id === ref || s.trigger_id === ref || s.url === ref);
}

export function byTrigger(reg: Registry, triggerId: string): Session | undefined {
  return Object.values(reg.sessions).find((s) => s.trigger_id === triggerId);
}

export function bySessionId(reg: Registry, sessionId: string): Session | undefined {
  return Object.values(reg.sessions).find((s) => s.session_id === sessionId);
}

/**
 * When a session started, in ms: the deadline counts from it. The open of the cloud session, not the
 * launch's preparation, so a refused fire, an approval or a queue wait are not counted; records from
 * before kharos kept it fall back to the last fire, then to the preparation.
 */
export function startedAt(s: Pick<Session, 'opened_at' | 'fired_at' | 'created_at'>): number {
  return Date.parse(s.opened_at ?? s.fired_at ?? s.created_at);
}

/** Sessions kharos still follows: launched or launching, not terminal, not closed. */
export function isFollowed(s: Session): boolean {
  if (s.step === 'closed' || s.step === 'refused' || s.step === 'queued' || s.step === 'prepared' || s.step === 'routine_created') return false;
  return !TERMINAL_STATES.has(s.state);
}

const LOG_RETENTION_MS = 14 * 24 * 3600_000;

/** Deletes raw logs and stored bodies of sessions closed more than 14 days ago. */
export function collectGarbage(paths: Paths, reg: Registry, now: number): void {
  for (const s of Object.values(reg.sessions)) {
    if (!s.closed_at || now - Date.parse(s.closed_at) < LOG_RETENTION_MS) continue;
    fs.rmSync(logPath(paths, s.id), { force: true });
    fs.rmSync(path.join(paths.logs, `${s.id}.follower.log`), { force: true });
    fs.rmSync(bodyPath(paths, s.id), { force: true });
  }
}

/** When a session's deadline passes, in ms: its start plus its deadline. */
export function deadlineAt(s: Pick<Session, 'opened_at' | 'fired_at' | 'created_at' | 'deadline_min'>): number {
  return startedAt(s) + s.deadline_min * 60_000;
}

/** A session the person closed while it ran, that ended or reached its deadline: its slot is free now. */
export function closingDone(s: Session, now: number): boolean {
  return typeof s.closing_at === 'string' && s.step === 'open' && (TERMINAL_STATES.has(s.state) || now >= deadlineAt(s));
}

/** Closes a closing session whose slot is free now; true when it did. */
export function releaseClosing(s: Session, now: number): boolean {
  if (!closingDone(s, now)) return false;
  s.step = 'closed';
  s.closed_at = new Date(now).toISOString();
  s.notice = null;
  return true;
}

/** A launch that holds a slot against max_open: anything that may run and is not finished; a queued launch waits for one. */
function holdsSlot(s: Session, now: number): boolean {
  return s.step !== 'closed' && s.step !== 'refused' && s.step !== 'queued' && !TERMINAL_STATES.has(s.state) && !closingDone(s, now);
}

export function activeCount(reg: Pick<Registry, 'sessions'>, now: number = Date.now()): number {
  return Object.values(reg.sessions).filter((s) => holdsSlot(s, now)).length;
}

/** Tries of one queued launch before kharos stops firing it and asks the person. */
export const MAX_FIRE_TRIES = 3;

/** How `error` of a launch starts after the auto mode classifier refused its run. */
export const CLASSIFIER_REFUSED = 'the auto mode classifier refused the run';

/** A launch made with --queue whose fires are used up: it waits for a person, and no longer for a slot. */
export function leftToPerson(s: Session): boolean {
  return s.queue !== undefined && s.queue.tries >= MAX_FIRE_TRIES;
}

/** The launches waiting in the queue for a slot, in the order they fire: the oldest first. */
export function queuedLaunches(sessions: Iterable<Session>): Session[] {
  return [...sessions].filter((s) => s.step === 'queued' && !leftToPerson(s)).sort((a, b) => (a.queue?.queued_at ?? a.created_at).localeCompare(b.queue?.queued_at ?? b.created_at) || a.id.localeCompare(b.id));
}

const WAITING_ON_A_PERSON = new Set<State>(['waiting_answer', 'waiting_permission']);

/** The launches that hold a slot, each with its state; one that waits on a person says for how long. */
export function slotHolders(reg: Registry, now: number): string {
  const rows = Object.values(reg.sessions)
    .filter((s) => holdsSlot(s, now))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => {
      if (s.step !== 'open') return `${s.id} launch ${s.step.replace(/_/g, ' ')}`;
      if (s.closing_at) return `${s.id} closing until it ends or ${new Date(deadlineAt(s)).toISOString().slice(11, 16)} UTC`;
      const label = `${s.id} ${s.state.replace(/_/g, ' ')}`;
      return WAITING_ON_A_PERSON.has(s.state) ? `${label} for ${Math.max(0, Math.round((now - Date.parse(s.state_since)) / 60_000))} min` : label;
    });
  return rows.length ? rows.join(', ') : 'none';
}

export function bodyPath(paths: Paths, id: string): string {
  return path.join(paths.bodies, `${id}.json`);
}

export function logPath(paths: Paths, id: string): string {
  return path.join(paths.logs, `${id}.jsonl`);
}

export function sessionUrlFromId(sessionId: string): string {
  return `https://claude.ai/code/session_${sessionId.replace(/^(cse_|session_)/, '')}`;
}

export function routineUrl(triggerId: string): string {
  return `https://claude.ai/code/routines/${triggerId}`;
}

// The registry of launched sessions: one JSON file, private, written atomically under a lock.
// Every launch step is recorded before the call that depends on it, so a session that dies in the
// middle can be resumed without firing twice (a repeated `run` creates another paid session).

import path from 'node:path';
import { readJson, withLock, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

/** Where the launch is. Each step is written before the call that depends on it. */
export type Step =
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
  /** When list_runs last came back empty while the launch was firing; a person may re-arm it after that. */
  runs_seen_empty_at: string | null;
  step: Step;
  state: State;
  state_since: string;
  /** A state seen once that needs a second read to count (looping, usage limit, invisible). */
  pending_state: { state: State; reads: number } | null;
  last_event_at: string | null;
  last_read_at: string | null;
  reads: number;
  read_failures: number;
  closed_turns: number;
  /** The notice that is currently open, if any; cleared when the session goes back to normal. */
  notice: Notice | null;
  last_notice: Notice | null;
  result: Result;
  /** A next older page the watcher must read because the newest page did not reach the events it had. */
  pending_cursor: string | null;
  cursor_reads: number;
  closed_at: string | null;
  error: string | null;
}

export interface Registry {
  version: 1;
  next_seq: number;
  sessions: Record<string, Session>;
}

function empty(): Registry {
  return { version: 1, next_seq: 1, sessions: {} };
}

export function loadRegistry(paths: Paths): Registry {
  const reg = readJson<unknown>(paths.registry);
  if (reg === undefined) return empty();
  const r = reg as Partial<Registry> | null;
  const sessions = r?.sessions;
  if (
    typeof r !== 'object' || r === null || Array.isArray(r) || typeof r.next_seq !== 'number' || typeof sessions !== 'object' || sessions === null || Array.isArray(sessions) ||
    Object.values(sessions).some((s) => typeof s !== 'object' || s === null || Array.isArray(s))
  ) {
    throw new Error('it is not a kharos registry (it needs "next_seq" and "sessions" of objects)');
  }
  return r as Registry;
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

/** Counts launches that hold a slot against max_open: everything that may run and is not finished. */
export function activeCount(reg: Registry): number {
  return Object.values(reg.sessions).filter((s) => s.step !== 'closed' && s.step !== 'refused' && !TERMINAL_STATES.has(s.state)).length;
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

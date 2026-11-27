// The hooks on the RemoteTrigger tool. They act only on routines and sessions in the registry, and on
// answers a kharos command asked for; every other use of the tool (such as /schedule) passes untouched.

import fs from 'node:fs';
import { clean } from './body.ts';
import { repoSlug } from './config.ts';
import { StateError } from './fsutil.ts';
import { mergePage, parseLog, storedLogView } from './logparse.ts';
import type { Paths } from './paths.ts';
import {
  bodyPath,
  byTrigger,
  bySessionId,
  loadRegistry,
  logPath,
  routineUrl,
  sessionUrlFromId,
  TERMINAL_STATES,
  updateRegistry,
  type Registry,
  type Session,
} from './registry.ts';
import { readCreatedTrigger, readEnvironments, readError, readLogHeader, readRunSession, readRuns, readToolResponse, type EnvironmentUse } from './remote.ts';
import { recordAccess, readOwnerType, refusalFix, type OwnerType } from './repo.ts';
import { loadSetups, saveEnvironments, setupsFor, takeIntent } from './state.ts';
import { buildEvent, enqueue } from './events.ts';
import { applyRead, failedRead, settle } from './track.ts';
import { health, rearmFollowers, type Spawner } from './follow.ts';
import { READER_ROLE, ROLE_ENV } from './wait.ts';
import { kickQueue } from './queue.ts';
import { nextCall } from './commands.ts';

export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  /** PermissionDenied: why the auto mode classifier refused the call. */
  reason?: string;
}

export interface Ctx {
  paths: Paths;
  now: number;
  env: NodeJS.ProcessEnv;
  /** Test seam: how long delivery may run inside a hook. Defaults to a budget well inside the hook timeout. */
  deliveryBudgetMs?: number;
  /** Test seam: who owns a repository, for the access fix. Defaults to gh. */
  ownerType?: (repo: string) => OwnerType;
  /** Test seam: how the Stop hook starts a follower process. */
  spawner?: Spawner;
}

export type HookOutput = Record<string, unknown> | null;

const LAUNCH_NAME_RE = /^kharos (k-\d{4,}): /;

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function deny(reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function stateUnreadable(ctx: Ctx, err: unknown): string {
  return (err instanceof StateError ? err : new StateError(ctx.paths.registry, err instanceof Error ? err.message : String(err))).message;
}

/**
 * Runs a launch check under the registry lock. When kharos state cannot be read, the call is denied:
 * passing it could fire a launch a second time, which starts another paid session.
 */
function launchCheck(ctx: Ctx, fn: (reg: Registry) => HookOutput): HookOutput {
  try {
    return updateRegistry(ctx.paths, fn);
  } catch (err) {
    return deny(stateUnreadable(ctx, err));
  }
}

/** Replaces what the model receives from the tool with a short text that carries no remote content. */
function reshape(status: number | null, header: Record<string, unknown>, summary: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: { status, json: JSON.stringify(header), summary },
    },
  };
}

/**
 * Records an answer about a launch kharos follows. When that fails, the model still gets one short line
 * instead of the raw answer, which may carry remote text.
 */
function recorded(ctx: Ctx, r: ReturnType<typeof readToolResponse>, id: string, fn: () => HookOutput): HookOutput {
  try {
    return fn();
  } catch (err) {
    return reshape(
      r.status,
      { kharos: id, error: 'state' },
      err instanceof StateError
        ? `kharos: ${id} answer could not be recorded (${err.file}: ${err.reason}). Do not run again; show this to the person.`
        : `kharos: ${id} answer could not be recorded (${ctx.paths.registry}: ${err instanceof Error ? err.message : String(err)}). Do not run again; show this to the person.`,
    );
  }
}

/**
 * Reads the registry to tell answers about followed launches from the rest. When it cannot be read,
 * that cannot be told, so the answer is hidden rather than passed with possible remote text.
 */
function withRegistry(ctx: Ctx, r: ReturnType<typeof readToolResponse>, fn: (reg: Registry) => HookOutput): HookOutput {
  try {
    return fn(loadRegistry(ctx.paths));
  } catch (err) {
    return reshape(r.status, { kharos: 'state', error: 'unreadable' }, stateUnreadable(ctx, err));
  }
}

const READER_DENIED = (action: string) => deny(`kharos: this session is a kharos reader, which only reads; RemoteTrigger "${action}" on a kharos launch is not allowed here.`);

/** A reader session that `kharos wait` started: it may read, never create, fire or change a kharos routine. */
const isReader = (ctx: Ctx): boolean => ctx.env[ROLE_ENV] === READER_ROLE;

export function preToolUse(ctx: Ctx, input: HookInput): HookOutput {
  if (input.tool_name !== 'RemoteTrigger') return null;
  const ti = input.tool_input ?? {};
  const action = str(ti.action);

  if (action === 'create') {
    const launch = str(rec(ti.body)?.kharos_launch);
    if (!launch) return null;
    return launchCheck(ctx, (reg) => {
      if (isReader(ctx)) return READER_DENIED(action);
      const s = reg.sessions[launch];
      if (!s) return deny(`kharos: there is no prepared launch ${launch}. Run /kharos:run again.`);
      if (s.step === 'queued') return deny(`kharos: launch ${nextCall(s)}`);
      if (s.step !== 'prepared') return deny(`kharos: launch ${launch} is past creation (step ${s.step}); do not create it again.`);
      let body: unknown;
      try {
        body = JSON.parse(fs.readFileSync(bodyPath(ctx.paths, launch), 'utf8'));
      } catch {
        return deny(`kharos: the stored body of ${launch} is missing. Run /kharos:run again.`);
      }
      // Creating a disabled routine costs nothing and starts nothing; the paid step is `run`, which
      // keeps its normal permission check.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `kharos: routine body of ${launch}, prepared by /kharos:run`,
          updatedInput: { action: 'create', body },
        },
      };
    });
  }

  if (action === 'run') {
    const trig = str(ti.trigger_id);
    if (!trig) return null;
    return launchCheck(ctx, (reg) => {
      const s = byTrigger(reg, trig);
      if (!s) return null;
      if (isReader(ctx)) return READER_DENIED(action);
      if (s.step === 'routine_created') {
        s.step = 'firing';
        s.fired_at = new Date(ctx.now).toISOString();
        s.runs_seen_empty_at = null;
        return null;
      }
      return deny(
        `kharos: ${s.id} was fired already (step ${s.step}). Another run would start a second paid session. ` +
          `If the first answer was lost, run /kharos:run --resume ${s.id}.`,
      );
    });
  }

  // A reader only reads: it may not change a routine kharos follows.
  if (action === 'update' || action === 'create_webhook_trigger') {
    const trig = str(ti.trigger_id);
    if (!trig) return null;
    try {
      if (!byTrigger(loadRegistry(ctx.paths), trig)) return null;
      return isReader(ctx) ? READER_DENIED(action) : null;
    } catch (err) {
      return deny(stateUnreadable(ctx, err));
    }
  }
  return null;
}

export function postToolUse(ctx: Ctx, input: HookInput): HookOutput {
  if (input.tool_name !== 'RemoteTrigger') return null;
  const ti = input.tool_input ?? {};
  const action = str(ti.action);
  const r = readToolResponse(input.tool_response);
  const claudeSession = input.session_id ?? '';

  if (action === 'create') {
    const m = str(rec(ti.body)?.name)?.match(LAUNCH_NAME_RE);
    if (!m) return null;
    const id = m[1] as string;
    return recorded(ctx, r, id, () => {
      const err = readError(r);
      const trig = err ? null : readCreatedTrigger(r);
      const outcome = updateRegistry(ctx.paths, (reg) => {
        const s = reg.sessions[id];
        if (!s || s.step !== 'prepared') return null;
        if (trig) {
          s.trigger_id = trig;
          s.step = 'routine_created';
        } else {
          s.step = 'refused';
          s.error = err ? `${err.status ?? '?'} ${err.reason ?? err.type ?? ''}`.trim() : 'create answered without a routine id';
        }
        return { repo: s.repo };
      });
      if (!outcome) return null;
      if (trig) {
        recordAccess(ctx.paths, outcome.repo, 'ok', null, ctx.now);
        return reshape(r.status, { kharos: id, step: 'routine_created', trigger_id: trig }, `kharos: ${id} routine created, disabled (${routineUrl(trig)}). Next: call RemoteTrigger with action "run" and trigger_id "${trig}", once.`);
      }
      const denied = err?.reason === 'repo_access_denied';
      if (denied) recordAccess(ctx.paths, outcome.repo, 'denied', err.reason, ctx.now);
      const fix = refusalFix(err?.reason ?? null, err?.message ?? null, outcome.repo, denied ? (ctx.ownerType ?? ((repo) => readOwnerType(repo, ctx.env)))(outcome.repo) : null);
      return reshape(r.status, { kharos: id, step: 'refused' }, [`kharos: ${id} was not created; nothing was started and nothing was spent.`, ...fix, 'Stop here and show this to the person.'].join('\n'));
    });
  }

  if (action === 'run') {
    const trig = str(ti.trigger_id);
    if (!trig) return null;
    return withRegistry(ctx, r, (current) => {
      const tracked = byTrigger(current, trig);
      if (!tracked) return null;
      return recorded(ctx, r, tracked.id, () => updateRegistry(ctx.paths, (reg) => {
        const s = byTrigger(reg, trig);
        if (!s || s.step !== 'firing') return null;
        const err = readError(r);
        const sid = err ? null : readRunSession(r);
        if (sid) {
          openSession(s, sid, null, ctx.now);
          enqueue(ctx.paths, [buildEvent(s, 'session.opened', 'launching', 'the cloud session started', ctx.now)]);
          return reshape(r.status, { kharos: s.id, step: 'open', session_id: sid }, `kharos: ${s.id} is open: ${s.url}`);
        }
        if (err && err.status !== null && err.status >= 400 && err.status < 500) {
          s.step = 'refused';
          s.error = `${err.status} ${err.reason ?? err.type ?? ''}`.trim();
          const fix = refusalFix(err.reason, err.message, s.repo, null);
          return reshape(r.status, { kharos: s.id, step: 'refused' }, [`kharos: ${s.id} was not started.`, ...fix, 'Stop here and show this to the person.'].join('\n'));
        }
        return reshape(r.status, { kharos: s.id, step: 'firing' }, `kharos: the answer to run did not carry a session id. Do not run again: call RemoteTrigger with action "list_runs" and trigger_id "${trig}" to find the session.`);
      }));
    });
  }

  if (action === 'list_runs') {
    const trig = str(ti.trigger_id);
    if (!trig) return null;
    return withRegistry(ctx, r, (current) => {
      const tracked = byTrigger(current, trig);
      if (!tracked) return null;
      return recorded(ctx, r, tracked.id, () => updateRegistry(ctx.paths, (reg) => {
        const s = byTrigger(reg, trig);
        if (!s) return null;
        const rows = readRuns(r);
        s.last_read_at = new Date(ctx.now).toISOString();
        if (rows === null) {
          failedRead(ctx, s, `list_runs HTTP ${r.status ?? '?'}`);
          return reshape(r.status, { kharos: s.id, read: 'failed' }, `kharos: ${s.id} list_runs could not be read (HTTP ${r.status ?? '?'}).`);
        }
        const row = s.session_id ? rows.find((x) => x.id === s.session_id) : rows[0];
        if (s.session_id && !row && s.step === 'open') {
          // The account sees the routine but not its session: another login, or a deleted session.
          failedRead(ctx, s, 'list_runs does not show the session');
          return reshape(r.status, { kharos: s.id, read: 'failed' }, `kharos: ${s.id} is not in list_runs (${s.read_failures} failed read(s) in a row).`);
        }
        if (!s.session_id && row && (s.step === 'firing' || s.step === 'routine_created')) {
          openSession(s, row.id, row.url, ctx.now);
          enqueue(ctx.paths, [buildEvent(s, 'session.opened', 'launching', 'the cloud session started', ctx.now)]);
        } else if (s.step === 'firing' && !row) {
          s.runs_seen_empty_at = new Date(ctx.now).toISOString();
          return reshape(
            r.status,
            { kharos: s.id, step: 'firing' },
            `kharos: ${s.id}: no session is visible yet. Do not run again; show this to the person. If the routine page ${routineUrl(trig)} shows no run and no Claude Code window still asks to approve the run, you can re-arm it by typing /kharos:run --rearm ${s.id}.`,
          );
        }
        if (row?.url) s.url = row.url;
        if (row?.status === 'archived' && s.step === 'open') s.archived_at ??= new Date(ctx.now).toISOString();
        return reshape(r.status, { kharos: s.id, step: s.step, run_status: row?.status ?? null }, applyRuns(ctx, s, row ?? null, rows.length));
      }));
    });
  }

  if (action === 'get_run_log') {
    const sid = str(ti.session_id);
    if (!sid) return null;
    return withRegistry(ctx, r, (current) => {
      const tracked = bySessionId(current, sid);
      if (!tracked) return null;
      return recorded(ctx, r, tracked.id, () => {
        const intent = takeIntent(ctx.paths, 'log', claudeSession, (i) => i.id === tracked.id, ctx.now);
        return updateRegistry(ctx.paths, (reg) => {
          const s = bySessionId(reg, sid);
          if (!s) return null;
          const out = readLogInto(ctx, s, r, ti);
          if (intent) return reshape(r.status, { kharos: s.id, view: 'log' }, logView(ctx, s, intent.lines));
          return reshape(r.status, { kharos: s.id, state: s.state }, out);
        });
      });
    });
  }

  if (action === 'list') {
    const intent = takeIntent(ctx.paths, 'environments', claudeSession, () => true, ctx.now);
    if (!intent) return null;
    const envs = readEnvironments(r);
    if (!envs) return reshape(r.status, { kharos: 'environments', read: 'failed' }, `kharos: the list of routines could not be read (HTTP ${r.status ?? '?'}).`);
    saveEnvironments(ctx.paths, envs, ctx.now, intent.account ?? null);
    const lines = envs.length
      ? envs.map((e) => `${e.id}  used by ${e.routines} routine(s)${e.repos?.length ? ` on ${e.repos.map((x) => clean(x, 100)).join(', ')}` : ''}, last ${e.last_used?.slice(0, 10) ?? 'unknown'}`)
      : ['no routine uses an environment yet'];
    if (intent.repo) lines.push(knownFor(ctx.paths, intent.account ?? null, intent.repo, envs));
    return reshape(r.status, { kharos: 'environments', count: envs.length }, ['kharos: cloud environments seen in your routines (there is no list of all of them):', ...lines].join('\n'));
  }
  return null;
}

/** Whether kharos knows an environment for the repository: one the person confirmed, or one its routines used. */
function knownFor(paths: Paths, account: string | null, repo: string, envs: EnvironmentUse[]): string {
  const slug = repoSlug(repo);
  const confirmed = setupsFor(loadSetups(paths), account, slug);
  if (confirmed.length) return `for ${slug}: ${confirmed.map((s) => `${s.environment} on ${clean(s.revision, 100)} (you confirmed it on ${s.confirmed_at.slice(0, 10)})`).join(', ')}`;
  const used = envs.filter((e) => e.repos?.includes(slug.toLowerCase())).map((e) => e.id);
  if (used.length) return `for ${slug}: ${used.join(', ')} (used by your routines on it)`;
  return `for ${slug}: no environment is known to fit it; offer the assisted path (kharos env-guide)`;
}

export function postToolUseFailure(ctx: Ctx, input: HookInput): HookOutput {
  if (input.tool_name !== 'RemoteTrigger') return null;
  const ti = input.tool_input ?? {};
  updateRegistry(ctx.paths, (reg) => {
    const sid = str(ti.session_id);
    const trig = str(ti.trigger_id);
    const s = (sid && bySessionId(reg, sid)) || (trig && byTrigger(reg, trig)) || null;
    if (s && (ti.action === 'get_run_log' || ti.action === 'list_runs')) failedRead(ctx, s, 'the tool call failed');
  });
  return null;
}

/**
 * After the auto mode classifier refused a call: a refused `run` never reached the service, so the launch
 * goes back to "routine created" and `/kharos:run --resume` fires it once, with no re-arm. Claude Code has
 * no hook for a refusal in a permission dialog or in a headless session without auto mode, so those keep
 * the fire, and the person re-arms it after list_runs shows no session.
 */
export function permissionDenied(ctx: Ctx, input: HookInput): HookOutput {
  if (input.tool_name !== 'RemoteTrigger') return null;
  const ti = input.tool_input ?? {};
  const trig = str(ti.trigger_id);
  if (ti.action !== 'run' || !trig) return null;
  const why = clean(str(input.reason) ?? 'no reason given', 200);
  const id = updateRegistry(ctx.paths, (reg) => {
    const s = byTrigger(reg, trig);
    if (!s || s.step !== 'firing') return null;
    s.step = 'routine_created';
    s.fired_at = null;
    s.runs_seen_empty_at = null;
    s.error = `the auto mode classifier refused the run (${why})`;
    return s.id;
  });
  if (!id) return null;
  return { systemMessage: `kharos: ${id} was not fired: the auto mode classifier refused the run, so nothing started and nothing was spent. /kharos:run --resume ${id} fires it once.` };
}

function openSession(s: Session, sessionId: string, url: string | null, now: number): void {
  s.session_id = sessionId;
  s.url = url ?? sessionUrlFromId(sessionId);
  s.step = 'open';
  s.opened_at = new Date(now).toISOString();
  // A refused run before this one is no longer the news.
  if (s.error?.startsWith('the auto mode classifier refused the run')) s.error = null;
  if (s.state === 'launching') {
    s.state = 'provisioning';
    s.state_since = new Date(now).toISOString();
  }
}

function applyRuns(ctx: Ctx, s: Session, row: { status: string | null; worker_status: string | null } | null, count: number): string {
  void ctx;
  if (!row) return `kharos: ${s.id} has no run in list_runs (${count} rows).`;
  return `kharos: ${s.id} run ${row.status ?? 'unknown'}, worker ${row.worker_status ?? 'unknown'}.`;
}

/**
 * Stores a log page and updates the session; returns the one-line answer for the model. A session list_runs
 * saw archived ends unmarked here when the log read still leaves it without an end.
 */
function readLogInto(ctx: Ctx, s: Session, r: ReturnType<typeof readToolResponse>, ti: Record<string, unknown>): string {
  const out = readLogPage(ctx, s, r, ti);
  if (!s.archived_at || s.step !== 'open' || TERMINAL_STATES.has(s.state)) return out;
  settle(ctx, s, { state: 'ended_unmarked', notice: 'ended_unmarked', reason: 'the session was archived without an end mark' });
  return `${out} The session was archived without an end mark.`;
}

function readLogPage(ctx: Ctx, s: Session, r: ReturnType<typeof readToolResponse>, ti: Record<string, unknown>): string {
  s.last_read_at = new Date(ctx.now).toISOString();
  s.reads++;
  if (r.status !== 200) {
    failedRead(ctx, s, `get_run_log HTTP ${r.status ?? '?'}`);
    return `kharos: ${s.id} log could not be read (HTTP ${r.status ?? '?'}; ${s.read_failures} failed read(s) in a row).`;
  }
  const header = readLogHeader(r);
  const page = parseLog(r.summary);
  const merged = mergePage(logPath(ctx.paths, s.id), page);
  const fromCursor = typeof ti.cursor === 'string';
  return applyRead(ctx, s, merged, header, fromCursor, page);
}

function logView(ctx: Ctx, s: Session, lines: number): string {
  return storedLogView(logPath(ctx.paths, s.id), `${s.id} (${s.url ?? 'no link yet'})`, lines);
}

/** At the start of any session: one line when an open session has no live follower. */
export function sessionStart(ctx: Ctx, input: HookInput): HookOutput {
  void input;
  const h = health(ctx.paths, ctx.now);
  return h.ok ? null : { systemMessage: h.line };
}

/**
 * At every turn end: an open session that no follower reads gets a follower process of its own, which
 * goes on after this Claude Code exits. Nothing happens in kharos's own sessions (a reader, a follower
 * process, a queued launch's fire), and nothing reaches the network unless a follower is
 * missing; the hook never holds the turn.
 */
export function stop(ctx: Ctx, input: HookInput): HookOutput {
  void input;
  if (ctx.env[ROLE_ENV]) return null;
  const r = rearmFollowers(ctx.paths, ctx.now, ctx.env, ctx.spawner);
  return r.lines.length ? { systemMessage: r.lines.join('\n') } : null;
}

/** The hooks after which a queued launch may fit in a slot that just freed: a read, and a turn end. */
export const KICKS_QUEUE: ReadonlySet<string> = new Set(['post-tool-use', 'stop']);

/** Starts the dispatcher of queued launches when one fits in a free slot; a hook never fails on it. */
export function kick(ctx: Ctx): void {
  try {
    kickQueue(ctx.paths, ctx.now, ctx.env, ctx.spawner);
  } catch {
    // the next hook or command tries again
  }
}

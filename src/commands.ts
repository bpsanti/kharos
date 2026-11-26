// The commands behind the skills. Each returns the text a person sees; none of them calls the network
// except `send` (through the official `claude -p --cloud`) and `result` (through gh, when installed).

import { spawnSync } from 'node:child_process';
import { claudeBin } from './account.ts';
import { defaultConfig, loadConfig, parseProfile, saveConfig, isValidProfileName, repoSlug, ConfigError, type PermissionChoice } from './config.ts';
import type { Forge } from './forge.ts';
import type { Paths } from './paths.ts';
import { followerMayBeStarting, followerReport, type FollowerInfo } from './lease.ts';
import { activeCount, findSession, isFollowed, leftToPerson, loadRegistry, logPath, queuedLaunches, routineUrl, slotHolders, TERMINAL_STATES, updateRegistry, type Session } from './registry.ts';
import { readStoredEvents, storedLogView } from './logparse.ts';
import { watchConfig } from './track.ts';
import { addIntent, loadWatch } from './state.ts';
import { readOutbox } from './events.ts';
import { loadUndelivered, MAX_ATTEMPTS } from './outputs/index.ts';

export class CommandError extends Error {}

export function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function stateLabel(s: Session): string {
  if (s.step === 'closed') return 'closed';
  if (s.step === 'refused') return 'refused';
  if (s.step === 'queued') return 'queued';
  if (s.step === 'prepared' || s.step === 'routine_created' || s.step === 'firing') return `launch ${s.step}`;
  return s.state.replace(/_/g, ' ');
}

export function sessionLine(s: Session, now: number): string {
  const age = minutes(now - Date.parse(s.created_at));
  const last = s.last_event_at ? `${minutes(now - Date.parse(s.last_event_at))} ago` : 'no event';
  const line = `${s.id}  ${stateLabel(s).padEnd(20)} ${age.padStart(8)}  turn ${s.closed_turns}  ${last.padEnd(12)} ${s.title}`;
  // The title always names the work; the link goes under it while the session needs a look.
  return (s.notice || s.state === 'waiting_permission') && s.url ? `${line}\n        ${s.url}` : line;
}

export function watcherLine(paths: Paths, now: number): string {
  const w = loadWatch(paths);
  if (!w.last_beat) return 'watcher: never ran (the advanced mode: /loop 10m /kharos:watch in a separate session).';
  const ago = now - Date.parse(w.last_beat);
  const every = w.interval_min ?? 10;
  const stale = ago > 3 * every * 60_000;
  return `watcher: heartbeat ${minutes(ago)} ago (every ${every} min)${stale ? '. It looks stopped: start /loop ' + every + 'm /kharos:watch again.' : ''}`;
}

function seconds(ms: number): string {
  return ms < 120_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : minutes(ms);
}

function whoFollows(f: FollowerInfo): string {
  return f.kind === 'shell' ? `process ${f.pid}` : f.kind === 'agent' ? 'agent' : `pid ${f.pid}`;
}

/** A follower of an open session whose heartbeat stopped: its process is stuck, or it ended without handing over. */
export interface FollowerProblem {
  id: string;
  state: 'stale' | 'gone';
  detail: string;
  fix: string;
}

/** The open sessions' followers whose heartbeat is older than LEASE_STALE_MS. */
export function followerProblems(paths: Paths, now: number): FollowerProblem[] {
  const open = new Set(Object.values(loadRegistry(paths).sessions).filter(isFollowed).map((s) => s.id));
  return followerReport(paths, now)
    .filter((f): f is FollowerInfo & { state: 'stale' | 'gone' } => open.has(f.id) && (f.state === 'stale' || f.state === 'gone'))
    .map((f) => {
      const ago = minutes(now - Date.parse(f.beat));
      return f.state === 'stale'
        ? {
            id: f.id,
            state: f.state,
            detail: `the follower of ${f.id} (${whoFollows(f)}) has not beaten for ${ago} while its process still runs: it looks stuck`,
            fix: `Stop it (kill ${f.pid}); the next turn end of a Claude Code session with kharos starts another, or kharos follow ${f.id} --detach does now.`,
          }
        : {
            id: f.id,
            state: f.state,
            detail: `the follower of ${f.id} (${whoFollows(f)}) stopped ${ago} ago without handing over: nobody reads the session`,
            fix: `The next turn end of a Claude Code session with kharos starts another; /kharos:follow ${f.id}, or kharos follow ${f.id} --detach, does now.`,
          };
    });
}

/** Who reads the open sessions now, each with its heartbeat; the followers that look stuck or stopped; and the open sessions that nobody follows. */
export function followerLines(paths: Paths, now: number): string[] {
  const sessions = Object.values(loadRegistry(paths).sessions)
    .filter(isFollowed)
    .sort((a, b) => a.id.localeCompare(b.id));
  const open = new Set(sessions.map((s) => s.id));
  const report = followerReport(paths, now).filter((f) => open.has(f.id));
  const live = new Set(report.filter((f) => f.state === 'live' || f.state === 'handover').map((f) => f.id));
  const lines: string[] = [];
  const followed = report
    .filter((f) => live.has(f.id))
    .map((f) => (f.state === 'handover' ? `${f.id} (starting again)` : `${f.id} (${whoFollows(f)}, heartbeat ${seconds(now - Date.parse(f.beat))} ago)`));
  if (followed.length) lines.push(`followers: ${followed.join(', ')}`);
  for (const p of followerProblems(paths, now)) lines.push(`follower heartbeat ${p.state === 'stale' ? 'stale' : 'stopped'}: ${p.detail}. ${p.fix}`);
  const w = loadWatch(paths);
  const watcherLive = w.last_beat !== null && now - Date.parse(w.last_beat) <= 3 * (w.interval_min ?? 10) * 60_000;
  const nobody = sessions.filter((s) => !live.has(s.id) && !followerMayBeStarting(s, now)).map((s) => s.id);
  if (nobody.length && !watcherLive) lines.push(`no follower reads ${nobody.join(', ')}: type /kharos:follow to follow them from this Claude Code session.`);
  return lines;
}

export function list(paths: Paths, opts: { all: boolean; now: number }): string {
  const reg = loadRegistry(paths);
  const rows = Object.values(reg.sessions)
    .filter((s) => opts.all || (s.step !== 'closed' && s.step !== 'refused'))
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = rows.map((s) => sessionLine(s, opts.now));
  if (lines.length === 0) lines.push(opts.all ? 'no sessions yet' : 'no open sessions (--all shows closed ones)');
  const used = activeCount(reg);
  if (used) lines.push(`slots: ${used} of watch.max_open ${watchConfig(paths).max_open} in use: ${slotHolders(reg, opts.now)}`);
  lines.push(...queueLines(paths, opts.now));
  lines.push(...followerLines(paths, opts.now));
  lines.push(watcherLine(paths, opts.now));
  const lost = loadUndelivered(paths);
  if (lost.length) lines.push(`outputs: ${lost.length} event(s) could not be delivered after ${MAX_ATTEMPTS} tries; the last one: ${lost[lost.length - 1]?.target} (${lost[lost.length - 1]?.error})`);
  const queued = readOutbox(paths).length;
  if (queued) lines.push(`outputs: ${queued} event(s) waiting for delivery`);
  return lines.join('\n');
}

export function show(paths: Paths, ref: string): string {
  const s = need(paths, ref);
  const lines = [
    `${s.id} ${stateLabel(s)}  ${s.profile} (${repoSlug(s.repo)}@${s.revision})  ${s.model}  deadline ${s.deadline_min} min${s.no_push ? '  no push asked' : ''}`,
    s.url ?? (s.trigger_id ? routineUrl(s.trigger_id) : 'no link yet'),
  ];
  if (s.error) lines.push(`error: ${s.error}`);
  const p = s.preflight;
  if (p?.status === 'applied') {
    lines.push(`permission preflight: ${p.applied.length} allow rule(s)${p.unblock ? ' and the unblock preset' : p.mirrored?.length ? ` and ${p.mirrored.length} mirrored organization ask rule(s)` : ''} on the side branch ${p.branch} (from ${p.base}, commit ${p.commit.slice(0, 12)})${p.deleted_at ? `; the branch was deleted at ${p.deleted_at}` : ''}: ${p.applied.join(' | ')}`);
  } else if (p?.status === 'skipped') lines.push(`permission preflight: ${p.reason}`);
  else if (p?.status === 'creating') lines.push(`permission preflight: the side branch ${p.branch} was not finished`);
  return lines.join('\n');
}

function need(paths: Paths, ref: string): Session {
  const s = findSession(loadRegistry(paths), ref);
  if (!s) throw new CommandError(`no session ${ref} in the registry (see /kharos:list --all)`);
  return s;
}

/**
 * What a person must call next to finish or check a launch that stopped midway. A queued launch takes a
 * free slot, if one is free, and otherwise stays in the queue. A launch the person goes on with leaves the
 * queue: the dispatcher no longer fires or retries it.
 */
export function resume(paths: Paths, ref: string): string {
  const id = need(paths, ref).id;
  const max = watchConfig(paths).max_open;
  return updateRegistry(paths, (reg) => {
    const s = reg.sessions[id] as Session;
    if (s.step === 'queued') {
      if (activeCount(reg) >= max) {
        if (s.queue && leftToPerson(s)) s.queue = { ...s.queue, tries: 0, blocked: null, next_try_at: null };
        const place = queuedLaunches(Object.values(reg.sessions)).findIndex((x) => x.id === id) + 1;
        return `${id} is still queued (${place} in line): every watch.max_open slot is taken (${slotHolders(reg, Date.now())}). It fires by itself when one frees; /kharos:close ${id} cancels it.`;
      }
      s.step = 'prepared';
      delete s.queue;
      return `${id}: a slot is free. Call RemoteTrigger with action "create" and body {"kharos_launch":"${id}"}.`;
    }
    delete s.queue;
    return nextCall(s);
  });
}

/** The RemoteTrigger call that finishes or checks a launch that stopped midway, as its step says. */
export function nextCall(s: Session): string {
  switch (s.step) {
    case 'queued':
      return leftToPerson(s)
        ? `${s.id} waits for you: its queued fires did not go through (${s.queue?.blocked ?? 'no detail'}), and it no longer fires by itself. /kharos:run --resume ${s.id} fires it with you present, or puts it back in line while every slot is taken.`
        : `${s.id} is queued for a free slot, and kharos creates it when one frees; /kharos:run --resume ${s.id} takes a slot now if one is free.`;
    case 'prepared':
      return `${s.id}: call RemoteTrigger with action "create" and body {"kharos_launch":"${s.id}"}.`;
    case 'routine_created':
      return `${s.id}: call RemoteTrigger with action "run" and trigger_id "${s.trigger_id}", once.`;
    case 'firing':
      return `${s.id}: it may have been fired. Do not run it again: call RemoteTrigger with action "list_runs" and trigger_id "${s.trigger_id}", and show its answer to the person.`;
    case 'open':
      return `${s.id} is open already: ${s.url}`;
    case 'refused':
      return `${s.id} was refused (${s.error ?? 'no detail'}); launch again with /kharos:run after fixing it.`;
    case 'closed':
      return `${s.id} is closed.`;
  }
}

const REARM_WINDOW_MS = 10 * 60_000;

/**
 * Moves a fire that never produced a session back to 'routine_created', on a person's word only.
 * It needs a list_runs read empty within REARM_WINDOW_MS, so it acts on what the service showed lately.
 */
export function rearm(paths: Paths, ref: string, now: number): string {
  const id = need(paths, ref).id;
  return updateRegistry(paths, (reg) => {
    const s = reg.sessions[id];
    if (!s || s.step !== 'firing') throw new CommandError(`${id} is not waiting on a fire (step ${s?.step ?? 'unknown'}); there is nothing to re-arm.`);
    const seen = s.runs_seen_empty_at ? Date.parse(s.runs_seen_empty_at) : NaN;
    if (!(now - seen >= 0 && now - seen <= REARM_WINDOW_MS)) {
      throw new CommandError(
        `${id} has no empty list_runs in the last 10 minutes. Type /kharos:run --resume ${id} first; if its answer shows no session, you can re-arm it then.`,
      );
    }
    s.step = 'routine_created';
    s.runs_seen_empty_at = null;
    return `${id} re-armed. To fire it once, type /kharos:run --resume ${id}.`;
  });
}

/** The events already stored for a session, read with no model and no network: what `kharos log --cached` prints. */
export function cachedLog(paths: Paths, ref: string, lines: number): string {
  const s = need(paths, ref);
  const text = storedLogView(logPath(paths, s.id), `${s.id} (${s.url ?? 'no link yet'}), as stored by the last read ${s.last_read_at ? `at ${s.last_read_at.slice(11, 19)} UTC` : '(none yet)'}`, lines);
  return text;
}

/** Records that the next get_run_log of this session is for a person, and says what to call. */
export function logRequest(paths: Paths, ref: string, lines: number, claudeSession: string, now: number): string {
  const s = need(paths, ref);
  if (!s.session_id) {
    if (s.trigger_id) return `${s.id} has no session id yet: call RemoteTrigger with action "list_runs" and trigger_id "${s.trigger_id}" first, then run this command again.`;
    return `${s.id} was never fired, so it has no log.`;
  }
  addIntent(paths, { kind: 'log', id: s.id, lines, claude_session: claudeSession }, now);
  return `Call RemoteTrigger with action "get_run_log" and session_id "${s.session_id}", then show its answer as it is.`;
}

export interface SendResult {
  ok: boolean;
  error: string | null;
}

export function parseSendOutput(stdout: string): SendResult {
  try {
    const v = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>;
    if (v.ok === true) return { ok: true, error: null };
    return { ok: false, error: typeof v.error === 'string' ? v.error : 'the message was not accepted' };
  } catch {
    return { ok: false, error: stdout.trim().slice(0, 200) || 'no answer from claude -p --cloud' };
  }
}

/** Sends a message into the session with the official binary; the answer appears on the next read. */
export function sendMessage(paths: Paths, ref: string, text: string, env: NodeJS.ProcessEnv): string {
  const s = need(paths, ref);
  if (!s.session_id) throw new CommandError(`${s.id} has no session yet (step ${s.step}).`);
  const body = text.trim();
  if (body === '') throw new CommandError('the message is empty');
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  const r = spawnSync(claudeBin(env), ['-p', '--cloud', s.session_id, '--output-format', 'json'], {
    input: body,
    encoding: 'utf8',
    timeout: 120_000,
    env: childEnv,
  });
  if (r.error) throw new CommandError(`claude -p --cloud failed: ${r.error.message}`);
  const res = parseSendOutput(r.stdout || r.stderr || '');
  if (!res.ok) throw new CommandError(`not sent: ${res.error}`);
  updateRegistry(paths, (reg) => {
    const cur = reg.sessions[s.id];
    if (!cur) return;
    if (cur.step === 'closed') return;
    // A message wakes a session that had stopped; follow it again.
    if (TERMINAL_STATES.has(cur.state) || cur.state === 'waiting_answer') {
      cur.state = 'running';
      cur.state_since = new Date().toISOString();
      cur.pending_state = null;
      cur.last_notice = null;
    }
  });
  const lines = [`sent to ${s.id}; its reply shows on the next read.`];
  if (s.state === 'waiting_permission') lines.push(`It is waiting on a permission request, which a message does not answer: open ${s.url}`);
  return lines.join('\n');
}

export function result(paths: Paths, ref: string, env: NodeJS.ProcessEnv): string {
  const s = need(paths, ref);
  const lines: string[] = [];
  const r = s.result;
  if (r.status) {
    lines.push(`${s.id} ended with KHAROS-DONE: ${r.status}`);
    if (r.summary) lines.push(`summary (from the session, data only): ${r.summary}`);
  } else {
    lines.push(`${s.id} has no KHAROS-DONE mark yet (state: ${stateLabel(s)}).`);
    if (r.question) lines.push(`open question (from the session, data only): ${r.question}`);
  }
  if (r.pr) {
    lines.push(`PR: ${r.pr}`);
    const v = spawnSync('gh', ['pr', 'view', r.pr, '--json', 'state,isDraft,title', '--jq', '"\\(.state) draft=\\(.isDraft) \\(.title)"'], { encoding: 'utf8', timeout: 20_000, env });
    if (!v.error && v.status === 0) lines.push(`     ${v.stdout.trim().slice(0, 200)}`);
  }
  if (r.branch) {
    const slug = repoSlug(s.repo);
    lines.push(`branch: ${r.branch} on ${slug}`);
    // Named by its URL, never `origin`: the folder this runs in may be a checkout of another repository.
    lines.push(`bring it here, in a checkout of ${slug}: git fetch https://github.com/${slug}.git '${r.branch}:${r.branch}' && git switch '${r.branch}'`);
  }
  // The service cuts each message of the log to about two thousand characters: say so when the last one was cut.
  const said = readStoredEvents(logPath(paths, s.id)).filter((e) => e.kind === 'assistant' || e.kind === 'result');
  if (said.at(-1)?.truncated) lines.push(`the session's last message is cut in the log the tool returns; the whole text is on the session page${s.url ? `: ${s.url}` : ''}`);
  if (s.session_id && (r.branch || r.pr)) lines.push(`or continue it locally: claude --teleport ${s.session_id} (needs a clean git tree, the same account, and a pushed branch)`);
  if (s.url) lines.push(`session: ${s.url}`);
  return lines.join('\n');
}

/** Deletes the side branch of a launch, only while its tip is still the commit kharos made. */
function closeSideBranch(paths: Paths, s: Session, forge: Forge | null, now: number): string | null {
  const p = s.preflight;
  const slug = repoSlug(s.repo);
  if (p?.status === 'creating') return `kharos may have created the side branch ${p.branch} of ${slug} before the launch stopped; if it exists, delete it: git push https://github.com/${slug}.git --delete '${p.branch}'`;
  if (p?.status !== 'applied' || p.deleted_at) return null;
  const byHand = `delete it yourself once nothing on it is needed: git push https://github.com/${slug}.git --delete '${p.branch}'`;
  if (!forge) return `the side branch ${p.branch} of ${slug} stays; ${byHand}`;
  const tip = forge.branchTip(s.repo, p.branch);
  if (!tip.ok) return `the side branch ${p.branch} of ${slug} could not be checked with gh (${tip.error}); ${byHand}`;
  const mark = () =>
    updateRegistry(paths, (reg) => {
      const cur = reg.sessions[s.id]?.preflight;
      if (cur?.status === 'applied') cur.deleted_at = new Date(now).toISOString();
    });
  if (tip.tip === null) {
    mark();
    return `the side branch ${p.branch} of ${slug} is gone already`;
  }
  if (tip.tip !== p.commit) return `the side branch ${p.branch} of ${slug} was kept: it has commits kharos did not make; ${byHand}`;
  const del = forge.deleteBranch(s.repo, p.branch);
  if (!del.ok) return `the side branch ${p.branch} of ${slug} could not be deleted with gh (${del.error}); ${byHand}`;
  mark();
  return `deleted the side branch ${p.branch} of ${slug}, which held only the permission hook commit of this launch`;
}

/** The message `close --ask-stop` sends into a session before it is released. */
export function stopRequest(s: Pick<Session, 'no_push'>): string {
  return [
    'kharos: the person closed this session and asks you to stop now.',
    'Start no new work, and run nothing more in the background.',
    ...(s.no_push ? [] : ['If you have changes worth keeping, commit and push them first.']),
    'Then end your turn: nobody reads this session any more.',
  ].join(' ');
}

export interface CloseOptions {
  /** Send the session a request to stop (`--ask-stop`) before releasing it; nothing is released if it cannot be sent. */
  askStop?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function close(paths: Paths, ref: string, now: number, forge: Forge | null = null, opts: CloseOptions = {}): string {
  const s = need(paths, ref);
  const running = s.step === 'open' && !TERMINAL_STATES.has(s.state);
  let asked = false;
  if (opts.askStop && running) {
    try {
      sendMessage(paths, s.id, stopRequest(s), opts.env ?? process.env);
      asked = true;
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      throw new CommandError(`${s.id} is still followed: the request to stop could not be sent (${err.message}). Try again, or close it without --ask-stop and stop it at ${s.url}`);
    }
  }
  updateRegistry(paths, (reg) => {
    const cur = reg.sessions[s.id];
    if (!cur || cur.step === 'closed') return;
    cur.step = 'closed';
    cur.closed_at = new Date(now).toISOString();
    cur.notice = null;
  });
  if (s.step === 'queued') {
    const lines = [`${s.id} was queued, and is cancelled: no routine was created and nothing was spent.`];
    const side = closeSideBranch(paths, s, forge, now);
    if (side) lines.push(`${side[0]?.toUpperCase()}${side.slice(1)}.`);
    return lines.join('\n');
  }
  const lines = [`${s.id} is no longer followed.`];
  if (asked) {
    lines.push(`It was asked to stop, and stops at the end of its current step; nobody reads it now, so check that it did at ${s.url} (the tool has no stop action).`);
  } else if (running) {
    lines.push(`The cloud session itself was not stopped (the tool has no stop action): /kharos:close ${s.id} --ask-stop asks it to stop before it is released, /kharos:send ${s.id} sends it any message, and ${s.url} stops it.`);
  } else if (opts.askStop) {
    lines.push('There was nothing to ask to stop: no cloud session of it is running.');
  }
  if (s.trigger_id) lines.push(`Its disabled routine stays in your account; delete it at ${routineUrl(s.trigger_id)} (the tool cannot delete routines).`);
  const side = closeSideBranch(paths, s, forge, now);
  if (side) lines.push(`${side[0]?.toUpperCase()}${side.slice(1)}.`);
  return lines.join('\n');
}

export interface SetupInput {
  name: string;
  repo: string;
  environment: string;
  revision?: string;
  model?: string;
  deadline_min?: number;
  allowed_tools?: string[];
  connectors?: boolean;
  environment_name?: string;
  permissions?: PermissionChoice;
  account?: string;
  makeDefault: boolean;
}

/** Writes or updates one profile; the rest of the configuration stays as it is. */
export function writeProfile(paths: Paths, input: SetupInput): string {
  if (!isValidProfileName(input.name)) throw new CommandError(`profile name "${input.name}" must be lowercase letters, digits, dot, dash or underscore`);
  const loaded = loadConfig(paths);
  const config = loaded.exists ? loaded.config : defaultConfig();
  const prev = config.profiles[input.name];
  const raw: Record<string, unknown> = { ...(prev ?? {}), repo: input.repo, environment: input.environment };
  if (input.revision !== undefined) raw.revision = input.revision;
  if (input.model !== undefined) raw.model = input.model;
  if (input.deadline_min !== undefined) raw.deadline_min = input.deadline_min;
  if (input.allowed_tools !== undefined) raw.allowed_tools = input.allowed_tools;
  if (input.connectors !== undefined) raw.connectors = input.connectors;
  if (input.environment_name !== undefined) raw.environment_name = input.environment_name;
  else if (prev && prev.environment !== input.environment) delete raw.environment_name; // the name was the old environment's
  if (input.permissions !== undefined) raw.permissions = input.permissions;
  if (input.account !== undefined) raw.account = input.account;
  let profile;
  try {
    profile = parseProfile(raw, `profiles.${input.name}`);
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
  config.profiles[input.name] = profile;
  if (input.makeDefault || config.default_profile === null) config.default_profile = input.name;
  saveConfig(paths, config);
  return `${prev ? 'updated' : 'wrote'} profile ${input.name}: ${repoSlug(profile.repo)}@${profile.revision}, ${profile.environment}, ${profile.model}, deadline ${profile.deadline_min} min${config.default_profile === input.name ? ' (default)' : ''}\nconfig: ${paths.config}`;
}

/** The queued launches in line, for `kharos list` and the doctor; an empty list when there are none. */
export function queueLines(paths: Paths, now: number): string[] {
  const sessions = Object.values(loadRegistry(paths).sessions);
  const queued = queuedLaunches(sessions);
  const waiting = sessions.filter((s) => s.step === 'queued' && leftToPerson(s)).sort((a, b) => a.id.localeCompare(b.id));
  const stalled = sessions.filter((s) => s.queue && s.step === 'routine_created' && s.queue.blocked);
  if (queued.length === 0 && waiting.length === 0 && stalled.length === 0) return [];
  const lines: string[] = [];
  if (queued.length) {
    const rows = queued.map((s, i) => {
      const since = Math.max(0, Math.round((now - Date.parse(s.queue?.queued_at ?? s.created_at)) / 60_000));
      return `${s.id} (${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'} in line, queued ${since} min ago${s.queue?.blocked ? `; not fired: ${s.queue.blocked}` : ''})`;
    });
    lines.push(`queue: ${rows.join(', ')}. Each fires by itself when a slot frees, a paid action with nobody present; /kharos:close <id> cancels one.`);
  }
  for (const s of waiting) lines.push(`queue: ${s.id} waits for you, not fired: ${s.queue?.blocked}; it no longer fires by itself. /kharos:run --resume ${s.id} fires it with you present, or puts it back in line while every slot is taken; /kharos:close ${s.id} cancels it.`);
  for (const s of stalled) lines.push(`queue: ${s.id} was created but not fired: ${s.queue?.blocked}; /kharos:run --resume ${s.id} fires it once, /kharos:close ${s.id} cancels it.`);
  return lines;
}

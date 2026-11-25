// The commands behind the skills. Each returns the text a person sees; none of them calls the network
// except `send` (through the official `claude -p --cloud`) and `result` (through gh, when installed).

import { spawnSync } from 'node:child_process';
import { claudeBin } from './account.ts';
import { defaultConfig, loadConfig, parseProfile, saveConfig, isValidProfileName, repoSlug, ConfigError } from './config.ts';
import type { Paths } from './paths.ts';
import { findSession, loadRegistry, routineUrl, TERMINAL_STATES, updateRegistry, type Session } from './registry.ts';
import { addIntent, loadWatch } from './state.ts';

export class CommandError extends Error {}

export function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function stateLabel(s: Session): string {
  if (s.step === 'closed') return 'closed';
  if (s.step === 'refused') return 'refused';
  if (s.step === 'prepared' || s.step === 'routine_created' || s.step === 'firing') return `launch ${s.step}`;
  return s.state.replace(/_/g, ' ');
}

export function sessionLine(s: Session, now: number): string {
  const age = minutes(now - Date.parse(s.created_at));
  const last = s.last_event_at ? `${minutes(now - Date.parse(s.last_event_at))} ago` : 'no event';
  const tail = s.notice || s.state === 'waiting_permission' ? (s.url ?? s.title) : s.title;
  return `${s.id}  ${stateLabel(s).padEnd(20)} ${age.padStart(8)}  turn ${s.closed_turns}  ${last.padEnd(12)} ${tail}`;
}

export function watcherLine(paths: Paths, now: number): string {
  const w = loadWatch(paths);
  if (!w.last_beat) return 'watcher: never ran. Start it with /loop 10m /kharos:watch in a separate session.';
  const ago = now - Date.parse(w.last_beat);
  const every = w.interval_min ?? 10;
  const stale = ago > 3 * every * 60_000;
  return `watcher: heartbeat ${minutes(ago)} ago (every ${every} min)${stale ? '. It looks stopped: start /loop ' + every + 'm /kharos:watch again.' : ''}`;
}

export function list(paths: Paths, opts: { all: boolean; now: number }): string {
  const reg = loadRegistry(paths);
  const rows = Object.values(reg.sessions)
    .filter((s) => opts.all || (s.step !== 'closed' && s.step !== 'refused'))
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = rows.map((s) => sessionLine(s, opts.now));
  if (lines.length === 0) lines.push(opts.all ? 'no sessions yet' : 'no open sessions (--all shows closed ones)');
  lines.push(watcherLine(paths, opts.now));
  return lines.join('\n');
}

export function show(paths: Paths, ref: string, now: number): string {
  const s = need(paths, ref);
  const lines = [
    `${s.id} ${stateLabel(s)}  ${s.profile} (${repoSlug(s.repo)}@${s.revision})  ${s.model}  deadline ${s.deadline_min} min`,
    s.url ?? (s.trigger_id ? routineUrl(s.trigger_id) : 'no link yet'),
  ];
  if (s.error) lines.push(`error: ${s.error}`);
  const w = loadWatch(paths);
  if (!w.last_beat || now - Date.parse(w.last_beat) > 3 * (w.interval_min ?? 10) * 60_000) lines.push(watcherLine(paths, now));
  return lines.join('\n');
}

function need(paths: Paths, ref: string): Session {
  const s = findSession(loadRegistry(paths), ref);
  if (!s) throw new CommandError(`no session ${ref} in the registry (see /kharos:list --all)`);
  return s;
}

/** What the model must call next to finish or check a launch that stopped midway. */
export function resume(paths: Paths, ref: string): string {
  const s = need(paths, ref);
  switch (s.step) {
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
    }
  });
  return `sent to ${s.id}; the answer shows on the next read. A permission request cannot be answered here: open ${s.url}`;
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
    lines.push(`branch: ${r.branch}`);
    lines.push(`bring it here: git fetch origin ${r.branch} && git switch ${r.branch}`);
  }
  if (s.session_id) lines.push(`or continue it locally: claude --teleport ${s.session_id} (needs a clean git tree, the same account, and a pushed branch)`);
  if (s.url) lines.push(`session: ${s.url}`);
  return lines.join('\n');
}

export function close(paths: Paths, ref: string, now: number): string {
  const s = need(paths, ref);
  updateRegistry(paths, (reg) => {
    const cur = reg.sessions[s.id];
    if (!cur || cur.step === 'closed') return;
    cur.step = 'closed';
    cur.closed_at = new Date(now).toISOString();
    cur.notice = null;
  });
  const lines = [`${s.id} is no longer followed.`];
  if (s.state !== 'finished' && s.state !== 'failed' && s.step === 'open') {
    lines.push(`The cloud session itself was not stopped (the tool has no stop action): ask it to stop with /kharos:send ${s.id}, or stop it at ${s.url}`);
  }
  if (s.trigger_id) lines.push(`Its disabled routine stays in your account; delete it at ${routineUrl(s.trigger_id)} (the tool cannot delete routines).`);
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

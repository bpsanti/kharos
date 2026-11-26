// Following without a model: `kharos follow <id>` runs the loop of the kharos:follow agent in the shell,
// and `--detach` starts that loop in a process of its own, which outlives the Claude Code that started it.
// A headless Claude Code (`claude -p`, the Agent SDK) stops its background agents a while after its last
// turn (ten minutes by default, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS), so there a launch is followed this
// way instead of by an agent. What the follower sees reaches the outputs, as for any read.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CommandError } from './commands.ts';
import { loadConfig, type OutputConfig } from './config.ts';
import { buildEvent, enqueue } from './events.ts';
import { claimFollower, followerMayBeStarting, LEASE_STALE_MS, liveFollowers, releaseLease, takeLease } from './lease.ts';
import { childEnv } from './outputs/env.ts';
import { loadWatch } from './state.ts';
import { deliver, filePath } from './outputs/index.ts';
import type { Paths } from './paths.ts';
import { findSession, isFollowed, loadRegistry, updateRegistry, type Session } from './registry.ts';
import { acknowledge, followersToStart, followTargets, wait, WAIT_DEFAULTS, type WaitOptions, type WaitOutcome } from './wait.ts';

/** Claude Code runs without a terminal: `claude -p` says `sdk-cli`, the Agent SDK `sdk-ts` or `sdk-py`. */
export function isHeadless(env: NodeJS.ProcessEnv): boolean {
  return /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? '');
}

/** The person told headless Claude Code to wait for its background work with no limit. */
export function waitsForBackground(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS?.trim() === '0';
}

function settled(o: WaitOutcome): boolean {
  return o.key.startsWith('end:') || o.key.startsWith('launch:');
}

/** How long the follower waits before it tries again after a failed wait: about 15 minutes in all. */
export const RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 480_000] as const;

export interface FollowLoopOptions {
  id: string;
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  wait?: typeof wait;
  waitOptions?: Partial<WaitOptions>;
  sleep?: (ms: number) => Promise<void>;
  deliver?: typeof deliver;
}

/** Nobody reads the session any more: says so to the outputs, since a detached follower has no one watching its log. */
async function reportStopped(paths: Paths, opts: FollowLoopOptions): Promise<void> {
  const now = Date.now();
  const ev = updateRegistry(paths, (reg) => {
    const s = findSession(reg, opts.id);
    if (!s || s.closing_at) return null;
    const ev = buildEvent(s, 'session.unfollowed', s.state, `its follower stopped because reads kept failing; kharos follow ${s.id} --detach starts it again`, now);
    s.notice = { event: ev.event, at: ev.at };
    s.last_notice = { event: ev.event, at: ev.at };
    return ev;
  });
  if (!ev) return;
  enqueue(paths, [ev]);
  await (opts.deliver ?? deliver)({ paths, env: opts.env, now, platform: process.platform, inHook: false });
}

/** Waits before the next try while holding the session's lease, so the follower still counts as following. */
async function holdLease(paths: Paths, id: string, ms: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const slice = LEASE_STALE_MS / 3;
  for (let left = ms; left > 0; left -= slice) {
    takeLease(paths, id, Date.now(), process.pid, 'shell');
    await sleep(Math.min(left, slice));
  }
}

/**
 * The follower's loop, in the shell: waits on the session again and again, prints the JSON line of each
 * change, and returns at its end (0). A failed wait is tried again after a growing delay, with the lease
 * kept; when it still fails, the loop tells the outputs that nobody follows the session and returns 1.
 */
export async function followLoop(paths: Paths, opts: FollowLoopOptions): Promise<number> {
  const run = opts.wait ?? wait;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  let since: string | null = null;
  let retries = 0;
  let held: string | null = null;
  // Events a follower that stopped left queued go to the outputs first.
  await (opts.deliver ?? deliver)({ paths, env: opts.env, now: Date.now(), platform: process.platform, inHook: false });
  try {
    for (;;) {
      const o = await run(paths, {
        id: opts.id,
        since,
        maxMs: WAIT_DEFAULTS.maxS * 1000,
        minIntervalMs: WAIT_DEFAULTS.minIntervalS * 1000,
        maxIntervalMs: WAIT_DEFAULTS.maxIntervalS * 1000,
        env: opts.env,
        follower: 'shell',
        ...opts.waitOptions,
      });
      if (o.changed || o.error || settled(o)) {
        opts.write(JSON.stringify(o));
        acknowledge(paths, o, 'shell', Date.now());
      }
      if (settled(o)) return 0;
      if (o.error) {
        const next = RETRY_DELAYS_MS[retries++];
        if (next === undefined) {
          await reportStopped(paths, opts);
          return 1;
        }
        held = o.id;
        await holdLease(paths, held, next, sleep);
        continue;
      }
      retries = 0;
      since = o.key;
    }
  } finally {
    if (held) releaseLease(paths, held);
  }
}

/** Starts `kharos follow <id>` in a process of its own, with its output in `log`; returns its pid. */
export type Spawner = (args: string[], log: string, env: NodeJS.ProcessEnv) => number | null;

const CLI = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));

/**
 * Set in the environment of the processes kharos starts itself (a follower process, a reader, a fire of a
 * queued launch), whose Claude Code sessions are kharos's own: the Stop hook does nothing there.
 */
export const ROLE_ENV = 'KHAROS_ROLE';

export const detachedSpawner: Spawner = (args, log, env) => {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    // A session of its own (setsid), so closing the Claude Code that started it, or its process group, leaves it running.
    // The plugin's options (such as the Slack webhook) reach hooks only, never a process that outlives one.
    const child = spawn(process.execPath, [...process.execArgv, CLI, ...args], { detached: true, stdio: ['ignore', fd, fd], env: { ...childEnv(env), [ROLE_ENV]: 'follower' } });
    child.on('error', () => {});
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(fd);
  }
};

export function followerLog(paths: Paths, id: string): string {
  return path.join(paths.logs, `${id}.follower.log`);
}

function need(paths: Paths, ref: string): Session {
  const s = findSession(loadRegistry(paths), ref);
  if (!s) throw new CommandError(`no session ${ref} in the registry (see /kharos:list --all)`);
  return s;
}

/** Starts a detached follower on one open session that no live follower reads. */
export function detachFollower(paths: Paths, ref: string, now: number, env: NodeJS.ProcessEnv, spawner: Spawner = detachedSpawner): string {
  const s = need(paths, ref);
  if (!isFollowed(s)) return `${s.id} is not open (${s.step === 'open' ? s.state : s.step}): there is nothing to follow. /kharos:result ${s.id} shows how it ended.`;
  const log = followerLog(paths, s.id);
  const r = claimFollower(paths, s.id, now, () => spawner(['follow', s.id], log, env));
  if ('busy' in r) return `a live follower already reads ${s.id}.`;
  if ('failed' in r) return `${s.id}: the follower process could not be started; run kharos follow ${s.id} in a shell instead.`;
  return `started a follower process for ${s.id} (pid ${r.started}); it reads the session until it ends, and writes each change to ${log}.`;
}

function outputLabel(o: OutputConfig, paths: Paths): string {
  switch (o.type) {
    case 'notification':
      return 'desktop notifications';
    case 'file':
      return filePath(o.path, paths);
    case 'slack':
      return 'Slack';
    case 'command':
      return `the command ${path.basename(o.argv[0] ?? '')}`;
    case 'firstmate':
      return `firstmate (${o.status_file})`;
  }
}

/** Where the events of these sessions go: the configured outputs and the ones given at launch. */
export function outputsLine(paths: Paths, ids: string[]): string {
  let configured: OutputConfig[] = [];
  try {
    configured = loadConfig(paths).config.outputs;
  } catch {
    // An unreadable configuration delivers nothing; the doctor says why.
  }
  const reg = loadRegistry(paths);
  const extra = ids.flatMap((id) => reg.sessions[id]?.extra_outputs ?? []);
  const labels = [...new Set([...configured, ...extra].map((o) => outputLabel(o, paths)))];
  return labels.length ? `Its events go to ${labels.join(', ')}; kharos list shows the state.` : 'No output is configured, so only kharos list shows the state.';
}

/**
 * What `/kharos:run` and `/kharos:follow` start: in an interactive Claude Code, the prompts of
 * kharos:follow agents; in a headless one, follower processes of their own, unless the person set
 * CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 so the headless process waits for its agents.
 */
export function startFollowers(paths: Paths, ref: string | null, now: number, env: NodeJS.ProcessEnv, spawner: Spawner = detachedSpawner): string {
  if (!isHeadless(env) || waitsForBackground(env)) return followersToStart(paths, ref, now);
  const targets = followTargets(paths, ref, now);
  if (typeof targets === 'string') return targets;
  const lines: string[] = [];
  if (targets.busy.length) lines.push(`a live follower already reads ${targets.busy.join(', ')}.`);
  if (targets.start.length === 0) return lines.join('\n');
  for (const id of targets.start) lines.push(detachFollower(paths, id, now, env, spawner));
  const first = targets.start[0] as string;
  lines.push(
    'This Claude Code runs headless, where background agents are stopped 10 minutes after the last turn, so no follower agent was started: each session above is followed by a process of its own, which goes on after this one exits.',
    outputsLine(paths, targets.start),
    `A question is answered with claude -p '/kharos:send ${first} <answer>' (or /kharos:send in any Claude Code), a permission prompt on the session page.`,
    'To follow with an agent inside a headless launch instead, start it with CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0: it then stays running until the session ends.',
  );
  return lines.join('\n');
}

/** Whether the watcher beat within three of its intervals: it reads the sessions nobody follows. */
function watcherLive(paths: Paths, now: number): boolean {
  const w = loadWatch(paths);
  return w.last_beat !== null && now - Date.parse(w.last_beat) <= 3 * (w.interval_min ?? 10) * 60_000;
}

/**
 * What the Stop hook does at every turn end: starts a follower process for each open session that no
 * follower reads (no live lease and no handover) and whose launch is past its first minute. It reads only
 * local files, and starts nothing while the watcher runs, which reads those sessions already. A follower
 * process is started under the lease's lock, so two turn ends never start two for one session.
 */
export function rearmFollowers(paths: Paths, now: number, env: NodeJS.ProcessEnv, spawner: Spawner = detachedSpawner): { started: string[]; lines: string[] } {
  const open = Object.values(loadRegistry(paths).sessions).filter(isFollowed);
  if (open.length === 0) return { started: [], lines: [] };
  const live = liveFollowers(paths, now);
  const missing = open.filter((s) => !live.has(s.id) && !followerMayBeStarting(s, now)).sort((a, b) => a.id.localeCompare(b.id));
  if (missing.length === 0 || watcherLive(paths, now)) return { started: [], lines: [] };
  const started: string[] = [];
  const lines: string[] = [];
  for (const s of missing) {
    const log = followerLog(paths, s.id);
    const r = claimFollower(paths, s.id, now, () => spawner(['follow', s.id], log, env));
    if ('started' in r) {
      started.push(s.id);
      lines.push(`kharos: ${s.id} had no follower; a follower process reads it now (pid ${r.started}), and writes to ${log}.`);
    } else if ('failed' in r) lines.push(`kharos: ${s.id} has no follower, and a follower process could not be started; type /kharos:follow ${s.id}.`);
  }
  return { started, lines };
}

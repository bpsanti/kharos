// Following without a model: `kharos follow <id>` runs the loop of the kharos:follow agent in the shell,
// and `--detach` starts that loop in a process of its own, which outlives the Claude Code that started it.
// A headless Claude Code (`claude -p`, the Agent SDK) stops its background agents a while after its last
// turn (ten minutes by default, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS), so there a launch is followed this
// way instead of by an agent. What the follower sees reaches the outputs, as for any read.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError } from './commands.ts';
import { loadConfig, type OutputConfig } from './config.ts';
import { liveFollowers } from './lease.ts';
import { filePath } from './outputs/index.ts';
import type { Paths } from './paths.ts';
import { findSession, isFollowed, loadRegistry, type Session } from './registry.ts';
import { followersToStart, followTargets, wait, WAIT_DEFAULTS, type WaitOptions, type WaitOutcome } from './wait.ts';

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

/**
 * The follower's loop, in the shell: waits on the session again and again, prints the JSON line of each
 * change, and returns at its end (0) or when it cannot read it (1).
 */
export async function followLoop(paths: Paths, opts: { id: string; env: NodeJS.ProcessEnv; write: (line: string) => void; wait?: typeof wait; waitOptions?: Partial<WaitOptions> }): Promise<number> {
  const run = opts.wait ?? wait;
  let since: string | null = null;
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
    if (o.changed || o.error || settled(o)) opts.write(JSON.stringify(o));
    if (o.error) return 1;
    if (settled(o)) return 0;
    since = o.key;
  }
}

/** Starts `kharos follow <id>` in a process of its own, with its output in `log`; returns its pid. */
export type Spawner = (args: string[], log: string, env: NodeJS.ProcessEnv) => number | null;

const CLI = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));

export const detachedSpawner: Spawner = (args, log, env) => {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    // A session of its own (setsid), so closing the Claude Code that started it, or its process group, leaves it running.
    const child = spawn(process.execPath, [...process.execArgv, CLI, ...args], { detached: true, stdio: ['ignore', fd, fd], env });
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
  if (liveFollowers(paths, now).has(s.id)) return `a live follower already reads ${s.id}.`;
  const log = followerLog(paths, s.id);
  const pid = spawner(['follow', s.id], log, env);
  if (pid === null) return `${s.id}: the follower process could not be started; run kharos follow ${s.id} in a shell instead.`;
  return `started a follower process for ${s.id} (pid ${pid}); it reads the session until it ends, and writes each change to ${log}.`;
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

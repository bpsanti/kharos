// Delivering queued events to the outputs: the configured ones, plus the extra outputs of each launch.
// Delivery is at least once: an output that fails is tried again on the next delivery, five times at
// most, and then the event is kept aside and shown by /kharos:list.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig, type OutputConfig } from '../config.ts';
import { appendMark, oneLine, readOutbox, type KharosEvent, type OutboxItem } from '../events.ts';
import { appendLine, expandHome, isObject, readState, withLock, writeJsonAtomic } from '../fsutil.ts';
import type { Paths } from '../paths.ts';
import { loadRegistry } from '../registry.ts';
import { childEnv } from './env.ts';
import { LEDGER_TIMEOUT_MS, writeStatus } from './firstmate.ts';

export const MAX_ATTEMPTS = 5;
const DEFAULT_COMMAND_TIMEOUT_S = 10;
const SLACK_TIMEOUT_MS = 5_000;
const NOTIFIER_TIMEOUT_MS = 10_000;
const DELIVERY_LOCK_STALE_MS = 120_000;

export interface Target {
  key: string;
  output: OutputConfig;
}

export function matches(filter: readonly string[] | undefined, ev: KharosEvent): boolean {
  const list = filter ?? ['*'];
  const short = ev.event.slice('session.'.length);
  return list.some((f) => f === '*' || f === ev.class || f === ev.event || f === short);
}

export function targetsFor(configOutputs: readonly OutputConfig[], ev: KharosEvent, extra: readonly OutputConfig[]): Target[] {
  const out: Target[] = [];
  configOutputs.forEach((o, i) => {
    if (matches(o.events, ev)) out.push({ key: `config:${i}:${o.type}`, output: o });
  });
  extra.forEach((o, i) => {
    if (matches(o.events, ev)) out.push({ key: `launch:${ev.session}:${i}:${o.type}`, output: o });
  });
  return out;
}

export interface SendCtx {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  now: number;
  platform: NodeJS.Platform;
  /** Delivery runs inside a hook, where the plugin's sensitive options are in the environment. */
  inHook: boolean;
  /** When set (epoch ms), delivery stops starting outputs at this time and cuts each one short of it. */
  deadline?: number;
  /** Test seam for the Slack POST. */
  fetch?: typeof fetch;
}

/** An output that cannot run in this process (its secret reaches hooks only): try again later, with no attempt counted. */
export class Deferred extends Error {}

export const SLACK_OPTION_ENV = 'CLAUDE_PLUGIN_OPTION_SLACK_WEBHOOK';

/** How long an output may run: its own limit, or what is left before the delivery deadline. */
function limit(ctx: SendCtx, ownMs: number): { ms: number; cut: () => Error | null } {
  const left = ctx.deadline === undefined ? Infinity : ctx.deadline - Date.now();
  const ms = Math.max(1, Math.min(ownMs, left));
  return { ms, cut: () => (ms < ownMs ? new Deferred('the delivery deadline came first') : null) };
}

function title(ev: KharosEvent): string {
  return `kharos ${ev.session}: ${ev.event.slice('session.'.length).replace(/_/g, ' ')}`;
}

function notify(ev: KharosEvent, ctx: SendCtx): void {
  const body = `${ev.title} | ${ev.reason}`;
  const lim = limit(ctx, NOTIFIER_TIMEOUT_MS);
  let r;
  if (ctx.platform === 'darwin') {
    // The texts go as arguments, never inside the script.
    r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title(ev), body], { timeout: lim.ms, env: childEnv(ctx.env) });
  } else if (ctx.platform === 'linux') {
    r = spawnSync('notify-send', ['--app-name=kharos', title(ev), body], { timeout: lim.ms, env: childEnv(ctx.env) });
  } else throw new Error(`no desktop notifier for ${ctx.platform}`);
  if (r.error) throw ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && lim.cut()) || r.error;
  if (r.status !== 0) throw new Error(`notifier exited with ${r.status}`);
}

export function filePath(p: string, paths: Paths): string {
  return expandHome(p.replace(/^\{state\}/, paths.state), paths.home);
}

/** Slack reads <...> as links and mentions (<!channel>); text from a session must not ping anyone. */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function slack(o: Extract<OutputConfig, { type: 'slack' }>, ev: KharosEvent, ctx: SendCtx): Promise<void> {
  const url = ctx.env[o.webhook_env];
  if (!url) {
    if (!ctx.inHook) throw new Deferred(`${o.webhook_env} is only set in hooks`);
    throw new Error(`${o.webhook_env} is not set`);
  }
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new Error(`${o.webhook_env} is not a Slack incoming webhook URL`);
  const text = [`*${slackEscape(title(ev))}*`, slackEscape(ev.title), slackEscape(`${ev.state.replace(/_/g, ' ')}: ${ev.reason}`), ev.pr ? `PR: ${ev.pr}` : '', ev.url ?? ''].filter(Boolean).join('\n');
  const lim = limit(ctx, SLACK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(lim.ms) });
  } catch (err) {
    throw ((err as Error).name === 'TimeoutError' && lim.cut()) || err;
  }
  if (!res.ok) throw new Error(`Slack answered ${res.status}`);
}

/** Runs the command with no shell, the event on stdin, a deadline, and none of the plugin's options in its environment. */
function command(o: Extract<OutputConfig, { type: 'command' }>, ev: KharosEvent, ctx: SendCtx): Promise<void> {
  const [file, ...args] = o.argv as [string, ...string[]];
  const seconds = o.timeout_s ?? DEFAULT_COMMAND_TIMEOUT_S;
  const lim = limit(ctx, seconds * 1000);
  return new Promise((resolve, reject) => {
    const child = spawn(expandHome(file, ctx.paths.home), args, { stdio: ['pipe', 'ignore', 'pipe'], env: childEnv(ctx.env) });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(lim.cut() ?? new Error(`timed out after ${seconds} s`));
    }, lim.ms);
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-300);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exited with ${code}${err ? `: ${err.trim()}` : ''}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(ev) + '\n');
  });
}

export async function send(o: OutputConfig, ev: KharosEvent, ctx: SendCtx): Promise<void> {
  switch (o.type) {
    case 'notification':
      return notify(ev, ctx);
    case 'file': {
      const file = filePath(o.path, ctx.paths);
      // The journal holds every event already, from the moment it was queued.
      if (path.resolve(file) === path.resolve(ctx.paths.events)) return;
      return appendLine(file, JSON.stringify(ev), 0o600);
    }
    case 'slack':
      return slack(o, ev, ctx);
    case 'command':
      return command(o, ev, ctx);
    case 'firstmate':
      return writeStatus({ status_file: expandHome(o.status_file, ctx.paths.home), home: expandHome(o.home, ctx.paths.home), mode: o.mode }, ev, ctx.now, ev.sheet ?? null, ctx.env, limit(ctx, LEDGER_TIMEOUT_MS).ms);
  }
}

export interface FailedDelivery {
  event: KharosEvent;
  target: string;
  error: string;
}

export interface DeliveryReport {
  sent: number;
  failed: number;
  gaveUp: FailedDelivery[];
  skipped: boolean;
  /** The configuration could not be read: every event stays queued until it can. */
  configError: string | null;
}

function failedPath(paths: Paths): string {
  return path.join(paths.state, 'undelivered.json');
}

export function loadUndelivered(paths: Paths): FailedDelivery[] {
  return readState<FailedDelivery[]>(failedPath(paths), (v) => Array.isArray(v) && v.every(isObject), 'a list of undelivered events') ?? [];
}

/** Takes a lock without waiting: when another process is delivering, this one leaves it the work. */
function tryLock(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > DELIVERY_LOCK_STALE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { mode: 0o700 });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

/**
 * Saves one item as soon as its outputs are done with: the queue keeps it while an output still has to
 * receive it, and an event given up on is set aside before it leaves the queue.
 */
function saveItem(paths: Paths, item: OutboxItem, pending: boolean, gaveUp: FailedDelivery[], now: number): void {
  if (gaveUp.length) {
    withLock(failedPath(paths), () => {
      writeJsonAtomic(failedPath(paths), [...loadUndelivered(paths), ...gaveUp].slice(-100));
    });
  }
  withLock(paths.outbox, () => {
    const box = readOutbox(paths);
    const i = box.findIndex((x) => x.event.id === item.event.id);
    if (i < 0) return;
    if (pending) box[i] = item;
    else box.splice(i, 1);
    writeJsonAtomic(paths.outbox, box);
  });
  if (!pending) {
    const lost = item.gave_up ?? [];
    appendMark(paths, { mark: 'delivered', event: item.event.id, session: item.event.session, at: new Date(now).toISOString(), outputs: item.done.filter((k) => !lost.includes(k)), gave_up: lost });
  }
}

export async function deliver(ctx: SendCtx): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, gaveUp: [], skipped: false, configError: null };
  const lock = `${ctx.paths.outbox}.delivering`;
  fs.mkdirSync(ctx.paths.state, { recursive: true, mode: 0o700 });
  if (!tryLock(lock)) return { ...report, skipped: true };
  try {
    let outputs: OutputConfig[] = [];
    try {
      outputs = loadConfig(ctx.paths).config.outputs;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      report.configError = err.message;
    }
    const box = readOutbox(ctx.paths);
    if (box.length === 0) return report;
    const sessions = loadRegistry(ctx.paths).sessions;
    for (const item of box) {
      const extra = sessions[item.event.session]?.extra_outputs ?? [];
      const targets = targetsFor(outputs, item.event, extra);
      const gaveUp: FailedDelivery[] = [];
      let changed = false;
      for (const t of targets) {
        if (item.done.includes(t.key)) continue;
        if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) break;
        try {
          await send(t.output, item.event, ctx);
          item.done.push(t.key);
          report.sent++;
          changed = true;
        } catch (err) {
          if (err instanceof Deferred) continue;
          const attempts = (item.attempts[t.key] ?? 0) + 1;
          item.attempts[t.key] = attempts;
          report.failed++;
          changed = true;
          if (attempts >= MAX_ATTEMPTS) {
            item.done.push(t.key);
            (item.gave_up ??= []).push(t.key);
            gaveUp.push({ event: item.event, target: t.key, error: String((err as Error).message ?? err).slice(0, 300) });
          }
        }
      }
      const pending = report.configError !== null || targets.some((t) => !item.done.includes(t.key));
      if (changed || !pending) saveItem(ctx.paths, item, pending, gaveUp, Date.now());
      report.gaveUp.push(...gaveUp);
      if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) break;
    }
    return report;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function deliveryLine(r: DeliveryReport): string {
  if (r.skipped) return '';
  const parts: string[] = [];
  if (r.configError) parts.push(`events stay queued until the configuration can be read (${r.configError})`);
  if (r.failed) parts.push(`${r.failed} output attempt(s) failed, to retry`);
  for (const g of r.gaveUp) parts.push(`gave up on ${g.target} for ${oneLine(g.event)}: ${g.error}`);
  return parts.join('; ');
}

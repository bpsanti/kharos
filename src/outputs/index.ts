// Delivering queued events to the outputs: the configured ones, plus the extra outputs of each launch.
// Delivery is at least once: an output that fails is tried again on the next delivery, five times at
// most, and then the event is kept aside and shown by /kharos:list.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig, type OutputConfig } from '../config.ts';
import { oneLine, readOutbox, type KharosEvent, type OutboxItem } from '../events.ts';
import { appendLine, expandHome, isObject, readState, withLock, writeJsonAtomic } from '../fsutil.ts';
import type { Paths } from '../paths.ts';
import { loadRegistry } from '../registry.ts';
import { writeStatus } from './firstmate.ts';

export const MAX_ATTEMPTS = 5;
const DEFAULT_COMMAND_TIMEOUT_S = 10;
const SLACK_TIMEOUT_MS = 5_000;
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
  /** Test seam for the Slack POST. */
  fetch?: typeof fetch;
}

/** An output that cannot run in this process (its secret reaches hooks only): try again later, with no attempt counted. */
export class Deferred extends Error {}

export const SLACK_OPTION_ENV = 'CLAUDE_PLUGIN_OPTION_SLACK_WEBHOOK';

function title(ev: KharosEvent): string {
  return `kharos ${ev.session}: ${ev.event.slice('session.'.length).replace(/_/g, ' ')}`;
}

function notify(ev: KharosEvent, ctx: SendCtx): void {
  const body = `${ev.title} | ${ev.reason}`;
  let r;
  if (ctx.platform === 'darwin') {
    // The texts go as arguments, never inside the script.
    r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title(ev), body], { timeout: 10_000 });
  } else if (ctx.platform === 'linux') {
    r = spawnSync('notify-send', ['--app-name=kharos', title(ev), body], { timeout: 10_000 });
  } else throw new Error(`no desktop notifier for ${ctx.platform}`);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`notifier exited with ${r.status}`);
}

export function filePath(p: string, paths: Paths): string {
  return expandHome(p.replace(/^\{state\}/, paths.state), paths.home);
}

async function slack(o: Extract<OutputConfig, { type: 'slack' }>, ev: KharosEvent, ctx: SendCtx): Promise<void> {
  const url = ctx.env[o.webhook_env];
  if (!url) {
    if (!ctx.inHook) throw new Deferred(`${o.webhook_env} is only set in hooks`);
    throw new Error(`${o.webhook_env} is not set`);
  }
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new Error(`${o.webhook_env} is not a Slack incoming webhook URL`);
  const text = [`*${title(ev)}*`, `${ev.title}`, `${ev.state.replace(/_/g, ' ')}: ${ev.reason}`, ev.pr ? `PR: ${ev.pr}` : '', ev.url ?? ''].filter(Boolean).join('\n');
  const res = await (ctx.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}`);
}

/** Runs the command with no shell, the event on stdin, and a deadline. */
function command(o: Extract<OutputConfig, { type: 'command' }>, ev: KharosEvent, ctx: SendCtx): Promise<void> {
  const [file, ...args] = o.argv as [string, ...string[]];
  return new Promise((resolve, reject) => {
    const child = spawn(expandHome(file, ctx.paths.home), args, { stdio: ['pipe', 'ignore', 'pipe'], env: ctx.env });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${o.timeout_s ?? DEFAULT_COMMAND_TIMEOUT_S} s`));
    }, (o.timeout_s ?? DEFAULT_COMMAND_TIMEOUT_S) * 1000);
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
    case 'file':
      return appendLine(filePath(o.path, ctx.paths), JSON.stringify(ev), 0o600);
    case 'slack':
      return slack(o, ev, ctx);
    case 'command':
      return command(o, ev, ctx);
    case 'firstmate':
      return writeStatus({ status_file: expandHome(o.status_file, ctx.paths.home), home: expandHome(o.home, ctx.paths.home), mode: o.mode }, ev, ctx.now, ev.sheet ?? null);
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

export async function deliver(ctx: SendCtx): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, gaveUp: [], skipped: false };
  const lock = `${ctx.paths.outbox}.delivering`;
  fs.mkdirSync(ctx.paths.state, { recursive: true, mode: 0o700 });
  if (!tryLock(lock)) return { ...report, skipped: true };
  try {
    let outputs: OutputConfig[] = [];
    try {
      outputs = loadConfig(ctx.paths).config.outputs;
    } catch (err) {
      if (!(err instanceof ConfigError) && !(err instanceof SyntaxError)) throw err;
    }
    const box = readOutbox(ctx.paths);
    if (box.length === 0) return report;
    const sessions = loadRegistry(ctx.paths).sessions;
    const results = new Map<string, OutboxItem>();
    for (const item of box) {
      const extra = sessions[item.event.session]?.extra_outputs ?? [];
      for (const t of targetsFor(outputs, item.event, extra)) {
        if (item.done.includes(t.key)) continue;
        try {
          await send(t.output, item.event, ctx);
          item.done.push(t.key);
          report.sent++;
        } catch (err) {
          if (err instanceof Deferred) continue;
          const attempts = (item.attempts[t.key] ?? 0) + 1;
          item.attempts[t.key] = attempts;
          report.failed++;
          if (attempts >= MAX_ATTEMPTS) {
            item.done.push(t.key);
            report.gaveUp.push({ event: item.event, target: t.key, error: String((err as Error).message ?? err).slice(0, 300) });
          }
        }
      }
      const pending = targetsFor(outputs, item.event, extra).some((t) => !item.done.includes(t.key));
      if (pending) results.set(item.event.id, item);
    }
    // Events queued while this delivery ran are kept as they are.
    withLock(ctx.paths.outbox, () => {
      const now = readOutbox(ctx.paths);
      const delivered = new Set(box.map((b) => b.event.id));
      const next = [...results.values(), ...now.filter((x) => !delivered.has(x.event.id))];
      writeJsonAtomic(ctx.paths.outbox, next);
    });
    if (report.gaveUp.length) {
      withLock(failedPath(ctx.paths), () => {
        const list = loadUndelivered(ctx.paths);
        writeJsonAtomic(failedPath(ctx.paths), [...list, ...report.gaveUp].slice(-100));
      });
    }
    return report;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function deliveryLine(r: DeliveryReport): string {
  if (r.skipped) return '';
  const parts: string[] = [];
  if (r.failed) parts.push(`${r.failed} output attempt(s) failed, to retry`);
  for (const g of r.gaveUp) parts.push(`gave up on ${g.target} for ${oneLine(g.event)}: ${g.error}`);
  return parts.join('; ');
}

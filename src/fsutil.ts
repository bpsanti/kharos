// File helpers shared by the registry and the state files: atomic JSON writes, private modes, and an
// advisory lock that a crashed holder cannot keep forever.

import fs from 'node:fs';
import path from 'node:path';

/** A kharos state file that exists but cannot be read, parsed, or has the wrong shape. */
export class StateError extends Error {
  readonly file: string;
  readonly reason: string;
  constructor(file: string, reason: string) {
    super(`kharos: state could not be read (${file}): ${reason}. Do not run again; show this to the person.`);
    this.file = file;
    this.reason = reason;
  }
}

/** Reads a state file; a missing file is undefined, anything unreadable or wrongly shaped is a StateError. */
export function readState<T>(file: string, valid: (v: unknown) => boolean, shape: string): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new StateError(file, (err as Error).message);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new StateError(file, `invalid JSON (${(err as Error).message})`);
  }
  if (!valid(value)) throw new StateError(file, `it is not ${shape}`);
  return value as T;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);
}

export function writeTextAtomic(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function appendLine(file: string, line: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n', { mode });
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 20_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` while holding a lock directory next to `file`.
 * A lock older than LOCK_STALE_MS is taken over: the holders are short CLI and hook processes, so an old
 * lock means its holder died.
 */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`kharos: ${lock} is held by another process`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

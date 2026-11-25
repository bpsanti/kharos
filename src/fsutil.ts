// File helpers shared by the registry and the state files: atomic JSON writes, private modes, and an
// advisory lock that a crashed holder cannot keep forever.

import fs from 'node:fs';
import path from 'node:path';

export function readJson<T>(file: string): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths, type Paths } from '../src/paths.ts';
import type { Ctx } from '../src/hook.ts';
import type { RemoteHeads } from '../src/repo.ts';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export interface Sandbox {
  dir: string;
  env: NodeJS.ProcessEnv;
  paths: Paths;
  ctx: (now: number) => Ctx;
}

/**
 * A KHAROS_HOME in a temporary folder, with a fake `claude` binary that answers `auth status` and
 * `-p --cloud` the way the real one does.
 */
export function sandbox(opts: { auth?: Record<string, unknown>; send?: Record<string, unknown> } = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kharos-test-'));
  const auth = opts.auth ?? { loggedIn: true, authMethod: 'claude.ai', orgId: 'org-test', email: 'person@example.com', subscriptionType: 'max' };
  const send = opts.send ?? { ok: true, session_id: 'cse_01TESTSESSIONAAAAAAAAAAA', url: 'https://claude.ai/code/session_01TESTSESSIONAAAAAAAAAAA' };
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `if [ "$1" = auth ]; then printf '%s\\n' '${JSON.stringify(auth)}'; exit 0; fi`,
      `if [ "$1" = --version ]; then echo '2.1.332 (Claude Code)'; exit 0; fi`,
      `if [ "$1" = -p ]; then cat > "${dir}/sent.txt"; printf '%s\\n' '${JSON.stringify(send)}'; exit 0; fi`,
      'exit 1',
    ].join('\n'),
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = { HOME: dir, KHAROS_HOME: path.join(dir, 'kharos'), KHAROS_CLAUDE_BIN: bin, PATH: process.env.PATH ?? '' };
  const paths = resolvePaths(env);
  return { dir, env, paths, ctx: (now: number) => ({ paths, now, env, ownerType: () => null }) };
}

export const HEADS_OK: RemoteHeads = { readable: true, empty: false, defaultBranch: 'main', hasRevision: true, error: null };
export const HEADS_EMPTY: RemoteHeads = { readable: true, empty: true, defaultBranch: null, hasRevision: false, error: null };

export function writeConfig(sb: Sandbox, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(sb.paths.config), { recursive: true });
  fs.writeFileSync(
    sb.paths.config,
    JSON.stringify({
      version: 1,
      default_profile: 'demo',
      profiles: { demo: { repo: 'https://github.com/example/demo', environment: 'env_01TESTENVIRONMENT' } },
      outputs: [],
      ...extra,
    }),
  );
}

/** A RemoteTrigger answer as hooks receive it. */
export function response(status: number, json: unknown, summary = ''): Record<string, unknown> {
  const out: Record<string, unknown> = { status, json: typeof json === 'string' ? json : JSON.stringify(json) };
  if (summary) out.summary = summary;
  return out;
}

export const T0 = Date.parse('2026-11-25T18:57:30Z');

/** Runs `fn` with stdout and stderr captured, the way a hook or command prints them. */
export function captured<T>(fn: () => T): { value: T; stdout: string; stderr: string } {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const outs: string[] = [];
  const errs: string[] = [];
  process.stdout.write = ((c: string) => {
    outs.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => {
    errs.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), stdout: outs.join(''), stderr: errs.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

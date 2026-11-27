// Newer releases of kharos: the latest one on GitHub, read at most once a day for a one-line notice, and in
// full by /kharos:doctor, which shows what changed and updates the plugin once the person says yes.
// The daily read runs in a detached process, so it never slows or fails the command that asked for it, and
// any network or parse failure is silent.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeBin } from './account.ts';
import { loadConfig } from './config.ts';
import { isObject, writeJsonAtomic } from './fsutil.ts';
import { childEnv } from './outputs/env.ts';
import type { Paths } from './paths.ts';

/** The GitHub repository kharos is released from. */
export const RELEASE_REPO = 'bpsanti/kharos';
const DEFAULT_API = `https://api.github.com/repos/${RELEASE_REPO}`;

/** How long a read of the latest release holds before the next one, and the least time between two notices. */
export const RELEASE_TTL_MS = 24 * 3600_000;
/** The daily read runs in its own process, which may wait this long for GitHub. */
const BACKGROUND_TIMEOUT_MS = 10_000;
/** /kharos:doctor waits this long for GitHub, since the person asked for the answer. */
export const DOCTOR_TIMEOUT_MS = 5_000;

/** The base of GitHub's API for kharos's releases; `KHAROS_RELEASES_API=off` turns every release read off. */
export function releasesApi(env: NodeJS.ProcessEnv): string | null {
  const v = env.KHAROS_RELEASES_API?.trim();
  if (v === 'off') return null;
  return (v || DEFAULT_API).replace(/\/+$/, '');
}

/** One HTTP GET: its status and body, or an error when there is no answer. */
export type Fetcher = (url: string, accept: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

export const httpFetcher: Fetcher = async (url, accept, timeoutMs) => {
  const res = await fetch(url, { headers: { accept, 'user-agent': 'kharos' }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
};

/** A release version, x.y.z; null for anything else, a prerelease included. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b, zero when equal, positive when newer; both must be versions. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}

/** The version GitHub names as kharos's latest release, or why it could not be read. */
export async function readLatest(env: NodeJS.ProcessEnv, fetcher: Fetcher, timeoutMs: number): Promise<{ version: string } | { error: string }> {
  const api = releasesApi(env);
  if (!api) return { error: 'release checks are off (KHAROS_RELEASES_API=off)' };
  try {
    const r = await fetcher(`${api}/releases/latest`, 'application/vnd.github+json', timeoutMs);
    if (r.status !== 200) return { error: `GitHub answered ${r.status}` };
    const body: unknown = JSON.parse(r.text);
    const tag = isObject(body) ? body.tag_name : undefined;
    const v = parseVersion(tag);
    if (!v) return { error: `the latest release has no version tag (${typeof tag === 'string' ? tag : 'none'})` };
    return { version: v.join('.') };
  } catch (err) {
    return { error: err instanceof SyntaxError ? 'GitHub answered something that is not JSON' : (err as Error).message || String(err) };
  }
}

/** CHANGELOG.md as it is at a release's tag, or null when it cannot be read. */
export async function readChangelog(env: NodeJS.ProcessEnv, version: string, fetcher: Fetcher, timeoutMs: number): Promise<string | null> {
  const api = releasesApi(env);
  if (!api) return null;
  try {
    const r = await fetcher(`${api}/contents/CHANGELOG.md?ref=v${version}`, 'application/vnd.github.raw', timeoutMs);
    return r.status === 200 ? r.text : null;
  } catch {
    return null;
  }
}

/** The sections of a CHANGELOG for the versions after `from`, up to and including `to`, newest first. */
export function changesBetween(changelog: string, from: string, to: string): string {
  const sections: string[] = [];
  let current: { version: string; lines: string[] } | null = null;
  const close = () => {
    if (current && compareVersions(current.version, from) > 0 && compareVersions(current.version, to) <= 0) sections.push(current.lines.join('\n').trim());
    current = null;
  };
  for (const line of changelog.split('\n')) {
    if (line.startsWith('## ')) {
      close();
      const v = parseVersion(line.slice(3));
      if (v) current = { version: v.join('.'), lines: [line] };
    } else current?.lines.push(line);
  }
  close();
  return sections.join('\n\n');
}

/** What the last read of the latest release found, and when the last notice was shown. */
export interface ReleaseCache {
  checked_at: string;
  latest: string | null;
  error?: string;
  notified_at?: string;
}

export function loadReleaseCache(paths: Paths): ReleaseCache | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(paths.release, 'utf8'));
    if (!isObject(v) || typeof v.checked_at !== 'string' || Number.isNaN(Date.parse(v.checked_at))) return null;
    const latest = parseVersion(v.latest)?.join('.') ?? null;
    return {
      checked_at: v.checked_at,
      latest,
      ...(typeof v.error === 'string' ? { error: v.error } : {}),
      ...(typeof v.notified_at === 'string' && !Number.isNaN(Date.parse(v.notified_at)) ? { notified_at: v.notified_at } : {}),
    };
  } catch {
    return null;
  }
}

function saveReleaseCache(paths: Paths, cache: ReleaseCache): void {
  writeJsonAtomic(paths.release, cache);
}

/** Reads the latest release and stores the answer, keeping the time of the last notice. */
export async function refreshRelease(paths: Paths, env: NodeJS.ProcessEnv, now: number, fetcher: Fetcher, timeoutMs: number): Promise<ReleaseCache> {
  const r = await readLatest(env, fetcher, timeoutMs);
  const prev = loadReleaseCache(paths);
  const cache: ReleaseCache = {
    checked_at: new Date(now).toISOString(),
    latest: 'version' in r ? r.version : (prev?.latest ?? null),
    ...('error' in r ? { error: r.error } : {}),
    ...(prev?.notified_at ? { notified_at: prev.notified_at } : {}),
  };
  try {
    saveReleaseCache(paths, cache);
  } catch {
    // a cache that cannot be written only means the next command reads again
  }
  return cache;
}

/** The folder kharos runs from: the plugin's, or the npm package's. */
export function kharosRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith('.ts') ? '..' : '../..');
}

/** The version of the kharos that runs now, from its package.json; null when it cannot be read. */
export function installedVersion(root: string = kharosRoot()): string | null {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return isObject(pkg) ? (parseVersion(pkg.version)?.join('.') ?? null) : null;
  } catch {
    return null;
  }
}

/** How this kharos was installed, which decides how it is updated. */
export type Install = { kind: 'plugin'; marketplace: string } | { kind: 'git' } | { kind: 'other' };

/** Claude Code keeps an installed plugin in <config dir>/plugins/cache/<marketplace>/<plugin>/<version>. */
export function installOf(root: string): Install {
  const m = path.resolve(root).split(path.sep).join('/').match(/\/plugins\/cache\/([^/]+)\/kharos\/[^/]+$/);
  if (m) return { kind: 'plugin', marketplace: m[1] as string };
  return fs.existsSync(path.join(root, '.git')) ? { kind: 'git' } : { kind: 'other' };
}

/** The commands that update the kharos plugin of a marketplace, in order. */
export function updateCommands(marketplace: string): string[][] {
  return [
    ['plugin', 'marketplace', 'update', marketplace],
    ['plugin', 'update', `kharos@${marketplace}`],
  ];
}

const CLI = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));

/** Starts `kharos release-check` in a process of its own, which outlives the command that started it. */
export type RefreshSpawner = (env: NodeJS.ProcessEnv) => void;

export const detachedRefresh: RefreshSpawner = (env) => {
  const child = spawn(process.execPath, [...process.execArgv, CLI, 'release-check'], { detached: true, stdio: 'ignore', env: childEnv(env) });
  child.on('error', () => {});
  child.unref();
};

/** `kharos release-check`: the daily read, run by the detached process. */
export async function backgroundCheck(paths: Paths, env: NodeJS.ProcessEnv, now: number, fetcher: Fetcher = httpFetcher): Promise<void> {
  await refreshRelease(paths, env, now, fetcher, BACKGROUND_TIMEOUT_MS);
}

export function noticeText(latest: string, installed: string): string {
  return `kharos ${latest} is available (you have ${installed}); /kharos:doctor shows what changed and updates it.`;
}

/**
 * The one line a command the person runs (run, list) adds when a newer kharos is out, at most once a day;
 * null otherwise. It reads only the cache: when that is older than a day, a detached process reads GitHub
 * again for the next command. It never throws and never waits for the network.
 */
export function updateNotice(paths: Paths, env: NodeJS.ProcessEnv, now: number, refresh: RefreshSpawner = detachedRefresh, installed: string | null = installedVersion()): string | null {
  try {
    if (!releasesApi(env)) return null;
    let notify = true;
    try {
      notify = loadConfig(paths).config.update.notify;
    } catch {
      // a configuration the command itself reports as broken does not hide the notice
    }
    if (!notify || !installed) return null;
    const cache = loadReleaseCache(paths);
    if (!cache || now - Date.parse(cache.checked_at) >= RELEASE_TTL_MS) {
      // Marked before the process starts, so commands run meanwhile start no other.
      saveReleaseCache(paths, { checked_at: new Date(now).toISOString(), latest: cache?.latest ?? null, ...(cache?.notified_at ? { notified_at: cache.notified_at } : {}) });
      refresh(env);
    }
    if (!cache?.latest || compareVersions(cache.latest, installed) <= 0) return null;
    if (cache.notified_at && now - Date.parse(cache.notified_at) < RELEASE_TTL_MS) return null;
    const fresh = loadReleaseCache(paths) ?? cache;
    saveReleaseCache(paths, { ...fresh, notified_at: new Date(now).toISOString() });
    return noticeText(cache.latest, installed);
  } catch {
    return null;
  }
}

/** What /kharos:doctor knows about kharos's own version. */
export interface ReleaseView {
  installed: string | null;
  install: Install;
  /** The latest release, or null with the reason it could not be read. */
  latest: string | null;
  error: string | null;
  /** The CHANGELOG sections between the installed version and the latest; null when not newer or not readable. */
  changes: string | null;
  /** The version of a kharos command installed globally from npm, when there is one. */
  npm: string | null;
}

/** The version of the `kharos` npm package installed globally, or null. */
export function npmGlobalVersion(env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('npm', ['ls', '-g', 'kharos', '--depth=0', '--json'], { encoding: 'utf8', timeout: 15_000, env });
  if (r.error || !r.stdout) return null;
  try {
    const v: unknown = JSON.parse(r.stdout);
    const deps = isObject(v) && isObject(v.dependencies) ? v.dependencies : null;
    const k = deps && isObject(deps.kharos) ? deps.kharos.version : undefined;
    return parseVersion(k)?.join('.') ?? null;
  } catch {
    return null;
  }
}

export interface ReleaseDeps {
  fetcher: Fetcher;
  root: string;
  npmVersion: () => string | null;
}

export function realReleaseDeps(env: NodeJS.ProcessEnv): ReleaseDeps {
  return { fetcher: httpFetcher, root: kharosRoot(), npmVersion: () => npmGlobalVersion(env) };
}

/** Reads the latest release now, for /kharos:doctor, with what changed since the installed version. */
export async function readReleaseView(paths: Paths, env: NodeJS.ProcessEnv, now: number, deps: ReleaseDeps): Promise<ReleaseView> {
  const installed = installedVersion(deps.root);
  const install = installOf(deps.root);
  const r = await readLatest(env, deps.fetcher, DOCTOR_TIMEOUT_MS);
  if ('version' in r) {
    const prev = loadReleaseCache(paths);
    try {
      saveReleaseCache(paths, { checked_at: new Date(now).toISOString(), latest: r.version, ...(prev?.notified_at ? { notified_at: prev.notified_at } : {}) });
    } catch {
      // the doctor's own answer does not depend on the cache
    }
  }
  const latest = 'version' in r ? r.version : null;
  let changes: string | null = null;
  if (latest && installed && compareVersions(latest, installed) > 0) {
    const text = await readChangelog(env, latest, deps.fetcher, DOCTOR_TIMEOUT_MS);
    changes = text === null ? null : changesBetween(text, installed, latest) || null;
  }
  return { installed, install, latest, error: 'error' in r ? r.error : null, changes, npm: latest ? deps.npmVersion() : null };
}

/** Whether a newer release than the installed kharos is out. */
export function updateAvailable(v: ReleaseView): boolean {
  return !!v.latest && !!v.installed && compareVersions(v.latest, v.installed) > 0;
}

/** The line the doctor skill looks for to offer the update; only an install it can update itself gets it. */
export const UPDATE_OFFER = 'update available:';

/** The part of the doctor's report about kharos itself, printed after the checks. */
export function formatRelease(v: ReleaseView): string {
  if (!updateAvailable(v)) return '';
  const lines: string[] = [];
  lines.push(`What changed from ${v.installed} to ${v.latest} (CHANGELOG.md):`);
  lines.push(v.changes ?? `The changelog could not be read; see https://github.com/${RELEASE_REPO}/releases.`);
  lines.push('');
  if (v.install.kind === 'plugin') {
    const cmds = updateCommands(v.install.marketplace).map((c) => `\`claude ${c.join(' ')}\``);
    lines.push(`${UPDATE_OFFER} ${v.latest} (runs ${cmds.join(' then ')}, then Claude Code needs a restart)`);
  }
  return lines.join('\n');
}

/** The outcome of `kharos doctor --update <version>`. */
export interface UpdateOutcome {
  ok: boolean;
  lines: string[];
}

/** Runs a claude command with this account's config folder, as Claude Code would; its exit status and output. */
export type ClaudeRunner = (args: string[]) => { status: number | null; output: string };

export function realClaudeRunner(env: NodeJS.ProcessEnv): ClaudeRunner {
  return (args) => {
    const r = spawnSync(claudeBin(env), args, { encoding: 'utf8', timeout: 180_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.error ? null : r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
  };
}

/**
 * Updates the kharos plugin to `expect`, the version the person said yes to: refused, with nothing run,
 * unless that is still the latest release, newer than the installed one, and this kharos is a plugin.
 */
export function applyUpdate(v: ReleaseView, expect: string, run: ClaudeRunner): UpdateOutcome {
  const want = parseVersion(expect)?.join('.');
  if (!want) return { ok: false, lines: [`not updated: "${expect}" is not a version`] };
  if (!v.latest) return { ok: false, lines: [`not updated: the latest release could not be read (${v.error ?? 'no answer'})`] };
  if (!updateAvailable(v)) return { ok: false, lines: [`not updated: kharos ${v.installed ?? 'of unknown version'} is already the latest release (${v.latest})`] };
  if (want !== v.latest) return { ok: false, lines: [`not updated: the latest release is ${v.latest}, not ${want}; run /kharos:doctor again`] };
  if (v.install.kind !== 'plugin') return { ok: false, lines: [`not updated: this kharos is not installed as a Claude Code plugin; ${manualUpdate(v)}`] };
  const lines: string[] = [];
  for (const args of updateCommands(v.install.marketplace)) {
    const r = run(args);
    lines.push(`claude ${args.join(' ')}: ${r.status === 0 ? 'done' : `failed (${r.status ?? 'did not run'})`}${r.output ? `\n  ${r.output.split('\n').join('\n  ')}` : ''}`);
    if (r.status !== 0) {
      lines.push('kharos was not updated; the output above says why.');
      return { ok: false, lines };
    }
  }
  lines.push(`kharos ${want} is installed: restart Claude Code to load it.`);
  const npm = npmUpdate(v);
  if (npm) lines.push(`The kharos command from npm is ${v.npm}: run \`${npm}\` to update it too.`);
  return { ok: true, lines };
}

/** How to update a kharos that is not a plugin of a marketplace. */
export function manualUpdate(v: ReleaseView): string {
  return v.install.kind === 'git' ? 'run `git pull` in its folder' : `install it again from https://github.com/${RELEASE_REPO}`;
}

/** The command that updates a kharos command installed from npm, when it is older than the latest release. */
export function npmUpdate(v: ReleaseView): string | null {
  if (!v.npm || !v.latest || compareVersions(v.npm, v.latest) >= 0) return null;
  return `npm install -g kharos@${v.latest}`;
}

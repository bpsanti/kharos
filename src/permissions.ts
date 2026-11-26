// /kharos:permissions: the permission rules a repository gives its cloud sessions, and the change to a
// permission profile, always shown as a diff first. Only `write` changes the file, only with the token of
// the diff the person saw, and only in the local checkout: kharos never commits or pushes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CommandError } from './commands.ts';
import { ConfigError, loadConfig, normalizeRepo, repoSlug } from './config.ts';
import type { Paths } from './paths.ts';
import {
  applyProfile,
  assess,
  changeToken,
  describeRules,
  identify,
  isPermissionProfile,
  parseSettings,
  PERMISSION_PROFILES,
  PROFILE_SUMMARY,
  readFacts,
  readRules,
  renderSettings,
  SETTINGS_PATH,
  SettingsError,
  unifiedDiff,
  type PermissionProfile,
  type RepoFacts,
} from './permission-profiles.ts';

interface Checkout {
  root: string;
  origin: string | null;
}

function git(dir: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
}

function checkout(dir: string, env: NodeJS.ProcessEnv): Checkout {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new CommandError(`${abs} does not exist`);
  const root = git(abs, ['rev-parse', '--show-toplevel'], env);
  if (!root) throw new CommandError(`${abs} is not inside a git checkout; name the folder of the repository's checkout`);
  return { root, origin: git(root, ['remote', 'get-url', 'origin'], env) };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function localFacts(root: string): RepoFacts {
  const files = fs.readdirSync(root);
  const make = ['GNUmakefile', 'makefile', 'Makefile'].find((f) => files.includes(f));
  return readFacts(files, readText(path.join(root, 'package.json')), make ? readText(path.join(root, make)) : null);
}

/** The kharos launch profiles that start sessions on this checkout's repository, and their branches. */
function launchProfiles(paths: Paths, origin: string | null): string[] {
  if (!origin) return [];
  let profiles;
  try {
    profiles = loadConfig(paths).config.profiles;
  } catch (err) {
    if (err instanceof ConfigError) return [];
    throw err;
  }
  const repo = normalizeRepo(origin);
  return Object.entries(profiles)
    .filter(([, p]) => p.repo === repo)
    .map(([name, p]) => `${name} (branch ${p.revision})`);
}

function settingsOf(text: string | null): ReturnType<typeof parseSettings> {
  try {
    return parseSettings(text);
  } catch (err) {
    if (err instanceof SettingsError) throw new CommandError(err.message);
    throw err;
  }
}

function rulesOf(settings: Record<string, unknown>): ReturnType<typeof readRules> {
  try {
    return readRules(settings);
  } catch (err) {
    if (err instanceof SettingsError) throw new CommandError(`${SETTINGS_PATH}: ${err.message}; kharos does not edit it`);
    throw err;
  }
}

export function showPermissions(paths: Paths, dir: string, env: NodeJS.ProcessEnv): string {
  const co = checkout(dir, env);
  const file = path.join(co.root, SETTINGS_PATH);
  const text = readText(file);
  const rules = rulesOf(settingsOf(text));
  const lines = [`${file}${text === null ? ': no file' : ''}`, `permission profile: ${identify(rules)}`, ...describeRules(rules).map((l) => `  ${l}`)];
  for (const f of assess(rules)) lines.push(`${f.level}: ${f.text}`);
  if (fs.existsSync(path.join(co.root, '.claude', 'settings.local.json'))) lines.push('info: .claude/settings.local.json exists here; cloud sessions do not read it, since it is not in the clone');
  const launches = launchProfiles(paths, co.origin);
  if (launches.length) lines.push(`kharos launch profiles on ${repoSlug(co.origin as string)}: ${launches.join(', ')}; their sessions read the file from that branch`);
  lines.push(`permission profiles: ${PERMISSION_PROFILES.map((p) => `${p} (${PROFILE_SUMMARY[p]})`).join('; ')}`);
  return lines.join('\n');
}

interface Plan {
  file: string;
  before: string | null;
  after: string | null;
  token: string | null;
  summary: string;
}

function plan(dir: string, profile: PermissionProfile, env: NodeJS.ProcessEnv): Plan & { co: Checkout } {
  const co = checkout(dir, env);
  const file = path.join(co.root, SETTINGS_PATH);
  const before = readText(file);
  const settings = settingsOf(before);
  const rules = rulesOf(settings);
  const next = applyProfile(settings, profile, localFacts(co.root));
  const after = renderSettings(next, before);
  if (profile === 'default' || (before !== null && JSON.stringify(next) === JSON.stringify(settings))) {
    return { co, file, before, after: null, token: null, summary: `permission profile ${profile}: nothing to change in ${file}` };
  }
  const added = readRules(next).allow.length - rules.allow.length;
  const summary = `permission profile ${profile} for ${file}: adds ${added} allow rule(s); ask and deny rules stay as they are`;
  return { co, file, before, after, token: changeToken(before, after), summary };
}

function validProfile(name: string): PermissionProfile {
  if (!isPermissionProfile(name)) throw new CommandError(`the permission profile is one of ${PERMISSION_PROFILES.join(', ')}`);
  return name;
}

export function diffPermissions(dir: string, profileName: string, env: NodeJS.ProcessEnv): string {
  const p = plan(dir, validProfile(profileName), env);
  if (!p.after || !p.token) return p.summary;
  return [
    p.summary,
    unifiedDiff(p.before, p.after, path.relative(p.co.root, p.file)),
    `change ${p.token}: nothing is written until the person approves this diff; then run \`kharos permissions write ${profileName} --expect ${p.token} ${p.co.root}\``,
  ].join('\n');
}

export function writePermissions(paths: Paths, dir: string, profileName: string, expect: string | undefined, env: NodeJS.ProcessEnv): string {
  if (!expect) throw new CommandError('--expect needs the change token that `kharos permissions diff` printed, so only an approved diff is written');
  const p = plan(dir, validProfile(profileName), env);
  if (!p.after || !p.token) return p.summary;
  if (p.token !== expect) throw new CommandError(`${p.file} is not what that diff was made from (the file changed, or the diff was for another change); nothing was written. Show the diff again.`);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  const tmp = `${p.file}.kharos-${process.pid}.tmp`;
  fs.writeFileSync(tmp, p.after, { mode: p.before === null ? 0o644 : fs.statSync(p.file).mode & 0o777 });
  fs.renameSync(tmp, p.file);
  const launches = launchProfiles(paths, p.co.origin);
  const where = launches.length ? ` (kharos launch profiles on this repository: ${launches.join(', ')})` : '';
  return [
    `wrote ${p.file} (${profileName}). Nothing was committed or pushed.`,
    `Cloud sessions read the file from the branch they start on${where}: review it, commit it and push it there yourself.`,
  ].join('\n');
}

export type RemoteSettings = { status: 'found'; text: string } | { status: 'absent' } | { status: 'unreadable'; error: string };

/** The repository's settings file on the branch sessions start on, through the person's own gh. */
export function readRemoteSettings(repo: string, revision: string, env: NodeJS.ProcessEnv = process.env): RemoteSettings {
  const slug = repoSlug(repo);
  const gh = (args: string[]) => spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000, env });
  const r = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${slug}/contents/${SETTINGS_PATH}?ref=${encodeURIComponent(revision)}`]);
  if (r.error) return { status: 'unreadable', error: 'gh is not installed' };
  if (r.status === 0) return { status: 'found', text: r.stdout };
  const err = `${r.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  // GitHub answers 404 both for a missing file and for a repository gh cannot see: tell them apart.
  if (/\b404\b|not found/i.test(err) && gh(['api', `repos/${slug}`, '--jq', '.full_name']).status === 0) return { status: 'absent' };
  return { status: 'unreadable', error: err.slice(0, 200) || 'gh api failed' };
}

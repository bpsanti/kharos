// Repository readiness: what a cloud session needs from a GitHub repository before it can start, and
// the exact fix for each gap. Local checks use the person's own git and gh; the Claude side (the Claude
// GitHub App or /web-setup) can only be seen through the service, which answers a routine create with
// repo_access_denied before any session exists.

import { spawnSync } from 'node:child_process';
import { isObject, readState, withLock, writeJsonAtomic } from './fsutil.ts';
import { ghSpawnError } from './forge.ts';
import { repoSlug } from './config.ts';
import type { Paths } from './paths.ts';

export type Access = 'ok' | 'denied' | 'unknown';

export interface RepoRecord {
  access: Access;
  checked_at: string;
  reason: string | null;
}

export type RepoBook = Record<string, RepoRecord>;

export function loadRepos(paths: Paths): RepoBook {
  return readState<RepoBook>(paths.repos, (v) => isObject(v) && Object.values(v).every(isObject), 'an object of repositories') ?? {};
}

export function recordAccess(paths: Paths, repo: string, access: Access, reason: string | null, now: number): void {
  withLock(paths.repos, () => {
    const book = loadRepos(paths);
    book[repoSlug(repo)] = { access, checked_at: new Date(now).toISOString(), reason };
    writeJsonAtomic(paths.repos, book);
  });
}

export interface RemoteHeads {
  /** false: the remote could not be read with the local credentials. */
  readable: boolean;
  empty: boolean;
  defaultBranch: string | null;
  hasRevision: boolean;
  error: string | null;
}

/** Parses `git ls-remote --symref <url> HEAD <revision>`. */
export function parseLsRemote(out: string, revision: string): Omit<RemoteHeads, 'readable' | 'error'> {
  let defaultBranch: string | null = null;
  let hasRevision = false;
  let any = false;
  for (const line of out.split('\n')) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (sym) {
      defaultBranch = sym[1] ?? null;
      continue;
    }
    const ref = line.match(/^[0-9a-f]{40}\t(\S+)$/);
    if (!ref) continue;
    any = true;
    const name = ref[1] as string;
    if (name === `refs/heads/${revision}` || name === `refs/tags/${revision}`) hasRevision = true;
  }
  if (/^[0-9a-f]{7,40}$/.test(revision)) hasRevision = any; // a commit id cannot be listed; trust a non-empty remote
  return { empty: !any, defaultBranch, hasRevision };
}

export function readRemoteHeads(repoUrl: string, revision: string, env: NodeJS.ProcessEnv = process.env): RemoteHeads {
  const r = spawnSync('git', ['ls-remote', '--symref', repoUrl, 'HEAD', revision], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
  });
  if (r.error || r.status !== 0) {
    const msg = (r.stderr || r.error?.message || '').trim().split('\n').pop() ?? '';
    return { readable: false, empty: false, defaultBranch: null, hasRevision: false, error: msg.slice(0, 200) || 'git ls-remote failed' };
  }
  return { readable: true, error: null, ...parseLsRemote(r.stdout, revision) };
}

export type OwnerType = 'User' | 'Organization' | null;

/** The owner type through gh, when gh is installed and logged in; null otherwise. */
export function readOwnerType(repo: string, env: NodeJS.ProcessEnv = process.env): OwnerType {
  const r = spawnSync('gh', ['api', `repos/${repoSlug(repo)}`, '--jq', '.owner.type'], { encoding: 'utf8', timeout: 20_000, env });
  if (r.error || r.status !== 0) return null;
  const t = r.stdout.trim();
  return t === 'User' || t === 'Organization' ? t : null;
}

/** What the person's own GitHub login may do on a repository: `admin` covers maintainers, who change its settings. */
export type RepoRole = 'admin' | 'write' | 'read' | null;

/** The role through gh, when gh is installed and logged in; null otherwise. */
export function readRepoRole(repo: string, env: NodeJS.ProcessEnv = process.env): RepoRole {
  const jq = '.permissions | if (.admin or .maintain) then "admin" elif .push then "write" elif .pull then "read" else "" end';
  const r = spawnSync('gh', ['api', `repos/${repoSlug(repo)}`, '--jq', jq], { encoding: 'utf8', timeout: 20_000, env });
  if (r.error || r.status !== 0) return null;
  const t = r.stdout.trim();
  return t === 'admin' || t === 'write' || t === 'read' ? t : null;
}

/** The fix for a repository the Claude side cannot reach, in the words of the official setup paths. */
export function accessFix(repo: string, ownerType: OwnerType): string[] {
  const slug = repoSlug(repo);
  const owner = slug.split('/')[0] as string;
  const lines = [`Claude cannot reach ${slug} (the service answered repo_access_denied before creating any session). Fix one of these:`];
  lines.push(`  1. Give the Claude GitHub App access to ${slug}: https://github.com/apps/claude/installations/new`);
  if (ownerType === 'Organization') {
    lines.push(`     ${owner} is an organization: only an owner of ${owner} can install the app or add the repository (others can send a request from that page).`);
    lines.push(`     If the app is installed already, an owner adds the repository at https://github.com/organizations/${owner}/settings/installations`);
  } else if (ownerType === 'User') {
    lines.push(`     If the app is installed on ${owner} already, add the repository at https://github.com/settings/installations`);
  } else {
    lines.push(`     If the app is installed already, add the repository in its settings: https://github.com/settings/installations for a personal account, https://github.com/organizations/${owner}/settings/installations for an organization (only an organization owner can change it).`);
  }
  lines.push('  2. Or run /web-setup in Claude Code: it sends your gh token to your Claude account, which then reaches what gh reaches.');
  lines.push('Then run /kharos:doctor, or launch again: the check costs nothing, because the routine is created disabled.');
  return lines;
}

/** Translates a refusal of the service into the fix a person can act on. */
export function refusalFix(reason: string | null, message: string | null, repo: string, ownerType: OwnerType): string[] {
  const text = `${reason ?? ''} ${message ?? ''}`.toLowerCase();
  if (text.includes('repo_access_denied') || (text.includes('repo') && text.includes('access'))) return accessFix(repo, ownerType);
  if (text.includes('github') && (text.includes('connect') || text.includes('token') || text.includes('auth'))) {
    return [
      'Your Claude account has no GitHub connection the service can use.',
      'Connect GitHub on claude.ai/code, or run /web-setup in Claude Code, then run /kharos:doctor.',
    ];
  }
  if (text.includes('environment')) {
    return [
      'The cloud environment of this profile was not found by the service.',
      'Open /schedule in Claude Code or claude.ai/code to see your environments, then fix "environment" in the profile with /kharos:setup.',
    ];
  }
  if (text.includes('limit') || text.includes('429') || text.includes('rate')) {
    return ['The service refused the fire because of a rate or plan limit. Routines allow about 30 runs per hour each and 100 per account; wait and launch again.'];
  }
  return [`The service refused the request${reason ? ` (${reason})` : ''}${message ? `: ${message.slice(0, 200)}` : ''}.`];
}

/** The initial commit of an empty repository, through gh, only after the person said yes. */
export function initialCommit(repo: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; detail: string } {
  const slug = repoSlug(repo);
  const name = slug.split('/')[1] as string;
  const content = Buffer.from(`# ${name}\n`).toString('base64');
  const r = spawnSync(
    'gh',
    ['api', '-X', 'PUT', `repos/${slug}/contents/README.md`, '-f', 'message=Initial commit', '-f', `content=${content}`, '--jq', '.commit.sha'],
    { encoding: 'utf8', timeout: 30_000, env },
  );
  if (r.error) return { ok: false, detail: `${ghSpawnError(r.error, 30_000).error}: create the first commit on github.com instead` };
  if (r.status !== 0) return { ok: false, detail: (r.stderr || '').trim().slice(0, 300) || 'gh api failed' };
  return { ok: true, detail: `README.md committed (${r.stdout.trim().slice(0, 12)})` };
}

/** The ask rules of a repository's .claude/settings.json on one branch, as a launch preflight read them. */
export interface RepoRules {
  ask: string[];
  read_at: string;
}

/** How long a reading of a branch's ask rules is used for the launches that follow it. */
export const REPO_RULES_TTL_MS = 24 * 3600_000;

function rulesKey(repo: string, revision: string): string {
  return `${repoSlug(repo)}@${revision}`;
}

function loadRepoRules(paths: Paths): Record<string, RepoRules> {
  return readState<Record<string, RepoRules>>(paths.repoRules, (v) => isObject(v) && Object.values(v).every((x) => isObject(x) && Array.isArray(x.ask)), 'an object of ask rules by branch') ?? {};
}

/** Keeps what the launch preflight read, so a launch can tell a prompt of the repository's ask rules from the rest. */
export function recordRepoRules(paths: Paths, repo: string, revision: string, ask: readonly string[], now: number): void {
  withLock(paths.repoRules, () => {
    let book: Record<string, RepoRules>;
    try {
      book = loadRepoRules(paths);
    } catch {
      book = {};
    }
    book[rulesKey(repo, revision)] = { ask: [...ask], read_at: new Date(now).toISOString() };
    writeJsonAtomic(paths.repoRules, book);
  });
}

/** The ask rules a preflight read for this branch within REPO_RULES_TTL_MS, or null when none is known. */
export function recentRepoRules(paths: Paths, repo: string, revision: string, now: number): string[] | null {
  try {
    const r = loadRepoRules(paths)[rulesKey(repo, revision)];
    return r && now - Date.parse(r.read_at) < REPO_RULES_TTL_MS ? r.ask : null;
  } catch {
    return null;
  }
}

// The repository on GitHub, through the person's own gh: the files of a branch, for the permission
// preflight, and the per-launch side branch that automatic preflight writes the permission hook to.
// A side branch is one commit on top of the branch a profile launches from; kharos creates it through
// the Git data API, so no local checkout and no shared branch is ever touched, and deletes it only
// while its tip is still that commit.

import { spawnSync } from 'node:child_process';
import { repoSlug } from './config.ts';

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** gh is not installed: there is no such program to start. */
  missing?: boolean;
  /** gh did not run to its end (not installed, timed out, answered too much), as a person reads it. */
  error?: string;
}

/** Runs gh with arguments and an optional stdin; the seam the tests replace. */
export type Gh = (args: string[], input?: string) => GhResult;

/**
 * How much gh may print. The file list of a large repository is several megabytes, well past the
 * one-megabyte default of spawnSync, which then stops the child and reports ENOBUFS.
 */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;

/** Why gh did not run to its end, from the error spawnSync gives. */
export function ghSpawnError(err: Error, timeoutMs: number): { missing: boolean; error: string } {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return { missing: true, error: 'gh is not installed' };
  if (code === 'ETIMEDOUT') return { missing: false, error: `gh did not answer within ${Math.ceil(timeoutMs / 1000)} s` };
  if (code === 'ENOBUFS') return { missing: false, error: `gh answered more than ${GH_MAX_BUFFER / 1024 / 1024} MiB` };
  return { missing: false, error: `gh could not run (${code ?? err.message})` };
}

export function realGh(env: NodeJS.ProcessEnv, timeoutMs = 30_000): Gh {
  return (args, input) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: GH_MAX_BUFFER, env, ...(input !== undefined ? { input } : {}) });
    if (r.error) {
      const e = ghSpawnError(r.error, timeoutMs);
      return { status: null, stdout: '', stderr: '', error: e.error, ...(e.missing ? { missing: true } : {}) };
    }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** The files of a branch that the preflight read: the selected paths only, by their path. */
export interface RepoSnapshot {
  /** Where the files come from, as a person reads it. */
  label: string;
  /** Every file path of the branch, for the selection. */
  paths: string[];
  files: Map<string, string>;
  /** Selected files that exist but could not be read as text (binary or too large). */
  unreadable: Set<string>;
  /** The commit and its tree, for a side branch on top of it; null for a local checkout. */
  base: { commit: string; tree: string } | null;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface Forge {
  /** The files of `revision` that `select` picks from its file list. */
  snapshot(repo: string, revision: string, select: (paths: string[]) => string[]): Outcome<{ snapshot: RepoSnapshot }>;
  /** Creates branch `name` as one commit on top of `base` that writes `files`; refuses a branch that exists. */
  createBranch(repo: string, name: string, base: { commit: string; tree: string }, files: { path: string; content: string }[], message: string): Outcome<{ commit: string }>;
  /** The commit a branch points at, or null when there is no such branch. */
  branchTip(repo: string, name: string): Outcome<{ tip: string | null }>;
  deleteBranch(repo: string, name: string): Outcome<object>;
}

function lastLine(r: GhResult): string {
  if (r.error) return r.error;
  if (r.missing) return 'gh is not installed';
  return (`${r.stderr}`.trim().split('\n').pop() ?? '').slice(0, 200) || `gh exited with ${r.status}`;
}

function json(r: GhResult): unknown {
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    return null;
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const SHA_RE = /^[0-9a-f]{40}$/;
/** A side branch name kharos makes: kharos/ and a session id. */
const SIDE_BRANCH_RE = /^kharos\/k-\d{4,}$/;

export function isSideBranchName(name: string): boolean {
  return SIDE_BRANCH_RE.test(name);
}

const not404 = (r: GhResult) => !/\b404\b|not found/i.test(`${r.stderr}`);

export function ghForge(gh: Gh): Forge {
  return {
    snapshot(repo, revision, select) {
      const slug = repoSlug(repo);
      const [owner, name] = slug.split('/') as [string, string];
      // The commit through a query parameter, so a branch name with a slash needs no escaping in the path.
      const c = gh(['api', `repos/${slug}/commits?sha=${encodeURIComponent(revision)}&per_page=1`, '--jq', '.[0].sha + " " + .[0].commit.tree.sha']);
      if (c.status !== 0) return { ok: false, error: lastLine(c) };
      const [commit, tree] = c.stdout.trim().split(' ');
      if (!commit || !tree || !SHA_RE.test(commit) || !SHA_RE.test(tree)) return { ok: false, error: `no commit for ${revision}` };
      const t = gh(['api', `repos/${slug}/git/trees/${tree}?recursive=1`, '--jq', '.tree[] | select(.type == "blob") | .path']);
      if (t.status !== 0) return { ok: false, error: lastLine(t) };
      const paths = t.stdout.split('\n').filter((p) => p !== '');
      const picked = select(paths);
      const files = new Map<string, string>();
      const unreadable = new Set<string>();
      if (picked.length) {
        // One GraphQL call for every file; each path goes in as a variable, never into the query text.
        const vars = picked.map((_, i) => `$e${i}: String!`).join(', ');
        const fields = picked.map((_, i) => `f${i}: object(expression: $e${i}) { ... on Blob { text isBinary } }`).join(' ');
        const query = `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`;
        const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...picked.flatMap((p, i) => ['-f', `e${i}=${commit}:${p}`])];
        const g = gh(args);
        if (g.status !== 0) return { ok: false, error: lastLine(g) };
        const repoData = rec(rec(rec(json(g))?.data)?.repository);
        if (!repoData) return { ok: false, error: 'the GraphQL answer has no repository' };
        picked.forEach((p, i) => {
          const blob = rec(repoData[`f${i}`]);
          if (!blob) return;
          if (typeof blob.text === 'string' && blob.isBinary !== true) files.set(p, blob.text);
          else unreadable.add(p);
        });
      }
      return { ok: true, snapshot: { label: `${slug}@${revision}`, paths, files, unreadable, base: { commit, tree } } };
    },

    createBranch(repo, name, base, files, message) {
      if (!isSideBranchName(name)) return { ok: false, error: `${name} is not a kharos side branch name` };
      const slug = repoSlug(repo);
      const exists = gh(['api', `repos/${slug}/git/ref/heads/${name}`, '--jq', '.object.sha']);
      if (exists.status === 0) return { ok: false, error: `the branch ${name} exists already; kharos never overwrites a branch` };
      if (exists.missing || not404(exists)) return { ok: false, error: lastLine(exists) };
      const tree = gh(
        ['api', '-X', 'POST', `repos/${slug}/git/trees`, '--input', '-', '--jq', '.sha'],
        JSON.stringify({ base_tree: base.tree, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }),
      );
      if (tree.status !== 0) return { ok: false, error: lastLine(tree) };
      const commit = gh(
        ['api', '-X', 'POST', `repos/${slug}/git/commits`, '--input', '-', '--jq', '.sha'],
        JSON.stringify({ message, tree: tree.stdout.trim(), parents: [base.commit] }),
      );
      if (commit.status !== 0) return { ok: false, error: lastLine(commit) };
      const sha = commit.stdout.trim();
      if (!SHA_RE.test(sha)) return { ok: false, error: 'the commit answer has no sha' };
      const ref = gh(['api', '-X', 'POST', `repos/${slug}/git/refs`, '--input', '-', '--jq', '.object.sha'], JSON.stringify({ ref: `refs/heads/${name}`, sha }));
      if (ref.status !== 0) return { ok: false, error: lastLine(ref) };
      return { ok: true, commit: sha };
    },

    branchTip(repo, name) {
      const r = gh(['api', `repos/${repoSlug(repo)}/git/ref/heads/${name}`, '--jq', '.object.sha']);
      if (r.status === 0) return { ok: true, tip: r.stdout.trim() || null };
      if (!r.missing && !not404(r)) return { ok: true, tip: null };
      return { ok: false, error: lastLine(r) };
    },

    deleteBranch(repo, name) {
      if (!isSideBranchName(name)) return { ok: false, error: `${name} is not a kharos side branch name` };
      const r = gh(['api', '-X', 'DELETE', `repos/${repoSlug(repo)}/git/refs/heads/${name}`]);
      return r.status === 0 ? { ok: true } : { ok: false, error: lastLine(r) };
    },
  };
}

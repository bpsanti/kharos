// The permission reads that launches and /kharos:doctor share: files of the branch a session starts on,
// through the person's own gh, and the permission preflight /kharos:run shows before each launch.
// kharos never commits or pushes: what a launch changes goes to a side branch of its own.

import { spawnSync } from 'node:child_process';
import { CommandError } from './commands.ts';
import { ConfigError, loadConfig, pickProfile, repoSlug, type Config } from './config.ts';
import { GH_MAX_BUFFER, ghForge, ghSpawnError, realGh, type Forge, type RepoSnapshot } from './forge.ts';
import { readAccountPolicy } from './org-confirmations.ts';
import { HOOK_RULES_PATH, HOOK_SCRIPT_PATH, hasHookEntry, UNBLOCK_RISK, type HookFiles } from './permission-hook.ts';
import { sharedPaths, type Paths } from './paths.ts';
import { unmigratedNote } from './accounts.ts';
import { readAuthStatus } from './account.ts';
import { buildPreflight, formatPreflight, readHistory, selectFiles, snapshotAsk, type FormatOptions } from './preflight.ts';
import { recordRepoRules } from './repo.ts';
import { parseSettings, SETTINGS_PATH, SettingsError } from './settings.ts';

export type RemoteSettings = { status: 'found'; text: string } | { status: 'absent' } | { status: 'unreadable'; error: string };

/** A file of the repository on the branch sessions start on, through the person's own gh. */
export function readRemoteFile(repo: string, revision: string, file: string, env: NodeJS.ProcessEnv = process.env): RemoteSettings {
  const slug = repoSlug(repo);
  const gh = (args: string[]) => spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: GH_MAX_BUFFER, env });
  const r = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${slug}/contents/${file}?ref=${encodeURIComponent(revision)}`]);
  if (r.error) return { status: 'unreadable', error: ghSpawnError(r.error, 20_000).error };
  if (r.status === 0) return { status: 'found', text: r.stdout };
  const err = `${r.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  // GitHub answers 404 both for a missing file and for a repository gh cannot see: tell them apart.
  if (/\b404\b|not found/i.test(err) && gh(['api', `repos/${slug}`, '--jq', '.full_name']).status === 0) return { status: 'absent' };
  return { status: 'unreadable', error: err.slice(0, 200) || 'gh api failed' };
}

/** The repository's settings file on the branch sessions start on. */
export function readRemoteSettings(repo: string, revision: string, env: NodeJS.ProcessEnv = process.env): RemoteSettings {
  return readRemoteFile(repo, revision, SETTINGS_PATH, env);
}

export type RemoteHookFiles = { status: 'found'; files: HookFiles } | { status: 'unreadable'; error: string };

/** The three files of the kharos permission hook on a branch; the script and the rules are read only when the settings name the hook. */
export function readRemoteHookFiles(repo: string, revision: string, env: NodeJS.ProcessEnv = process.env, read = readRemoteFile): RemoteHookFiles {
  const text = (r: RemoteSettings): string | null | { error: string } => (r.status === 'found' ? r.text : r.status === 'absent' ? null : { error: r.error });
  const settings = text(read(repo, revision, SETTINGS_PATH, env));
  if (typeof settings === 'object' && settings !== null) return { status: 'unreadable', error: settings.error };
  let named = false;
  try {
    named = hasHookEntry(parseSettings(settings));
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
  }
  if (!named) return { status: 'found', files: { settings, script: null, rules: null } };
  const script = text(read(repo, revision, HOOK_SCRIPT_PATH, env));
  const rules = text(read(repo, revision, HOOK_RULES_PATH, env));
  for (const x of [script, rules]) if (typeof x === 'object' && x !== null) return { status: 'unreadable', error: x.error };
  return { status: 'found', files: { settings, script: script as string | null, rules: rules as string | null } };
}

export interface PreflightRequest {
  /** The launch profile (the default one when absent). */
  profile?: string;
  /** The branch or tag the launch starts on instead of the profile's (`--revision`). */
  revision?: string;
  /** The launch instruction, if known: a program it names comes first. */
  instruction: string;
  forge?: Forge;
  now?: number;
}

function loaded(paths: Paths): Config {
  try {
    return loadConfig(paths).config;
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
}

/** The permission prompts a launch's cloud session is likely to hit, each with the narrow rule that answers it. */
export function preflight(paths: Paths, req: PreflightRequest, env: NodeJS.ProcessEnv): string {
  const config = loaded(paths);
  const policy = readAccountPolicy(paths, env);
  let picked;
  try {
    picked = pickProfile(config, req.profile);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // An account whose profiles still sit in the shared files: say where, not "known: none".
    const note = loadConfig(paths).exists ? null : unmigratedNote(paths, sharedPaths(env), readAuthStatus(env)?.account ?? null);
    throw new CommandError(note ?? err.message);
  }
  const profile = req.revision === undefined ? picked.profile : { ...picked.profile, revision: req.revision };
  const slug = repoSlug(profile.repo);
  const notes: string[] = [];
  let snapshot: RepoSnapshot;
  const read = (req.forge ?? ghForge(realGh(env))).snapshot(profile.repo, profile.revision, selectFiles);
  if (read.ok) {
    snapshot = read.snapshot;
    // The launch that follows tells a prompt of these ask rules from the rest.
    const ask = snapshotAsk(snapshot);
    if (ask) recordRepoRules(paths, profile.repo, profile.revision, ask, req.now ?? Date.now());
  } else {
    snapshot = { label: `${slug}@${profile.revision}`, paths: [], files: new Map(), unreadable: new Set(), base: null };
    notes.push(`${slug}@${profile.revision} could not be read with gh (${read.error}): only the ask rules of the organization and earlier sessions are used`);
  }
  const auto = config.preflight_auto && config.permission_hook;
  const opts: FormatOptions = {
    auto,
    after: auto
      ? [
          `automatic preflight is on: at launch kharos writes them to a side branch kharos/<id> of ${slug}, made from ${profile.revision}, and the session starts there; ${profile.revision} is not changed, and /kharos:close deletes the side branch.`,
          ...(config.permission_unblock ? [`permission_unblock is on: that side branch also gets the unblock preset while your confirmation matches the organization's managed settings (${UNBLOCK_RISK}).`] : []),
        ]
      : [`/kharos:permissions (unblock all) answers every prompt at each launch, on a side branch of ${slug} made from ${profile.revision}, after one confirmation; ${profile.revision} is never changed.`],
  };
  const history = readHistory(paths, profile.repo);
  const report = buildPreflight({ snapshot, repo: profile.repo, policy, history: history.prompts, sessionsRead: history.sessions, instruction: req.instruction });
  report.notes.unshift(...notes);
  return formatPreflight(report, opts);
}

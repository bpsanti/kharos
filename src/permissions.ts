// /kharos:permissions: the permission rules a repository gives its cloud sessions, and the change to a
// permission profile, always shown as a diff first. Only `write` changes the file, only with the token of
// the diff the person saw, and only in the local checkout: kharos never commits or pushes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CommandError } from './commands.ts';
import { ConfigError, loadConfig, normalizeRepo, pickProfile, repoSlug, saveConfig, type Config } from './config.ts';
import { ghForge, realGh, type Forge, type RepoSnapshot } from './forge.ts';
import { writeTextAtomic } from './fsutil.ts';
import { hooksBlocked, mirrorRefusal, readManagedPolicy, staleMirror, type ManagedPolicy } from './managed-policy.ts';
import { confirmationState, describeConfirmation, loadConfirmation, policyFingerprint, saveConfirmation } from './org-confirmations.ts';
import {
  UNBLOCK_RISK,
  unblockOpens,
  describeHook,
  hasHookEntry,
  HOOK_RULES_PATH,
  HOOK_SCRIPT_PATH,
  HookError,
  hookState,
  planHook,
  renderPlan,
  type HookChange,
  type HookFiles,
  type HookPlan,
  type HookState,
} from './permission-hook.ts';
import type { Paths } from './paths.ts';
import { buildPreflight, formatPreflight, localSnapshot, readHistory, selectFiles, type FormatOptions } from './preflight.ts';
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
  let st: HookState | null = null;
  try {
    st = hookState(localHookFiles(co.root));
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    lines.push(`kharos permission hook: ${err.message}`);
  }
  lines.push(...describePolicy(readManagedPolicy(env), st?.rules && !('error' in st.rules) ? st.rules.mirror : []));
  if (st) lines.push(`${describeHook(st)[0]} (details: kharos permissions hook show)`);
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

/** A file of the repository on the branch sessions start on, through the person's own gh. */
export function readRemoteFile(repo: string, revision: string, file: string, env: NodeJS.ProcessEnv = process.env): RemoteSettings {
  const slug = repoSlug(repo);
  const gh = (args: string[]) => spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000, env });
  const r = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${slug}/contents/${file}?ref=${encodeURIComponent(revision)}`]);
  if (r.error) return { status: 'unreadable', error: 'gh is not installed' };
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

function localHookFiles(root: string): HookFiles {
  return {
    settings: readText(path.join(root, SETTINGS_PATH)),
    script: readText(path.join(root, HOOK_SCRIPT_PATH)),
    rules: readText(path.join(root, HOOK_RULES_PATH)),
  };
}

function hookEnabled(paths: Paths): boolean {
  try {
    return loadConfig(paths).config.permission_hook;
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
}

/** What the organization's managed settings mean for cloud sessions, from the local copy. */
export function describePolicy(policy: ManagedPolicy, mirrored: readonly string[] = []): string[] {
  if (policy.status === 'absent') return [`organization managed settings: no copy at ${policy.file} (none for this account, or not fetched on this machine yet); mirroring is unavailable`];
  if (policy.status === 'unreadable') return [`organization managed settings: ${policy.file} cannot be read (${policy.error}); mirroring is unavailable`];
  const out = [`organization managed settings (${policy.file}): ${policy.ask.length} ask rule(s), ${policy.deny.length} deny rule(s), bypass mode ${policy.bypassDisabled ? 'disabled' : 'not disabled'}`];
  const blocked = hooksBlocked(policy);
  if (blocked) out.push(`warn: ${blocked}`);
  const stale = staleMirror(policy, mirrored);
  if (stale) out.push(`warn: ${stale}`);
  if (policy.ask.length) {
    const open = policy.ask.filter((r) => !mirrored.includes(r));
    out.push(`  ask rules prompt in every cloud session, which has no bypass mode, and no repository allow rule outranks them: ${policy.ask.join(', ')}`);
    if (mirrored.length) out.push(`  mirrored by the kharos permission hook here: ${policy.ask.filter((r) => mirrored.includes(r)).join(', ') || 'none'}; still a prompt: ${open.join(', ') || 'none'}`);
    const refusal = mirrorRefusal(policy);
    out.push(refusal ? `  ${refusal}` : '  mirroring is available: `kharos permissions hook diff --mirror` lists what it would convert, for your confirmation');
  }
  return out;
}

export function showHook(paths: Paths, dir: string, env: NodeJS.ProcessEnv): string {
  const co = checkout(dir, env);
  const enabled = hookEnabled(paths);
  let st;
  try {
    st = hookState(localHookFiles(co.root));
  } catch (err) {
    if (err instanceof SettingsError) throw new CommandError(err.message);
    throw err;
  }
  const mirrored = st.rules && !('error' in st.rules) ? st.rules.mirror : [];
  const lines = [
    `permission_hook in ${paths.config}: ${enabled ? 'on' : 'off (the default)'}`,
    `checkout: ${co.root}`,
    ...describeHook(st),
    ...describePolicy(readManagedPolicy(env), mirrored),
  ];
  if (!enabled && st.installed) lines.push('warn: the hook is in this checkout while permission_hook is off; it still answers prompts in cloud sessions on any branch that has it. Remove it with `kharos permissions hook diff --uninstall`.');
  if (!enabled && !st.installed) lines.push('The hook is opt-in: `kharos permissions hook enable` turns it on, after which `kharos permissions hook diff` shows the change.');
  return lines.join('\n');
}

export function switchHook(paths: Paths, on: boolean): string {
  let loaded;
  try {
    loaded = loadConfig(paths);
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
  if (!loaded.exists) throw new CommandError('kharos has no configuration yet: run /kharos:setup first');
  const config: Config = { ...loaded.config, permission_hook: on };
  saveConfig(paths, config);
  return on
    ? `permission_hook is on in ${paths.config}. kharos may now install the permission hook in a repository (each change only after you approve its diff), and the watcher logs the hook's decisions (kharos permissions approvals). /kharos:doctor warns while it is on.`
    : `permission_hook is off in ${paths.config}. A repository that already has the hook keeps answering prompts in cloud sessions until you remove it: kharos permissions hook diff --uninstall.`;
}

export const EMPTY_CHANGE: HookChange = { allow: [], drop: [], mirror: false, unmirror: false, uninstall: false, broad: false, unblock: null };

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The flags that state a change, to repeat it word for word in the write command. */
export function changeFlags(c: HookChange): string[] {
  return [
    ...c.allow.flatMap((p) => ['--allow', shellQuote(p)]),
    ...c.drop.flatMap((p) => ['--drop', shellQuote(p)]),
    ...(c.mirror ? ['--mirror'] : []),
    ...(c.unmirror ? ['--unmirror'] : []),
    ...(c.broad ? ['--broad'] : []),
    ...(c.unblock === 'on' ? ['--unblock'] : c.unblock === 'off' ? ['--no-unblock'] : []),
    ...(c.uninstall ? ['--uninstall'] : []),
  ];
}

function planIn(paths: Paths, dir: string, change: HookChange, env: NodeJS.ProcessEnv): { co: Checkout; plan: HookPlan; policy: ManagedPolicy } {
  const co = checkout(dir, env);
  if (!change.uninstall && !hookEnabled(paths)) {
    throw new CommandError(`the permission hook is opt-in and off (permission_hook in ${paths.config}): turn it on with \`kharos permissions hook enable\` first`);
  }
  const policy = readManagedPolicy(env);
  try {
    return { co, plan: planHook(localHookFiles(co.root), change, policy), policy };
  } catch (err) {
    if (err instanceof HookError || err instanceof SettingsError) throw new CommandError(err.message);
    throw err;
  }
}

export function diffHook(paths: Paths, dir: string, change: HookChange, env: NodeJS.ProcessEnv): string {
  const { co, plan, policy } = planIn(paths, dir, change, env);
  if (!plan.token) return [...plan.lines, `nothing to change in ${co.root}`].join('\n');
  const unblock = plan.unblock ? confirmationState(loadConfirmation(paths, 'unblock'), policy) : null;
  const remembered = plan.mirror && !plan.unblock ? confirmationState(loadConfirmation(paths, 'mirror'), policy, plan.mirror.broad.length > 0) : null;
  const ask = plan.mirror !== null && !plan.unblock && remembered?.state !== 'valid';
  const note = unblock ? describeConfirmation(unblock, 'unblock') : remembered ? describeConfirmation(remembered) : null;
  const write = ['kharos permissions hook write', '--expect', plan.token, ...changeFlags(change), ...(ask ? ['--org-confirmed'] : []), shellQuote(co.root)].join(' ');
  const confirmFirst =
    unblock && unblock.state !== 'valid' && policy.status === 'found'
      ? `; first the person confirms what the unblock preset opens (listed above), once, with \`kharos permissions unblock confirm --fingerprint ${policyFingerprint(policy)}\``
      : '';
  return [
    ...plan.lines,
    ...(note ? [note] : []),
    renderPlan(plan),
    `change ${plan.token}: nothing is written until the person approves this diff${ask ? ", and confirms the warning about the organization's rules (kharos remembers that confirmation until those rules change)" : ''}${confirmFirst}; then run \`${write}\``,
  ].join('\n');
}

export function writeHook(paths: Paths, dir: string, change: HookChange, expect: string | undefined, orgConfirmed: boolean, env: NodeJS.ProcessEnv): string {
  if (!expect) throw new CommandError('--expect needs the change token that `kharos permissions hook diff` printed, so only an approved diff is written');
  const { co, plan, policy } = planIn(paths, dir, change, env);
  if (!plan.token) return `nothing to change in ${co.root}`;
  if (plan.token !== expect) throw new CommandError(`${co.root} is not what that diff was made from (a file changed, or the diff was for another change); nothing was written. Show the diff again.`);
  if (plan.unblock) {
    const confirmed = confirmationState(loadConfirmation(paths, 'unblock'), policy);
    if (confirmed.state !== 'valid') {
      const why = confirmed.state === 'changed' ? describeConfirmation(confirmed, 'unblock') : 'the person has not confirmed what it opens';
      throw new CommandError(`this change turns on the unblock preset, and ${why}: \`kharos permissions unblock show\` lists what it opens and the command that confirms it; nothing was written`);
    }
  } else if (plan.mirror && !orgConfirmed) {
    const remembered = confirmationState(loadConfirmation(paths, 'mirror'), policy, plan.mirror.broad.length > 0);
    if (remembered.state !== 'valid') {
      const why = remembered.state === 'changed' ? ` (${describeConfirmation(remembered)})` : '';
      throw new CommandError(`this change mirrors the organization's ask rules: it is written only with --org-confirmed, after the person confirmed the warning${why}; nothing was written`);
    }
  }
  if (plan.mirror && !plan.unblock && orgConfirmed && policy.status === 'found') saveConfirmation(paths, 'mirror', policy, Date.now(), change.broad);
  for (const c of plan.changes) {
    const file = path.join(co.root, c.path);
    if (c.after === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    writeTextAtomic(file, c.after, c.before === null ? 0o644 : fs.statSync(file).mode & 0o777);
  }
  const launches = launchProfiles(paths, co.origin);
  const where = launches.length ? ` (kharos launch profiles on this repository: ${launches.join(', ')})` : '';
  return [
    `wrote ${plan.changes.map((c) => `${c.path}${c.after === null ? ' (deleted)' : ''}`).join(', ')} in ${co.root}. Nothing was committed or pushed.`,
    `Cloud sessions use these files from the branch they start on${where}: review them, commit them and push them there yourself.`,
  ].join('\n');
}

export interface PreflightRequest {
  /** A local checkout to read; null reads the branch a launch profile starts on, through gh. */
  dir: string | null;
  /** With dir null: the launch profile (the default one when absent). */
  profile?: string;
  /** The launch instruction, if known: a program it names comes first. */
  instruction: string;
  forge?: Forge;
}

function loaded(paths: Paths): Config {
  try {
    return loadConfig(paths).config;
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
}

/** The permission prompts a cloud session is likely to hit, each with the narrow rule that answers it. */
export function preflight(paths: Paths, req: PreflightRequest, env: NodeJS.ProcessEnv): string {
  const config = loaded(paths);
  const policy = readManagedPolicy(env);
  let snapshot: RepoSnapshot;
  let repo: string | null;
  let opts: FormatOptions;
  const notes: string[] = [];
  if (req.dir !== null) {
    const co = checkout(req.dir, env);
    snapshot = localSnapshot(co.root, env);
    repo = co.origin ? normalizeRepo(co.origin) : null;
    const launches = launchProfiles(paths, co.origin);
    opts = {
      addCommand: `kharos permissions hook diff {flags} ${shellQuote(co.root)}`,
      after: [
        'the diff shows the change; `kharos permissions hook write` writes it once you approve, and nothing is committed or pushed.',
        `Commit it and push it to the branch your launches start from${launches.length ? ` (${launches.join(', ')})` : ''}.`,
      ],
      hookOn: config.permission_hook,
      auto: config.preflight_auto,
    };
  } else {
    let picked;
    try {
      picked = pickProfile(config, req.profile);
    } catch (err) {
      if (err instanceof ConfigError) throw new CommandError(err.message);
      throw err;
    }
    const { profile } = picked;
    const slug = repoSlug(profile.repo);
    repo = profile.repo;
    const read = (req.forge ?? ghForge(realGh(env))).snapshot(profile.repo, profile.revision, selectFiles);
    if (read.ok) snapshot = read.snapshot;
    else {
      snapshot = { label: `${slug}@${profile.revision}`, paths: [], files: new Map(), unreadable: new Set(), base: null };
      notes.push(`${slug}@${profile.revision} could not be read with gh (${read.error}): only the ask rules of the organization and earlier sessions are used`);
    }
    const auto = config.preflight_auto && config.permission_hook;
    opts = auto
      ? {
          addCommand: null,
          after: [
            `automatic preflight is on: at launch kharos writes them to a side branch kharos/<id> of ${slug}, made from ${profile.revision}, and the session starts there; ${profile.revision} is not changed, and /kharos:close deletes the side branch.`,
            ...(config.permission_unblock ? [`permission_unblock is on: that side branch also gets the unblock preset while your confirmation matches the organization's managed settings (${UNBLOCK_RISK}).`] : []),
          ],
          hookOn: true,
          auto: true,
        }
      : {
          addCommand: `kharos permissions hook diff {flags} <checkout of ${slug}>`,
          after: [
            `In a checkout of ${slug} on ${profile.revision}: approve the diff, write it with \`kharos permissions hook write\`, then commit and push it to ${profile.revision}.`,
            `Or let kharos apply them at each launch on a side branch of its own, never on ${profile.revision}: kharos permissions auto preflight on`,
          ],
          hookOn: config.permission_hook,
          auto: config.preflight_auto,
        };
  }
  const history = repo ? readHistory(paths, repo) : { prompts: [], sessions: 0 };
  const report = buildPreflight({ snapshot, repo, policy, history: history.prompts, sessionsRead: history.sessions, instruction: req.instruction });
  report.notes.unshift(...notes);
  return formatPreflight(report, opts);
}

/** Turns automatic permission preflight on or off; on needs the permission hook on. */
export function switchPreflightAuto(paths: Paths, on: boolean): string {
  let current;
  try {
    current = loadConfig(paths);
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
  if (!current.exists) throw new CommandError('kharos has no configuration yet: run /kharos:setup first');
  if (on && !current.config.permission_hook) {
    throw new CommandError('automatic preflight installs the kharos permission hook, which is opt-in and off: turn it on with `kharos permissions hook enable` first');
  }
  saveConfig(paths, { ...current.config, preflight_auto: on });
  return on
    ? `preflight_auto is on in ${paths.config}. At each launch, kharos writes the narrow allow patterns the preflight suggests (never a broad one, never a mirrored organization rule) to a side branch kharos/<id>, made from the branch the profile launches from, and the session starts there. That branch is never changed; /kharos:close deletes the side branch, and kharos show <id> lists what was applied.`
    : `preflight_auto is off in ${paths.config}: /kharos:run lists the likely prompts and the rule for each, and applies nothing.`;
}

/** What the unblock preset opens under the organization's managed settings, and whether the person confirmed it. */
export function unblockShow(paths: Paths, env: NodeJS.ProcessEnv): string {
  const policy = readManagedPolicy(env);
  const config = loaded(paths);
  const refusal = mirrorRefusal(policy);
  const lines = ['the unblock preset of the kharos permission hook: no cloud session waits on a person at a permission prompt.'];
  if (refusal || policy.status !== 'found') {
    lines.push(`it is not available: ${refusal ?? "the organization's managed settings cannot be read"}.`);
    return lines.join('\n');
  }
  const blocked = hooksBlocked(policy);
  if (blocked) lines.push(`warn: ${blocked}; the preset would not take effect`);
  lines.push('it opens:', ...unblockOpens(policy).map((l) => `  ${l}`));
  const st = confirmationState(loadConfirmation(paths, 'unblock'), policy);
  const fp = policyFingerprint(policy);
  if (st.state === 'valid') lines.push(`confirmed on ${st.at.slice(0, 10)} for these managed settings (fingerprint ${fp}): kharos does not ask again until they change.`);
  else {
    if (st.state === 'changed') lines.push(`${describeConfirmation(st, 'unblock')}.`);
    lines.push(`not confirmed for these managed settings. Only after the person confirms all of the above, once: kharos permissions unblock confirm --fingerprint ${fp}`);
  }
  lines.push(
    'then, in a checkout: `kharos permissions unblock <folder>` shows the change to the hook as a diff, written after you approve it (commit and push it yourself);',
    `or at every launch, on a side branch of its own: kharos permissions auto unblock on (now ${config.permission_unblock ? 'on' : 'off'}).`,
  );
  return lines.join('\n');
}

/** The person's one confirmation of the unblock preset, for the managed settings whose fingerprint they saw. */
export function unblockConfirm(paths: Paths, fingerprint: string | undefined, env: NodeJS.ProcessEnv): string {
  if (!fingerprint) throw new CommandError('--fingerprint needs the fingerprint that `kharos permissions unblock show` printed, so only what the person read is confirmed');
  const policy = readManagedPolicy(env);
  const refusal = mirrorRefusal(policy);
  if (refusal || policy.status !== 'found') throw new CommandError(`the unblock preset is not available: ${refusal ?? 'no managed settings'}`);
  if (policyFingerprint(policy) !== fingerprint) {
    throw new CommandError("the organization's managed settings are not the ones that fingerprint was made from; nothing was confirmed. Run `kharos permissions unblock show` again.");
  }
  const c = saveConfirmation(paths, 'unblock', policy, Date.now());
  return `confirmed the unblock preset for the organization's managed settings with fingerprint ${c.fingerprint} (${c.confirmed_at}). kharos asks again when they change.`;
}

/** Automatic preflight with the unblock preset: each launch's side branch gets it. */
export function switchUnblockAuto(paths: Paths, on: boolean, env: NodeJS.ProcessEnv): string {
  let current;
  try {
    current = loadConfig(paths);
  } catch (err) {
    if (err instanceof ConfigError) throw new CommandError(err.message);
    throw err;
  }
  if (!current.exists) throw new CommandError('kharos has no configuration yet: run /kharos:setup first');
  if (!on) {
    saveConfig(paths, { ...current.config, permission_unblock: false });
    return `permission_unblock is off in ${paths.config}: automatic preflight, while on, writes only narrow rules again.`;
  }
  if (!current.config.permission_hook) {
    throw new CommandError('the unblock preset is part of the kharos permission hook, which is opt-in and off: turn it on with `kharos permissions hook enable` first');
  }
  const policy = readManagedPolicy(env);
  const refusal = mirrorRefusal(policy);
  if (refusal) throw new CommandError(`the unblock preset: ${refusal}`);
  if (confirmationState(loadConfirmation(paths, 'unblock'), policy).state !== 'valid') {
    throw new CommandError("the unblock preset is not confirmed for the organization's managed settings as they are: `kharos permissions unblock show` lists what it opens and the command that confirms it");
  }
  saveConfig(paths, { ...current.config, preflight_auto: true, permission_unblock: true });
  return `permission_unblock and preflight_auto are on in ${paths.config}: at each launch kharos writes the unblock preset to a side branch kharos/<id> and the session starts there, while your confirmation matches the organization's managed settings; ${UNBLOCK_RISK}. /kharos:doctor warns while it is on.`;
}

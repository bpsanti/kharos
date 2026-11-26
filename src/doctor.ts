// /kharos:doctor: every condition a cloud launch depends on, each with its fix, through official paths only.

import { spawnSync } from 'node:child_process';
import { claudeBin, readAuthStatus, type AuthStatus } from './account.ts';
import { scriptDigest, SETUP_SCRIPT_PATH } from './environment.ts';
import { ConfigError, loadConfig, repoSlug, type Config, type Profile } from './config.ts';
import { StateError } from './fsutil.ts';
import type { Paths } from './paths.ts';
import { assess, identify, parseSettings, readRules, SETTINGS_PATH, SettingsError } from './permission-profiles.ts';
import { hooksBlocked, readManagedPolicy, staleMirror, type ManagedPolicy } from './managed-policy.ts';
import { BROAD_RISK, UNBLOCK_RISK, broadRules, hasHookEntry, hookState, HOOK_RULES_PATH } from './permission-hook.ts';
import { readRemoteFile, readRemoteHookFiles, readRemoteSettings, type RemoteHookFiles, type RemoteSettings } from './permissions.ts';
import { activeCount, loadRegistry } from './registry.ts';
import { accessFix, loadRepos, readOwnerType, readRemoteHeads, type OwnerType, type RemoteHeads, type RepoBook } from './repo.ts';
import { environmentsOf, findSetup, loadEnvironments, loadSetups, loadWatch, type EnvironmentBook, type EnvironmentSetup } from './state.ts';

export type Level = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  level: Level;
  name: string;
  detail: string;
  fix?: string[];
}

export const MIN_CLAUDE = [2, 1, 323] as const;
const PLANS = new Set(['pro', 'max', 'team', 'enterprise', 'ultra']);

export interface DoctorDeps {
  claudeVersion: () => string | null;
  auth: () => AuthStatus | null;
  heads: (url: string, revision: string) => RemoteHeads;
  ownerType: (repo: string) => OwnerType;
  /** The repository's .claude/settings.json on the branch a session starts on. */
  settings: (repo: string, revision: string) => RemoteSettings;
  /** The kharos permission hook's files on that branch. */
  hookFiles: (repo: string, revision: string) => RemoteHookFiles;
  /** The local copy of the organization's managed settings. */
  managedPolicy: () => ManagedPolicy;
  /** The setup script the repository ships for its cloud environment. */
  setupScript: (repo: string, revision: string) => RemoteSettings;
}

export function realDeps(env: NodeJS.ProcessEnv): DoctorDeps {
  return {
    claudeVersion: () => {
      const r = spawnSync(claudeBin(env), ['--version'], { encoding: 'utf8', timeout: 15_000, env });
      return r.error || r.status !== 0 ? null : r.stdout.trim();
    },
    auth: () => readAuthStatus(env),
    heads: (u, rev) => readRemoteHeads(u, rev, env),
    ownerType: (repo) => readOwnerType(repo, env),
    settings: (repo, rev) => readRemoteSettings(repo, rev, env),
    hookFiles: (repo, rev) => readRemoteHookFiles(repo, rev, env),
    managedPolicy: () => readManagedPolicy(env),
    setupScript: (repo, rev) => readRemoteFile(repo, rev, SETUP_SCRIPT_PATH, env),
  };
}

export function versionAtLeast(text: string, min: readonly number[]): boolean | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if ((v[i] as number) !== (min[i] as number)) return (v[i] as number) > (min[i] as number);
  }
  return true;
}

export interface DoctorOptions {
  profile?: string;
  /** The session that ran the check has no RemoteTrigger tool. */
  noRemoteTool?: boolean;
  now: number;
  env: NodeJS.ProcessEnv;
}

export function runDoctor(paths: Paths, opts: DoctorOptions, deps: DoctorDeps): Check[] {
  const checks: Check[] = [];
  const add = (level: Level, name: string, detail: string, fix?: string[]) => checks.push(fix ? { level, name, detail, fix } : { level, name, detail });

  const version = deps.claudeVersion();
  const okVersion = version ? versionAtLeast(version, MIN_CLAUDE) : null;
  if (!version) add('fail', 'claude', 'the claude binary was not found', ['Install Claude Code, or set KHAROS_CLAUDE_BIN to its path.']);
  else if (okVersion === false) add('fail', 'claude', `${version}; kharos needs ${MIN_CLAUDE.join('.')} or newer`, ['Run `claude update`.']);
  else add('ok', 'claude', version);

  if (opts.env.ANTHROPIC_API_KEY) {
    add('fail', 'login', 'ANTHROPIC_API_KEY is set, and it takes precedence over the claude.ai login', ['Unset ANTHROPIC_API_KEY where Claude Code starts, then start it again.']);
  }
  const auth = deps.auth();
  if (!auth || !auth.loggedIn) add('fail', 'login', 'not logged in', ['Run `claude auth login` with a claude.ai account.']);
  else if (auth.authMethod !== 'claude.ai') {
    add('fail', 'login', `logged in with ${auth.authMethod ?? 'an unknown method'}; cloud sessions need a claude.ai login (API keys, Bedrock and Vertex do not work)`, ['Run `claude auth login` with a claude.ai account.']);
  } else {
    add('ok', 'login', 'claude.ai');
    const plan = auth.subscriptionType ?? 'unknown';
    if (PLANS.has(plan)) {
      const managed = plan === 'team' || plan === 'enterprise';
      add('ok', 'plan', managed ? `${plan}: an owner can turn off cloud sessions or scheduled tasks; then the RemoteTrigger tool does not appear` : plan);
    } else add('warn', 'plan', `subscription "${plan}"; cloud sessions need Pro, Max, Team or Enterprise`);
  }
  if (opts.noRemoteTool) {
    add('fail', 'remote tool', 'this Claude Code session has no RemoteTrigger tool', [
      'Update Claude Code, and log in with claude.ai.',
      'On Team or Enterprise, ask an owner to allow cloud sessions and scheduled tasks for the organization.',
    ]);
  }

  let config: Config | null = null;
  try {
    const loaded = loadConfig(paths);
    if (!loaded.exists) add('fail', 'config', `no configuration at ${paths.config}`, ['Run /kharos:setup.']);
    else config = loaded.config;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    add('fail', 'config', err.message, ['Fix or move that file, then run /kharos:setup.']);
  }
  if (!config) return checks;
  const state = <T>(name: string, file: string, read: () => T): T | null => {
    try {
      return read();
    } catch (err) {
      const [where, why] = err instanceof StateError ? [err.file, err.reason] : [file, err instanceof Error ? err.message : String(err)];
      add('fail', name, `state could not be read (${where}): ${why}`, ['Repair or move that file.']);
      return null;
    }
  };
  const repos = state('repos', paths.repos, () => loadRepos(paths));
  const envs = state('environments', paths.environments, () => loadEnvironments(paths));
  const setups = state('setups', paths.setups, () => loadSetups(paths));
  const names = opts.profile ? [opts.profile] : Object.keys(config.profiles);
  if (names.length === 0) add('fail', 'profile', 'the configuration has no profile', ['Run /kharos:setup.']);
  add('ok', 'config', `${paths.config} (${Object.keys(config.profiles).length} profile(s), default ${config.default_profile ?? 'none'})`);
  const policy = deps.managedPolicy();
  if (policy.status === 'found') {
    add('info', 'managed policy', `${policy.file}: ${policy.ask.length} ask rule(s), ${policy.deny.length} deny rule(s); bypass mode ${policy.bypassDisabled ? 'disabled by the organization' : 'not disabled'}`);
  } else if (policy.status === 'absent') {
    add('info', 'managed policy', `no copy of organization managed settings at ${policy.file} (none for this account, or not fetched on this machine yet)`);
  } else add('info', 'managed policy', `${policy.file} cannot be read (${policy.error}); its ask rules, if any, are not checked`);
  const blocked = hooksBlocked(policy);
  if (blocked) add('warn', 'managed hooks only', blocked, ['Cloud sessions wait at every prompt the organization or the repository asks about; ask the organization\'s administrator to narrow the rules instead.']);
  if (config.permission_hook) {
    add('warn', 'permission hook', `permission_hook is on: a repository that has the kharos permission hook answers permission prompts in its cloud sessions with no person asked; see what it allowed with \`kharos permissions approvals\``, [
      'Turn it off with `kharos permissions hook disable`, and remove the hook from a repository with `kharos permissions hook diff --uninstall`.',
    ]);
  }
  if (!config.preflight_auto) {
    add('info', 'permission preflight', 'automatic preflight is off (the default): `kharos permissions preflight` and /kharos:run list the prompts a launch is likely to hit, with a narrow rule for each, and apply nothing');
  } else if (!config.permission_hook) {
    add('warn', 'permission preflight', 'preflight_auto is on, but permission_hook is off, so automatic preflight applies nothing', ['Turn the hook on with `kharos permissions hook enable`, or automatic preflight off with `kharos permissions auto preflight off`.']);
  } else {
    add('info', 'permission preflight', "automatic preflight is on: each launch writes the allow patterns and prefix rules the preflight suggests to a side branch kharos/<id> and starts there (the organization's ask rules are also mirrored while a remembered mirror confirmation matches its managed settings); the branch a profile launches from is never changed, and /kharos:close deletes the side branch", [
      'Turn it off with `kharos permissions auto preflight off`.',
    ]);
  }
  if (config.permission_unblock) {
    add('warn', 'unblock preset', `permission_unblock is on${config.preflight_auto && config.permission_hook ? '' : ' (inactive until preflight_auto and permission_hook are both on)'}: the side branch of each launch gets the unblock preset, so every permission prompt in its cloud session is allowed, of any tool, with no person asked, while your confirmation matches the organization's managed settings`, [
      'Turn it off with `kharos permissions auto unblock off`; `kharos permissions approvals` lists what it allowed.',
    ]);
  }
  const account = auth?.account ?? null;
  for (const name of names) {
    const p = config.profiles[name];
    if (!p) {
      add('fail', `profile ${name}`, 'does not exist');
      continue;
    }
    checkProfile(name, p, deps, add, repos ?? {}, config.permission_hook, policy);
    checkEnvironment(name, p, deps, add, environmentsOf(envs, account), findSetup(setups ?? {}, account, repoSlug(p.repo), p.revision));
  }

  const reg = state('registry', paths.registry, () => loadRegistry(paths));
  if (reg) {
    const hourAgo = opts.now - 3600_000;
    const fires = Object.values(reg.sessions).filter((s) => s.fired_at && Date.parse(s.fired_at) > hourAgo).length;
    add('info', 'limits', `${activeCount(reg)} open of watch.max_open ${config.watch.max_open}; ${fires} fire(s) in the last hour (the service allows about 100 per account per hour, 30 per routine)`);
  }
  const w = state('watcher', paths.watch, () => loadWatch(paths));
  if (w) add('info', 'watcher', w.last_beat ? `last heartbeat ${w.last_beat}` : 'never ran (the advanced mode; /kharos:run starts a follower for each launch)');
  return checks;
}

function checkProfile(
  name: string,
  p: Profile,
  deps: DoctorDeps,
  add: (l: Level, n: string, d: string, f?: string[]) => void,
  repos: RepoBook,
  hookOn: boolean,
  policy: ManagedPolicy,
): void {
  const slug = repoSlug(p.repo);
  const label = `${name}: repo`;
  const heads = deps.heads(p.repo, p.revision);
  if (!heads.readable) {
    add('warn', label, `${slug} could not be read with this machine's git (${heads.error ?? 'unknown error'})`, [
      'The cloud does not use this machine\'s credentials, so this alone does not stop a launch; it only means kharos could not check the branch and the first commit.',
    ]);
  } else if (heads.empty) {
    add('fail', label, `${slug} has no commit; a cloud session cannot start from an empty repository`, [
      `/kharos:setup can add an initial README commit after you agree, or push one yourself.`,
    ]);
  } else if (!heads.hasRevision) {
    add('fail', `${name}: revision`, `"${p.revision}" is not a branch or tag of ${slug}${heads.defaultBranch ? ` (default branch: ${heads.defaultBranch})` : ''}`, [
      `Set "revision" of profile ${name} to an existing branch.`,
    ]);
  } else add('ok', label, `${slug}@${p.revision}`);
  if (!heads.readable || (!heads.empty && heads.hasRevision)) checkPermissions(name, p, deps, add, hookOn, policy);

  const access = repos[slug];
  if (access?.access === 'ok') add('ok', `${name}: claude access`, `a routine for ${slug} was created on ${access.checked_at.slice(0, 10)}`);
  else if (access?.access === 'denied') add('fail', `${name}: claude access`, `the service answered ${access.reason ?? 'access denied'} on ${access.checked_at.slice(0, 10)}`, accessFix(p.repo, deps.ownerType(p.repo)));
  else {
    add('info', `${name}: claude access`, 'not checked yet: the first launch checks it when it creates the routine, which is free and disabled, before any session starts', [
      'The Claude side needs the Claude GitHub App on the repository (https://github.com/apps/claude), or GitHub connected through /web-setup.',
    ]);
  }

}

/**
 * Whether the profile's environment fits its repository. No official surface lists environments or shows
 * what one holds, so the evidence is what the person confirmed and what the account's routines used.
 */
function checkEnvironment(
  name: string,
  p: Profile,
  deps: DoctorDeps,
  add: (l: Level, n: string, d: string, f?: string[]) => void,
  envs: EnvironmentBook | null,
  confirmed: EnvironmentSetup | null,
): void {
  const label = `${name}: environment`;
  const slug = repoSlug(p.repo);
  const key = slug.toLowerCase();
  const seen = envs?.environments.find((e) => e.id === p.environment);
  const used = seen ? `used by ${seen.routines} routine(s)` : '';
  const known = confirmed && confirmed.environment !== p.environment ? confirmed.environment : envs?.environments.find((e) => e.id !== p.environment && e.repos?.includes(key))?.id;
  const assisted = [
    ...(known ? [`${known} is known for ${slug}: /kharos:setup can point the profile at it.`] : []),
    `/kharos:setup walks you through creating one for ${slug}: it prepares the setup script, the variable names and the network level, then writes the new id into the profile.`,
  ];
  const shipped = () => {
    const found = deps.setupScript(p.repo, p.revision);
    return found.status === 'found' ? found.text : null;
  };
  if (confirmed?.environment === p.environment) {
    const script = shipped();
    if (script !== null && scriptDigest(script) !== confirmed.script_sha256) {
      add('warn', label, `the setup script changed on ${p.revision}; paste it again`, [
        `Copy the new script with \`kharos env-guide --profile ${name} --copy\` and paste it into the "Setup script" of ${p.environment} on claude.ai/code.`,
        'Then confirm it with /kharos:setup.',
      ]);
    } else add('ok', label, `${p.environment} (you confirmed it for ${slug}@${p.revision} on ${confirmed.confirmed_at.slice(0, 10)}${used ? `; ${used}` : ''})`);
  } else if (seen) {
    // A repository that ships a setup script needs an environment that runs it, which routines on others do not show.
    if (seen.repos && !seen.repos.includes(key) && shipped() !== null) {
      add('warn', label, `${p.environment} is ${used}, none on ${slug}, which ships ${SETUP_SCRIPT_PATH}`, [
        'If this environment runs that script already, say so in /kharos:setup.',
        ...assisted,
      ]);
    } else add('ok', label, `${p.environment} (${used})`);
  } else if (envs) {
    add('warn', label, `${p.environment} is not used by any of your routines, and you have not confirmed it for ${slug}`, [
      'Check its id in /schedule or on claude.ai/code; a missing environment fails the fire without starting a session.',
      ...assisted,
    ]);
  } else add('info', label, `${p.environment} (not compared with your routines yet: /kharos:doctor reads them)`);
}

/** Which permission profile the branch a session starts on is on, and what in it would hold a session at a prompt. */
function checkPermissions(
  name: string,
  p: Profile,
  deps: DoctorDeps,
  add: (l: Level, n: string, d: string, f?: string[]) => void,
  hookOn: boolean,
  policy: ManagedPolicy,
): void {
  const label = `${name}: permissions`;
  const where = `${repoSlug(p.repo)}@${p.revision}`;
  const fix = [`/kharos:permissions standard in a checkout of ${repoSlug(p.repo)} shows the change as a diff and writes it after you approve; then commit and push it to ${p.revision}.`];
  const remote = deps.settings(p.repo, p.revision);
  if (remote.status === 'unreadable') {
    add('info', label, `${SETTINGS_PATH} of ${where} could not be read with gh (${remote.error}); a cloud session uses the file on that branch`, [`Run /kharos:permissions in a checkout of ${repoSlug(p.repo)} to see its rules.`]);
    checkManagedAsk(name, policy, [], hookOn, add);
    return;
  }
  let settings;
  let rules;
  try {
    settings = parseSettings(remote.status === 'found' ? remote.text : null);
    rules = readRules(settings);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    add('warn', label, `${SETTINGS_PATH} of ${where}: ${err.message}`, ['Fix the file on that branch.']);
    checkManagedAsk(name, policy, [], hookOn, add);
    return;
  }
  const findings = assess(rules);
  const counts = `${rules.allow.length} allow, ${rules.ask.length} ask, ${rules.deny.length} deny`;
  const detail = [`${where} is on the ${identify(rules)} permission profile (${remote.status === 'absent' ? 'no settings file' : counts})`, ...findings.map((f) => f.text)].join('; ');
  add(findings.some((f) => f.level === 'warn') ? 'warn' : 'ok', label, detail, fix);
  const mirrored = checkHook(name, p, settings, deps, add, hookOn, policy);
  checkManagedAsk(name, policy, mirrored, hookOn, add);
}

/** Whether the branch has the kharos permission hook, and what it answers; returns the organization rules it mirrors. */
function checkHook(
  name: string,
  p: Profile,
  settings: Record<string, unknown>,
  deps: DoctorDeps,
  add: (l: Level, n: string, d: string, f?: string[]) => void,
  hookOn: boolean,
  policy: ManagedPolicy,
): string[] {
  const label = `${name}: permission hook`;
  const where = `${repoSlug(p.repo)}@${p.revision}`;
  let named = false;
  try {
    named = hasHookEntry(settings);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    add('warn', label, `${SETTINGS_PATH} of ${where}: ${err.message}`);
    return [];
  }
  if (!named) {
    if (hookOn) add('info', label, `${where} has no kharos permission hook, so its cloud sessions still wait at every prompt`, [`/kharos:permissions hook in a checkout of ${repoSlug(p.repo)} shows the change; then commit and push it to ${p.revision}.`]);
    return [];
  }
  const found = deps.hookFiles(p.repo, p.revision);
  if (found.status === 'unreadable') {
    add('info', label, `${where} names the kharos permission hook, but its files could not be read with gh (${found.error})`);
    return [];
  }
  const st = hookState(found.files);
  const problems: string[] = [];
  if (st.script === 'missing') problems.push('the script is missing, so prompts still wait');
  else if (st.script === 'outdated') problems.push('the script is not the one this kharos ships');
  if (st.rules === null) problems.push(`there is no ${HOOK_RULES_PATH}, so the hook denies every prompt`);
  else if ('error' in st.rules) problems.push(`${HOOK_RULES_PATH}: ${st.rules.error}, so the hook denies every prompt`);
  if (!hookOn) problems.push('permission_hook is off, yet the hook answers prompts in cloud sessions on this branch');
  const rules = st.rules && !('error' in st.rules) ? st.rules : null;
  const stale = rules ? staleMirror(policy, rules.mirror) : null;
  if (stale) problems.push(stale);
  if (rules?.unblock) problems.push(`the unblock preset is on: ${UNBLOCK_RISK}`);
  const broad = rules ? broadRules(rules) : [];
  const what = rules
    ? `${rules.allow.length} allow pattern(s), ${rules.prefix?.length ? `${rules.prefix.length} prefix rule(s), ` : ''}${rules.mirror.length} mirrored organization ask rule(s), any other prompt denied with the allowed forms${broad.length ? `; ${broad.length} broad rule(s), which ${BROAD_RISK}: ${broad.join(', ')}` : ''}`
    : 'no usable rules';
  add(problems.length ? 'warn' : 'info', label, [`${where} has the kharos permission hook: ${what}`, ...problems].join('; '), [
    `/kharos:permissions hook in a checkout of ${repoSlug(p.repo)} shows the hook and changes it (or removes it with --uninstall); then commit and push to ${p.revision}.`,
  ]);
  return rules?.mirror ?? [];
}

/** The organization's ask rules that still stop this profile's cloud sessions at a prompt nobody answers. */
function checkManagedAsk(name: string, policy: ManagedPolicy, mirrored: readonly string[], hookOn: boolean, add: (l: Level, n: string, d: string, f?: string[]) => void): void {
  if (policy.status !== 'found') return;
  const open = hooksBlocked(policy) ? policy.ask : policy.ask.filter((r) => !mirrored.includes(r));
  if (open.length === 0) return;
  const fix = ["Ask the organization's administrator to narrow them; a repository allow rule cannot outrank them."];
  fix.push(
    hookOn
      ? '/kharos:permissions hook can answer them with your own narrow allow patterns, or mirror them when the organization has not disabled bypass mode.'
      : 'Or opt in to the kharos permission hook (`kharos permissions hook enable`), which answers them in cloud sessions with your own narrow allow patterns.',
  );
  add('warn', `${name}: managed ask rules`, `${open.length} organization ask rule(s) prompt in every cloud session, which has no bypass mode, and the session waits until a person answers: ${open.join(', ')}`, fix);
}

export function formatChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.level.padEnd(4)}  ${c.name}: ${c.detail}`);
    if (c.fix && c.level !== 'ok') for (const f of c.fix) lines.push(`      ${f}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(fails ? `${fails} problem(s) to fix before launching.` : warns ? `Ready to launch, with ${warns} warning(s).` : 'Ready to launch.');
  return lines.join('\n');
}

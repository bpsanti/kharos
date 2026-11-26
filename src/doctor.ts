// /kharos:doctor: every condition a cloud launch depends on, each with its fix, through official paths only.

import { spawnSync } from 'node:child_process';
import { claudeBin, readAuthStatus, type AuthStatus } from './account.ts';
import { scriptDigest, SETUP_SCRIPT_PATH } from './environment.ts';
import { ConfigError, loadConfig, otherAccount, repoSlug, type Config, type Profile } from './config.ts';
import { StateError } from './fsutil.ts';
import type { Paths } from './paths.ts';
import { assess, identify, parseSettings, readRules, SETTINGS_PATH, SettingsError } from './permission-profiles.ts';
import { hooksBlocked, readManagedPolicy, staleMirror, type ManagedPolicy } from './managed-policy.ts';
import { BROAD_RISK, UNBLOCK_RISK, broadRules, hasHookEntry, hookState, HOOK_RULES_PATH } from './permission-hook.ts';
import { readRemoteFile, readRemoteHookFiles, readRemoteSettings, type RemoteHookFiles, type RemoteSettings } from './permissions.ts';
import { activeCount, loadRegistry } from './registry.ts';
import { followerProblems, queueLines } from './commands.ts';
import { LEASE_STALE_MS } from './lease.ts';
import { describePlan, loadMarker, planMigration } from './accounts.ts';
import { ACCOUNT_AUTO_CAVEAT, autoModeRefusal, readAccountMode } from './account-mode.ts';
import { describeUnblockAll, readUnblockAll, UNBLOCK_ALL_SKILL, UNBLOCK_ALL_UNDO } from './unblock-all.ts';
import { accessFix, loadRepos, readOwnerType, readRemoteHeads, readRepoRole, type OwnerType, type RemoteHeads, type RepoBook, type RepoRole } from './repo.ts';
import { environmentsOf, findSetup, loadEnvironments, loadSetups, loadWatch, type EnvironmentBook, type EnvironmentSetup } from './state.ts';

/** `info` lines show only with --verbose, so a warning is always something the person can act on. */
export type Level = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  level: Level;
  name: string;
  detail: string;
  fix?: string[];
}

/** Which account a cloud session's work shows under on GitHub; kharos cannot read the environment's variables, so it says this instead of checking. */
export const COMMIT_IDENTITY =
  'cloud sessions push with the GitHub credential your Claude account has (the Claude GitHub App or /web-setup), and author commits as Claude <noreply@anthropic.com> unless the cloud environment sets GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL';

/**
 * Why every launch asks for its own approval. Claude Code's RemoteTrigger tool asks before it creates, changes or
 * runs a routine, ignores an allow rule for the whole tool on those calls, and offers no "always allow"; in auto
 * mode its classifier reviews the call instead of a person.
 */
export const LAUNCH_APPROVAL =
  "each launch asks for your approval before its routine is created and run: Claude Code asks on every create and run of a routine, ignores allow rules for the whole RemoteTrigger tool on them, and offers no \"always allow\", so kharos cannot make that approval durable; a headless launch (claude -p) runs only with --permission-mode auto, where Claude Code's classifier reviews each launch instead of you";

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
  /** What the person's own GitHub login may do on the repository; null when gh cannot tell. */
  repoRole: (repo: string) => RepoRole;
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
    repoRole: (repo) => readRepoRole(repo, env),
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
  /** The folders every account shared, when this account has files of its own (see paths.ts). */
  shared?: Paths | null;
  /** The session that ran the check has no RemoteTrigger tool. */
  noRemoteTool?: boolean;
  now: number;
  env: NodeJS.ProcessEnv;
}

type Add = (level: Level, name: string, detail: string, fix?: string[]) => void;

function collector(): { checks: Check[]; add: Add } {
  const checks: Check[] = [];
  return { checks, add: (level, name, detail, fix) => checks.push(fix ? { level, name, detail, fix } : { level, name, detail }) };
}

/** Claude Code, the login, the plan and the RemoteTrigger tool: what every cloud launch needs first. */
export function accountChecks(opts: Pick<DoctorOptions, 'noRemoteTool' | 'env'>, deps: Pick<DoctorDeps, 'claudeVersion' | 'auth'>, auth: AuthStatus | null = deps.auth()): Check[] {
  const { checks, add } = collector();
  const version = deps.claudeVersion();
  const okVersion = version ? versionAtLeast(version, MIN_CLAUDE) : null;
  if (!version) add('fail', 'claude', 'the claude binary was not found', ['Install Claude Code, or set KHAROS_CLAUDE_BIN to its path.']);
  else if (okVersion === false) add('fail', 'claude', `${version}; kharos needs ${MIN_CLAUDE.join('.')} or newer`, ['Run `claude update`.']);
  else add('ok', 'claude', version);

  if (opts.env.ANTHROPIC_API_KEY) {
    add('fail', 'login', 'ANTHROPIC_API_KEY is set, and it takes precedence over the claude.ai login', ['Unset ANTHROPIC_API_KEY where Claude Code starts, then start it again.']);
  }
  if (!auth || !auth.loggedIn) add('fail', 'login', 'not logged in', ['Run `claude auth login` with a claude.ai account.']);
  else if (auth.authMethod !== 'claude.ai') {
    add('fail', 'login', `logged in with ${auth.authMethod ?? 'an unknown method'}; cloud sessions need a claude.ai login (API keys, Bedrock and Vertex do not work)`, ['Run `claude auth login` with a claude.ai account.']);
  } else {
    add('ok', 'login', auth.email ? `claude.ai, ${auth.email}` : 'claude.ai');
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
  return checks;
}

export function runDoctor(paths: Paths, opts: DoctorOptions, deps: DoctorDeps): Check[] {
  const { checks, add } = collector();
  const auth = deps.auth();
  checks.push(...accountChecks(opts, deps, auth));

  let config: Config | null = null;
  try {
    const loaded = loadConfig(paths);
    if (!loaded.exists) {
      add('fail', 'config', `no configuration at ${paths.config}${paths.account ? `, the files of Claude config folder ${paths.account}` : ''}`, ['Run /kharos:setup.']);
      pendingMigration(paths, opts.shared ?? null, auth?.account ?? null, add);
    }
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
  add('ok', 'config', `${paths.config} (${Object.keys(config.profiles).length} profile(s), default ${config.default_profile ?? 'none'})${paths.account ? `, the files of Claude config folder ${paths.account}` : ''}`);
  pendingMigration(paths, opts.shared ?? null, auth?.account ?? null, add);
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
  checkUnblockAll(paths, opts.env, policy, config, add);
  const account = auth?.account ?? null;
  for (const name of names) {
    const p = config.profiles[name];
    if (!p) {
      add('fail', `profile ${name}`, 'does not exist');
      continue;
    }
    if (otherAccount(p, auth?.account)) {
      // One file serves every account on the machine, and an environment belongs to one account.
      const detail = 'was set up on another Claude account, whose cloud environment this account cannot use';
      if (opts.profile) add('fail', `profile ${name}`, detail, [`Run /kharos:setup ${repoSlug(p.repo)} on this account; it sets up a profile of its own.`]);
      else add('info', `profile ${name}`, `${detail}; not checked here`);
      continue;
    }
    checkProfile(name, p, deps, add, repos ?? {}, config.permission_hook, policy);
    checkEnvironment(name, p, deps, add, environmentsOf(envs, account), findSetup(setups ?? {}, account, repoSlug(p.repo), p.revision));
  }
  checkAccountMode(opts.env, policy, add);
  add('info', 'commits', COMMIT_IDENTITY, ['Set them on the environment at claude.ai/code: open the environment selector, the settings of the environment, and add one NAME=value line each under Environment variables.']);

  const reg = state('registry', paths.registry, () => loadRegistry(paths));
  if (reg) {
    const hourAgo = opts.now - 3600_000;
    const fires = Object.values(reg.sessions).filter((s) => s.fired_at && Date.parse(s.fired_at) > hourAgo).length;
    add('info', 'limits', `${activeCount(reg, opts.now)} open of watch.max_open ${config.watch.max_open}; ${fires} fire(s) in the last hour (the service allows about 100 per account per hour, 30 per routine)`);
  }
  if (reg) {
    const problems = followerProblems(paths, opts.now);
    for (const line of queueLines(paths, opts.now)) add(/not fired/.test(line) ? 'warn' : 'info', 'queue', line.replace(/^queue: /, ''));
    for (const p of problems) add('warn', `follower ${p.id}`, `${p.detail} (a follower beats every few seconds; past ${Math.round(LEASE_STALE_MS / 60_000)} min it counts as stale)`, [p.fix]);
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
  if (access?.access === 'ok') {
    const how = access.reason === CHECKED_BY_CLAUDE_CODE ? 'Claude Code confirmed it' : `a routine for ${slug} was created`;
    add('ok', `${name}: claude access`, `${how} on ${access.checked_at.slice(0, 10)}`);
  } else if (access?.access === 'denied') add('fail', `${name}: claude access`, `the service answered ${access.reason ?? 'access denied'} on ${access.checked_at.slice(0, 10)}`, accessFix(p.repo, deps.ownerType(p.repo)));
  else {
    add('info', `${name}: claude access`, `${ACCESS_UNCHECKED}: the first launch checks it when it creates the routine, which is free and disabled, before any session starts`, [
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
  const env = p.environment_name ? `"${p.environment_name}" (${p.environment})` : p.environment;
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
        `Copy the new script with \`kharos env-guide --profile ${name} --copy\` and paste it into the "Setup script" of ${env} on claude.ai/code.`,
        'Then confirm it with /kharos:setup.',
      ]);
    } else add('ok', label, `${env} (you confirmed it for ${slug}@${p.revision} on ${confirmed.confirmed_at.slice(0, 10)}${used ? `; ${used}` : ''})`);
  } else if (seen || p.environment_name) {
    // A repository that ships a setup script needs an environment that runs it, which neither routines on others nor a name show.
    const elsewhere = seen ? !!seen.repos && !seen.repos.includes(key) : true;
    if (elsewhere && shipped() !== null) {
      add('warn', label, seen ? `${env} is ${used}, none on ${slug}, which ships ${SETUP_SCRIPT_PATH}` : `${env} was picked by name, and ${slug} ships ${SETUP_SCRIPT_PATH}, which kharos does not know it runs`, [
        'If this environment runs that script already, say so in /kharos:setup.',
        ...assisted,
      ]);
    } else add('ok', label, seen ? `${env} (${used})` : `${env}, picked by name from your environments in /kharos:setup`);
  } else if (envs && shipped() !== null) {
    add('warn', label, `${env} is not confirmed for ${slug}, which ships ${SETUP_SCRIPT_PATH}, and kharos does not know whether the environment runs it`, [
      'If this environment runs that script already, say so in /kharos:setup.',
      ...assisted,
    ]);
  } else if (envs && envs.environments.length > 0) {
    // Only routines show environment ids here, so this says something only when the account has routines.
    add('warn', label, `${p.environment} is not used by any of your routines, was not picked by name, and you have not confirmed it for ${slug}`, [
      'Run /kharos:setup to pick the environment by name from the ones your account has; a missing environment fails the fire without starting a session.',
      ...assisted,
    ]);
  } else add('info', label, `${p.environment} (not compared: no routine of yours uses an environment yet, which is expected on a new account)`);
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
  const quiet = permissionsQuiet(p, deps.repoRole(p.repo));
  if (!findings.some((f) => f.level === 'warn')) add('ok', label, detail, fix);
  else if (quiet) add('info', label, `${detail} (${quiet})`, fix);
  else add('warn', label, detail, fix);
  const mirrored = checkHook(name, p, settings, deps, add, hookOn, policy);
  checkManagedAsk(name, policy, mirrored, hookOn, add);
}

/**
 * One line for everything `kharos permissions unblock-all` frees: all on, partly on with what is missing, or off.
 * On, even in part, it warns, since prompts are then answered with no person asked.
 */
function checkUnblockAll(paths: Paths, env: NodeJS.ProcessEnv, policy: ManagedPolicy, config: Config, add: Add): void {
  const { parts } = readUnblockAll(paths, env, policy, config);
  const { overall, text } = describeUnblockAll(parts);
  if (overall === 'on') {
    add('warn', 'unblock all', `${text}: every permission prompt in the cloud sessions kharos launches is allowed, of any tool, with no person asked, and every session of this account starts in auto mode`, [
      `Take back what it turned on with \`${UNBLOCK_ALL_UNDO}\`; \`kharos permissions approvals\` lists what the preset allowed.`,
    ]);
  } else if (overall === 'partly') {
    const undo = `\`${UNBLOCK_ALL_UNDO}\` shows how to take back what \`kharos permissions unblock-all on\` turned on`;
    add('warn', 'unblock all', text, [
      parts.every((p) => p.on || p.unavailable) ? `Every part available here is on; ${undo}.` : `\`${UNBLOCK_ALL_SKILL}\` turns on the rest after you confirm once, or ${undo}.`,
    ]);
  } else {
    add('ok', 'unblock all', `${text}; \`${UNBLOCK_ALL_SKILL}\` frees every prompt kharos can free for this account, in one step, after you confirm once`);
  }
}

/** Whether this account starts its sessions in auto mode, where the classifier reviews each launch instead of an approval prompt. */
function checkAccountMode(env: NodeJS.ProcessEnv, policy: ManagedPolicy, add: Add): void {
  const cur = readAccountMode(env);
  if ('error' in cur) {
    add('info', 'launch approval', `${cur.file} cannot be read (${cur.error}); ${LAUNCH_APPROVAL}`);
    return;
  }
  const refusal = autoModeRefusal(policy);
  if (cur.mode === 'auto' && refusal) {
    add('warn', 'launch approval', `${cur.file} starts this account's sessions in auto mode, but ${refusal}, so each launch asks for approval and a headless one is denied`, [
      `Ask the organization's administrator about auto mode, or take it out of your settings with \`kharos permissions account-mode diff off\`.`,
    ]);
  } else if (cur.mode === 'auto') {
    add('ok', 'launch approval', `this account starts its sessions in auto mode (${cur.file}): Claude Code's classifier reviews each launch, interactive or headless, with no approval prompt, ${ACCOUNT_AUTO_CAVEAT}`);
  } else {
    add('ok', 'launch approval', `this account's sessions start in ${cur.mode ?? 'the default'} mode, so each launch asks for your approval, and a headless one needs \`claude -p --permission-mode auto\`${refusal ? '' : `; \`${UNBLOCK_ALL_SKILL}\` starts it in auto mode, with the rest of what it frees`}`);
  }
}

/** Says when profiles or sessions of this account still sit in the files every account shared; /kharos:setup moves them. */
function pendingMigration(paths: Paths, shared: Paths | null, account: string | null, add: Add): void {
  if (!shared || !account || loadMarker(paths)) return;
  const plan = planMigration(shared, account);
  if (!plan) return;
  add('warn', 'account files', `the kharos files every account shared hold ${describePlan(plan)}`, ["Run /kharos:setup once on this account: it moves them to this account's own files, and asks about the ones it cannot tell."]);
}

/**
 * Why a permissions warning is not the person's to act on, or null when it is: they chose to leave the
 * rules as they are in /kharos:setup, or their GitHub login cannot change the repository's settings.
 * A login gh cannot read stays a warning, since the person may well be able to change the file.
 */
export function permissionsQuiet(p: Profile, role: RepoRole): string | null {
  if (p.permissions === 'as-is') return 'you chose to leave them as they are in /kharos:setup';
  if (role === 'write' || role === 'read') return `a change to ${SETTINGS_PATH} of ${repoSlug(p.repo)}, which its maintainers decide`;
  return null;
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

/** The words of a claude access check whose answer is not known yet. */
export const ACCESS_UNCHECKED = 'not checked yet';
/** The reason recorded when Claude Code itself, through /schedule, confirmed Claude's access to a repository. */
export const CHECKED_BY_CLAUDE_CODE = 'checked by Claude Code';

export function formatChecks(checks: Check[], opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const shown = opts.verbose ? checks : checks.filter((c) => c.level !== 'info');
  for (const c of shown) {
    lines.push(`${c.level.padEnd(4)}  ${c.name}: ${c.detail}`);
    if (c.fix && c.level !== 'ok') for (const f of c.fix) lines.push(`      ${f}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  if (fails) {
    lines.push(`${fails} problem(s) to fix before launching.`);
    return lines.join('\n');
  }
  const unchecked = checks.filter((c) => c.name.endsWith(': claude access') && c.detail.startsWith(ACCESS_UNCHECKED)).map((c) => c.name.replace(/: claude access$/, ''));
  const ready = warns ? `Ready to launch, with ${warns} warning(s)` : 'Ready to launch';
  lines.push(
    unchecked.length
      ? `${ready}; Claude's GitHub access is not confirmed yet for ${unchecked.join(', ')}: the first launch checks it before any session starts, at no cost.`
      : `${ready}.`,
  );
  const hidden = checks.length - shown.length;
  if (hidden) lines.push(`${hidden} more line(s) of information with --verbose.`);
  return lines.join('\n');
}

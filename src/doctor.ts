// /nuvem:doctor: every condition a cloud launch depends on, each with its fix, through official paths only.

import { spawnSync } from 'node:child_process';
import { claudeBin, readAuthStatus, type AuthStatus } from './account.ts';
import { ConfigError, loadConfig, repoSlug, type Config, type Profile } from './config.ts';
import type { Paths } from './paths.ts';
import { activeCount, loadRegistry } from './registry.ts';
import { accessFix, loadRepos, readOwnerType, readRemoteHeads, type OwnerType, type RemoteHeads } from './repo.ts';
import { loadEnvironments, loadWatch } from './state.ts';

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
  if (!version) add('fail', 'claude', 'the claude binary was not found', ['Install Claude Code, or set NUVEM_CLAUDE_BIN to its path.']);
  else if (okVersion === false) add('fail', 'claude', `${version}; nuvem needs ${MIN_CLAUDE.join('.')} or newer`, ['Run `claude update`.']);
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
    if (!loaded.exists) add('fail', 'config', `no configuration at ${paths.config}`, ['Run /nuvem:setup.']);
    else config = loaded.config;
  } catch (err) {
    if (!(err instanceof ConfigError) && !(err instanceof SyntaxError)) throw err;
    add('fail', 'config', `${paths.config}: ${err.message}`, ['Fix the file, or run /nuvem:setup to write a new profile.']);
  }
  if (!config) return checks;
  const names = opts.profile ? [opts.profile] : Object.keys(config.profiles);
  if (names.length === 0) add('fail', 'profile', 'the configuration has no profile', ['Run /nuvem:setup.']);
  add('ok', 'config', `${paths.config} (${Object.keys(config.profiles).length} profile(s), default ${config.default_profile ?? 'none'})`);
  for (const name of names) {
    const p = config.profiles[name];
    if (!p) {
      add('fail', `profile ${name}`, 'does not exist');
      continue;
    }
    checkProfile(paths, name, p, deps, add);
  }

  const reg = loadRegistry(paths);
  const hourAgo = opts.now - 3600_000;
  const fires = Object.values(reg.sessions).filter((s) => s.fired_at && Date.parse(s.fired_at) > hourAgo).length;
  add('info', 'limits', `${activeCount(reg)} open of watch.max_open ${config.watch.max_open}; ${fires} fire(s) in the last hour (the service allows about 100 per account per hour, 30 per routine)`);
  const w = loadWatch(paths);
  add('info', 'watcher', w.last_beat ? `last heartbeat ${w.last_beat}` : 'never ran: start it with /loop 10m /nuvem:watch in a separate session');
  return checks;
}

function checkProfile(paths: Paths, name: string, p: Profile, deps: DoctorDeps, add: (l: Level, n: string, d: string, f?: string[]) => void): void {
  const slug = repoSlug(p.repo);
  const label = `${name}: repo`;
  const heads = deps.heads(p.repo, p.revision);
  if (!heads.readable) {
    add('warn', label, `${slug} could not be read with this machine's git (${heads.error ?? 'unknown error'})`, [
      'The cloud does not use this machine\'s credentials, so this alone does not stop a launch; it only means nuvem could not check the branch and the first commit.',
    ]);
  } else if (heads.empty) {
    add('fail', label, `${slug} has no commit; a cloud session cannot start from an empty repository`, [
      `/nuvem:setup can add an initial README commit after you agree, or push one yourself.`,
    ]);
  } else if (!heads.hasRevision) {
    add('fail', `${name}: revision`, `"${p.revision}" is not a branch or tag of ${slug}${heads.defaultBranch ? ` (default branch: ${heads.defaultBranch})` : ''}`, [
      `Set "revision" of profile ${name} to an existing branch.`,
    ]);
  } else add('ok', label, `${slug}@${p.revision}`);

  const access = loadRepos(paths)[slug];
  if (access?.access === 'ok') add('ok', `${name}: claude access`, `a routine for ${slug} was created on ${access.checked_at.slice(0, 10)}`);
  else if (access?.access === 'denied') add('fail', `${name}: claude access`, `the service answered ${access.reason ?? 'access denied'} on ${access.checked_at.slice(0, 10)}`, accessFix(p.repo, deps.ownerType(p.repo)));
  else {
    add('info', `${name}: claude access`, 'not checked yet: the first launch checks it when it creates the routine, which is free and disabled, before any session starts', [
      'The Claude side needs the Claude GitHub App on the repository (https://github.com/apps/claude), or GitHub connected through /web-setup.',
    ]);
  }

  const envs = loadEnvironments(paths);
  const seen = envs?.environments.find((e) => e.id === p.environment);
  if (seen) add('ok', `${name}: environment`, `${p.environment} (used by ${seen.routines} routine(s))`);
  else if (envs) {
    add('warn', `${name}: environment`, `${p.environment} is not used by any of your routines`, [
      'Check its id in /schedule or on claude.ai/code; a missing environment fails the fire without starting a session.',
      'If the project needs tools installed, give the environment a setup script there; it runs in the cloud, not on this machine.',
    ]);
  } else add('info', `${name}: environment`, `${p.environment} (not compared with your routines yet: /nuvem:doctor reads them)`);
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

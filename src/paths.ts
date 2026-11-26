// Where kharos keeps its configuration and state.
// Profiles, environments and sessions belong to one Claude account, so each account gets its own files.
// Claude Code tells accounts apart by CLAUDE_CONFIG_DIR: the default one (~/.claude) keeps the folders
// kharos always used, and any other gets accounts/<key> under them. KHAROS_HOME puts everything under
// one folder of the person's choice, with no scoping.

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface Paths {
  home: string;
  /** The account these files belong to: the key of a non-default CLAUDE_CONFIG_DIR, or null for the default folders. */
  account: string | null;
  config: string;
  state: string;
  registry: string;
  watch: string;
  intents: string;
  outbox: string;
  repos: string;
  environments: string;
  /** The environments a person confirmed, by account and repository. */
  setups: string;
  bodies: string;
  logs: string;
  /** The kharos permission hook's decisions, as the watcher read them from session logs. */
  approvals: string;
  /** What automatic permission preflight applied at each launch. */
  preflight: string;
  /** The person's remembered confirmations about the organization's rules (mirror, unblock), each with the policy fingerprint it holds for. */
  confirmations: string;
  /** One lease file per session a follower (`kharos wait`) reads, so only one process reads it at a time. */
  followers: string;
  /** Records that this account's files were taken out of the shared ones, once. */
  migration: string;
}

function expand(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** The key of the Claude account in use: null for the default CLAUDE_CONFIG_DIR, a readable and unique folder name otherwise. */
export function accountKey(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME || os.homedir();
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return null;
  const abs = path.resolve(expand(dir, home));
  if (abs === path.join(home, '.claude')) return null;
  const name = path.basename(abs).replace(/^\.+/, '').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'claude';
  return `${name}-${createHash('sha256').update(abs).digest('hex').slice(0, 8)}`;
}

function layout(home: string, account: string | null, configDir: string, state: string): Paths {
  return {
    home,
    account,
    config: path.join(configDir, 'config.json'),
    state,
    registry: path.join(state, 'sessions.json'),
    watch: path.join(state, 'watch.json'),
    intents: path.join(state, 'intents.json'),
    outbox: path.join(state, 'outbox.json'),
    repos: path.join(state, 'repos.json'),
    environments: path.join(state, 'environments.json'),
    setups: path.join(state, 'setups.json'),
    bodies: path.join(state, 'bodies'),
    logs: path.join(state, 'logs'),
    approvals: path.join(state, 'approvals.jsonl'),
    preflight: path.join(state, 'preflight.jsonl'),
    confirmations: path.join(state, 'org-confirmations.json'),
    followers: path.join(state, 'followers'),
    migration: path.join(state, 'migration.json'),
  };
}

function bases(env: NodeJS.ProcessEnv, home: string): { configDir: string; state: string } {
  return {
    configDir: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kharos'),
    state: path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'kharos'),
  };
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || os.homedir();
  if (env.KHAROS_HOME) return layout(home, null, env.KHAROS_HOME, path.join(env.KHAROS_HOME, 'state'));
  const b = bases(env, home);
  const account = accountKey(env);
  if (!account) return layout(home, null, b.configDir, b.state);
  return layout(home, account, path.join(b.configDir, 'accounts', account), path.join(b.state, 'accounts', account));
}

/**
 * The folders every account shared before kharos scoped them, for an account that has files of its own now;
 * null when the paths in use are those folders already, or KHAROS_HOME was chosen.
 */
export function sharedPaths(env: NodeJS.ProcessEnv = process.env): Paths | null {
  const home = env.HOME || os.homedir();
  if (env.KHAROS_HOME || !accountKey(env)) return null;
  const b = bases(env, home);
  return layout(home, null, b.configDir, b.state);
}

// Where kharos keeps its configuration and state.
// KHAROS_HOME puts both under one folder, which is how one machine serves several accounts.

import os from 'node:os';
import path from 'node:path';

export interface Paths {
  home: string;
  config: string;
  state: string;
  registry: string;
  watch: string;
  intents: string;
  outbox: string;
  repos: string;
  environments: string;
  bodies: string;
  logs: string;
  /** The kharos permission hook's decisions, as the watcher read them from session logs. */
  approvals: string;
  /** One lease file per session a follower (`kharos wait`) reads, so only one process reads it at a time. */
  followers: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || os.homedir();
  let configDir: string;
  let state: string;
  if (env.KHAROS_HOME) {
    configDir = env.KHAROS_HOME;
    state = path.join(env.KHAROS_HOME, 'state');
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kharos');
    state = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'kharos');
  }
  return {
    home,
    config: path.join(configDir, 'config.json'),
    state,
    registry: path.join(state, 'sessions.json'),
    watch: path.join(state, 'watch.json'),
    intents: path.join(state, 'intents.json'),
    outbox: path.join(state, 'outbox.json'),
    repos: path.join(state, 'repos.json'),
    environments: path.join(state, 'environments.json'),
    bodies: path.join(state, 'bodies'),
    logs: path.join(state, 'logs'),
    approvals: path.join(state, 'approvals.jsonl'),
    followers: path.join(state, 'followers'),
  };
}

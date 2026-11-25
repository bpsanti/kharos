// Where nuvem keeps its configuration and state.
// NUVEM_HOME puts both under one folder, which is how one machine serves several accounts.

import os from 'node:os';
import path from 'node:path';

export interface Paths {
  home: string;
  config: string;
  state: string;
  registry: string;
  watch: string;
  intents: string;
  repos: string;
  environments: string;
  outbox: string;
  bodies: string;
  logs: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || os.homedir();
  let configDir: string;
  let state: string;
  if (env.NUVEM_HOME) {
    configDir = env.NUVEM_HOME;
    state = path.join(env.NUVEM_HOME, 'state');
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'nuvem');
    state = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'nuvem');
  }
  return {
    home,
    config: path.join(configDir, 'config.json'),
    state,
    registry: path.join(state, 'sessions.json'),
    watch: path.join(state, 'watch.json'),
    intents: path.join(state, 'intents.json'),
    repos: path.join(state, 'repos.json'),
    environments: path.join(state, 'environments.json'),
    outbox: path.join(state, 'outbox.json'),
    bodies: path.join(state, 'bodies'),
    logs: path.join(state, 'logs'),
  };
}

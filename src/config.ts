// The configuration file: launch profiles, watcher thresholds and outputs.
// The JSON Schema in schema/config.schema.json describes the same shape for editors; this module is the
// validator that runs, with no dependency.

import fs from 'node:fs';
import { writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export interface Profile {
  /** One repository per profile: with more than one, the cloud session loads the hooks of none. */
  repo: string;
  revision: string;
  environment: string;
  model: string;
  /** Sent as the routine's allowed_tools. It neither allows nor restricts: prompts come from the repository's .claude/settings.json. */
  allowed_tools: string[];
  /** false sends clear_mcp_connections, so the server does not attach every connector of the account. */
  connectors: boolean;
  deadline_min: number;
}

export interface WatchConfig {
  model: string;
  interval_min: number;
  provision_min: number;
  silence_min: number;
  silence_severe_min: number;
  quiet_end_min: number;
  loop_failures: number;
  renotify_min: number;
  max_open: number;
}

export type EventFilter = string[];

export type OutputConfig =
  | { type: 'notification'; events: EventFilter }
  | { type: 'file'; path: string; events: EventFilter }
  | { type: 'slack'; webhook_env: string; events: EventFilter }
  | { type: 'command'; argv: string[]; timeout_s?: number; events: EventFilter }
  | { type: 'firstmate'; status_file: string; home: string; mode: 'shared' | 'dedicated'; events?: EventFilter };

export interface Config {
  version: 1;
  default_profile: string | null;
  profiles: Record<string, Profile>;
  watch: WatchConfig;
  outputs: OutputConfig[];
  /**
   * Opt-in, off by default: kharos may install a PermissionRequest hook in a repository, which answers
   * permission prompts in cloud sessions, and attributes the hook's decisions in the logs it reads.
   */
  permission_hook: boolean;
  /**
   * Opt-in, off by default, and only while permission_hook is on: at each launch kharos writes the narrow
   * allow patterns the permission preflight suggests to a side branch of its own, kharos/<id>, and the
   * session starts there; the branch it launches from is never changed. Off, the preflight only suggests.
   */
  preflight_auto: boolean;
  /**
   * Opt-in, off by default, and only with preflight_auto and a remembered confirmation that matches the
   * organization's managed settings: the side branch of each launch gets the unblock preset, which
   * allows every permission prompt in the cloud session.
   */
  permission_unblock: boolean;
}

export const DEFAULT_WATCH: WatchConfig = {
  model: 'haiku',
  interval_min: 10,
  provision_min: 15,
  silence_min: 15,
  silence_severe_min: 45,
  quiet_end_min: 40,
  loop_failures: 4,
  renotify_min: 60,
  max_open: 5,
};

export const DEFAULT_PROFILE_FIELDS = {
  revision: 'main',
  model: 'claude-sonnet-5-5',
  allowed_tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
  connectors: false,
  deadline_min: 180,
} as const;

export function defaultConfig(): Config {
  return {
    version: 1,
    default_profile: null,
    profiles: {},
    watch: { ...DEFAULT_WATCH },
    outputs: [
      { type: 'notification', events: ['needs_you', 'terminal'] },
      { type: 'file', path: '{state}/events.jsonl', events: ['*'] },
    ],
    permission_hook: false,
    preflight_auto: false,
    permission_unblock: false,
  };
}

export class ConfigError extends Error {}

const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const ENV_RE = /^env_\w+$/;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

export function normalizeRepo(repo: string): string {
  let r = repo.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const ssh = r.match(/^git@github\.com:([\w.-]+\/[\w.-]+)$/);
  if (ssh) r = `https://github.com/${ssh[1]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`;
  return r;
}

export function repoSlug(repo: string): string {
  return normalizeRepo(repo).replace(/^https:\/\/github\.com\//, '');
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v === '') throw new ConfigError(`${where} must be a non-empty string`);
  return v;
}

function posInt(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new ConfigError(`${where} must be a positive integer`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
    throw new ConfigError(`${where} must be a list of non-empty strings`);
  }
  return v as string[];
}

const KNOWN_PROFILE_KEYS = new Set(['repo', 'revision', 'environment', 'model', 'allowed_tools', 'connectors', 'deadline_min']);

export function parseProfile(v: unknown, where: string): Profile {
  const o = obj(v, where);
  for (const k of Object.keys(o)) if (!KNOWN_PROFILE_KEYS.has(k)) throw new ConfigError(`${where}.${k} is not a known field`);
  const repo = normalizeRepo(str(o.repo, `${where}.repo`));
  if (!REPO_RE.test(repo)) throw new ConfigError(`${where}.repo must be a GitHub repository (https://github.com/owner/name)`);
  const environment = str(o.environment, `${where}.environment`);
  if (!ENV_RE.test(environment)) throw new ConfigError(`${where}.environment must be a cloud environment id (env_...)`);
  if (o.connectors !== undefined && typeof o.connectors !== 'boolean') throw new ConfigError(`${where}.connectors must be true or false`);
  return {
    repo,
    revision: o.revision === undefined ? DEFAULT_PROFILE_FIELDS.revision : str(o.revision, `${where}.revision`),
    environment,
    model: o.model === undefined ? DEFAULT_PROFILE_FIELDS.model : str(o.model, `${where}.model`),
    allowed_tools: o.allowed_tools === undefined ? [...DEFAULT_PROFILE_FIELDS.allowed_tools] : strList(o.allowed_tools, `${where}.allowed_tools`),
    connectors: o.connectors === undefined ? DEFAULT_PROFILE_FIELDS.connectors : (o.connectors as boolean),
    deadline_min: o.deadline_min === undefined ? DEFAULT_PROFILE_FIELDS.deadline_min : posInt(o.deadline_min, `${where}.deadline_min`),
  };
}

const OUTPUT_TYPES = ['notification', 'file', 'slack', 'command', 'firstmate'] as const;

export function parseOutput(v: unknown, where: string): OutputConfig {
  const o = obj(v, where);
  const type = str(o.type, `${where}.type`);
  const events = o.events === undefined ? ['*'] : strList(o.events, `${where}.events`);
  switch (type) {
    case 'notification':
      return { type, events };
    case 'file':
      return { type, path: str(o.path, `${where}.path`), events };
    case 'slack': {
      const name = o.webhook_env === undefined ? 'CLAUDE_PLUGIN_OPTION_SLACK_WEBHOOK' : str(o.webhook_env, `${where}.webhook_env`);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new ConfigError(`${where}.webhook_env must name an environment variable; the URL itself never goes in the file`);
      return { type, webhook_env: name, events };
    }
    case 'command': {
      const argv = strList(o.argv, `${where}.argv`);
      if (argv.length === 0) throw new ConfigError(`${where}.argv must not be empty`);
      const out: OutputConfig = { type, argv, events };
      if (o.timeout_s !== undefined) out.timeout_s = posInt(o.timeout_s, `${where}.timeout_s`);
      return out;
    }
    case 'firstmate': {
      const mode = o.mode === undefined ? 'shared' : str(o.mode, `${where}.mode`);
      if (mode !== 'shared' && mode !== 'dedicated') throw new ConfigError(`${where}.mode must be shared or dedicated`);
      return { type, status_file: str(o.status_file, `${where}.status_file`), home: str(o.home, `${where}.home`), mode, events };
    }
    default:
      throw new ConfigError(`${where}.type must be one of ${OUTPUT_TYPES.join(', ')}`);
  }
}

export function parseConfig(v: unknown): Config {
  const o = obj(v, 'config');
  if (o.version !== 1) throw new ConfigError('config.version must be 1');
  const profiles: Record<string, Profile> = {};
  for (const [name, p] of Object.entries(obj(o.profiles ?? {}, 'config.profiles'))) {
    if (!isValidProfileName(name)) throw new ConfigError(`profile name "${name}" must be lowercase letters, digits, dot, dash or underscore`);
    profiles[name] = parseProfile(p, `profiles.${name}`);
  }
  const defaultProfile = o.default_profile === undefined || o.default_profile === null ? null : str(o.default_profile, 'config.default_profile');
  if (defaultProfile !== null && !profiles[defaultProfile]) throw new ConfigError(`default_profile "${defaultProfile}" is not in profiles`);
  const w = obj(o.watch ?? {}, 'config.watch');
  const watch: WatchConfig = { ...DEFAULT_WATCH };
  for (const k of Object.keys(w)) {
    if (!(k in DEFAULT_WATCH)) throw new ConfigError(`watch.${k} is not a known field`);
    if (k === 'model') watch.model = str(w.model, 'watch.model');
    else (watch as unknown as Record<string, number>)[k] = posInt(w[k], `watch.${k}`);
  }
  if (watch.silence_severe_min <= watch.silence_min) throw new ConfigError('watch.silence_severe_min must be greater than watch.silence_min');
  const outputs = o.outputs === undefined ? defaultConfig().outputs : (() => {
    if (!Array.isArray(o.outputs)) throw new ConfigError('config.outputs must be a list');
    return o.outputs.map((x, i) => parseOutput(x, `outputs[${i}]`));
  })();
  if (o.permission_hook !== undefined && typeof o.permission_hook !== 'boolean') throw new ConfigError('config.permission_hook must be true or false');
  if (o.preflight_auto !== undefined && typeof o.preflight_auto !== 'boolean') throw new ConfigError('config.preflight_auto must be true or false');
  if (o.permission_unblock !== undefined && typeof o.permission_unblock !== 'boolean') throw new ConfigError('config.permission_unblock must be true or false');
  return {
    version: 1,
    default_profile: defaultProfile,
    profiles,
    watch,
    outputs,
    permission_hook: o.permission_hook === true,
    preflight_auto: o.preflight_auto === true,
    permission_unblock: o.permission_unblock === true,
  };
}

/** The configuration, or the defaults when there is no file yet. */
export function loadConfig(paths: Paths): { config: Config; exists: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(paths.config, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: defaultConfig(), exists: false };
    throw new ConfigError(`${paths.config}: ${(err as Error).message}`);
  }
  try {
    return { config: parseConfig(JSON.parse(text)), exists: true };
  } catch (err) {
    if (err instanceof SyntaxError) throw new ConfigError(`${paths.config}: invalid JSON (${err.message})`);
    if (err instanceof ConfigError) throw new ConfigError(`${paths.config}: ${err.message}`);
    throw err;
  }
}

export function saveConfig(paths: Paths, config: Config): void {
  writeJsonAtomic(paths.config, config, 0o600);
}

export function pickProfile(config: Config, name: string | undefined): { name: string; profile: Profile } {
  const chosen = name ?? config.default_profile ?? undefined;
  if (!chosen) {
    const names = Object.keys(config.profiles);
    if (names.length === 0) throw new ConfigError('there is no profile yet: run /kharos:setup first');
    throw new ConfigError(`no default profile; pass --profile (one of: ${names.join(', ')})`);
  }
  const profile = config.profiles[chosen];
  if (!profile) throw new ConfigError(`profile "${chosen}" does not exist (known: ${Object.keys(config.profiles).join(', ') || 'none'})`);
  return { name: chosen, profile };
}

// Preparing a launch: every check that can stop it runs here, before anything reaches the service, and
// the routine body is written to disk so the hook can hand it to RemoteTrigger `create` unchanged.

import fs from 'node:fs';
import { readAuthStatus } from './account.ts';
import { buildCreateBody, MAX_INSTRUCTION_CHARS, sha256 } from './body.ts';
import { ConfigError, loadConfig, pickProfile, repoSlug, type Config } from './config.ts';
import { writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';
import { activeCount, bodyPath, formatId, updateRegistry, type Session } from './registry.ts';
import { loadRepos, readRemoteHeads, type RemoteHeads } from './repo.ts';

export interface PrepareOptions {
  instruction: string;
  profile?: string;
  model?: string;
  title?: string;
  deadline_min?: number;
  claude_session: string | null;
  now: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the remote heads of the repository. */
  heads?: (url: string, revision: string) => RemoteHeads;
}

export class LaunchError extends Error {
  readonly lines: string[];
  constructor(lines: string[]) {
    super(lines.join('\n'));
    this.lines = lines;
  }
}

export function defaultTitle(instruction: string): string {
  const first = instruction.split('\n').find((l) => l.trim() !== '') ?? 'cloud session';
  const t = first.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

export function prepare(paths: Paths, opts: PrepareOptions): Session {
  const env = opts.env ?? process.env;
  let picked;
  let config: Config;
  try {
    const loaded = loadConfig(paths);
    if (!loaded.exists) throw new LaunchError(['kharos has no configuration yet: run /kharos:setup first.']);
    config = loaded.config;
    picked = pickProfile(config, opts.profile);
  } catch (err) {
    if (err instanceof ConfigError) throw new LaunchError([err.message]);
    throw err;
  }
  const { name: profileName, profile } = picked;

  const instruction = opts.instruction.trim();
  if (instruction === '') throw new LaunchError(['The instruction is empty.']);
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new LaunchError([`The instruction has ${instruction.length} characters; the limit is ${MAX_INSTRUCTION_CHARS}. Put the details in a file in the repository and point to it.`]);
  }

  if (env.ANTHROPIC_API_KEY) {
    throw new LaunchError(['ANTHROPIC_API_KEY is set: it takes precedence over the claude.ai login, and cloud sessions need the login. Unset it and start Claude Code again.']);
  }
  const auth = readAuthStatus(env);
  if (!auth || !auth.loggedIn || auth.authMethod !== 'claude.ai' || !auth.account) {
    throw new LaunchError(['Claude Code is not logged in with a claude.ai account (Pro, Max, Team or Enterprise). Run `claude auth login`, then /kharos:doctor.']);
  }

  // Repository readiness, before the first launch in a repository and while it is not known to work.
  const known = loadRepos(paths)[repoSlug(profile.repo)];
  if (known?.access !== 'ok') {
    const heads = (opts.heads ?? ((u, r) => readRemoteHeads(u, r, env)))(profile.repo, profile.revision);
    if (heads.readable && heads.empty) {
      throw new LaunchError([
        `${repoSlug(profile.repo)} has no commit yet, and a cloud session cannot start from an empty repository.`,
        'Run /kharos:setup to add an initial commit (it asks before writing), or push one yourself.',
      ]);
    }
    if (heads.readable && !heads.hasRevision) {
      throw new LaunchError([
        `${repoSlug(profile.repo)} has no branch or tag "${profile.revision}"${heads.defaultBranch ? `; its default branch is "${heads.defaultBranch}"` : ''}.`,
        `Fix "revision" of profile "${profileName}" with /kharos:setup.`,
      ]);
    }
  }

  const model = opts.model ?? profile.model;
  const deadline = opts.deadline_min ?? profile.deadline_min;
  const title = (opts.title?.trim() || defaultTitle(instruction)).slice(0, 120);
  const createdAt = new Date(opts.now).toISOString();

  return updateRegistry(paths, (reg) => {
    if (activeCount(reg) >= config.watch.max_open) {
      throw new LaunchError([
        `There are ${activeCount(reg)} sessions open, and watch.max_open is ${config.watch.max_open}.`,
        'Close finished ones with /kharos:close, or raise watch.max_open in the configuration.',
      ]);
    }
    const id = formatId(reg.next_seq);
    reg.next_seq++;
    const body = buildCreateBody({ id, title, instruction, profile, model, now: opts.now });
    writeJsonAtomic(bodyPath(paths, id), body);
    const s: Session = {
      id,
      title,
      profile: profileName,
      account: auth.account as string,
      repo: profile.repo,
      revision: profile.revision,
      model,
      environment: profile.environment,
      deadline_min: deadline,
      instruction_sha256: sha256(instruction),
      launched_by: opts.claude_session,
      trigger_id: null,
      session_id: null,
      url: null,
      created_at: createdAt,
      fired_at: null,
      runs_seen_empty_at: null,
      step: 'prepared',
      state: 'launching',
      state_since: createdAt,
      pending_state: null,
      last_event_at: null,
      last_read_at: null,
      reads: 0,
      read_failures: 0,
      closed_turns: 0,
      notice: null,
      last_notice: null,
      result: { status: null, pr: null, branch: null, summary: null, question: null },
      pending_cursor: null,
      seen_start: false,
      cursor_reads: 0,
      closed_at: null,
      error: null,
    };
    reg.sessions[id] = s;
    return s;
  });
}

export function readInstruction(file: string | undefined, stdin: () => string): string {
  if (file) return fs.readFileSync(file, 'utf8');
  return stdin();
}

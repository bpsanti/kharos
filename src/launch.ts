// Preparing a launch: every check that can stop it runs here, before anything reaches the service, and
// the routine body is written to disk so the hook can hand it to RemoteTrigger `create` unchanged.

import fs from 'node:fs';
import type { HookRules } from '../cloud/kharos-permission.mjs';
import { readAuthStatus } from './account.ts';
import { buildCreateBody, MAX_INSTRUCTION_CHARS, sha256, sideBranchLines } from './body.ts';
import { ConfigError, loadConfig, pickProfile, repoSlug, type Config, type OutputConfig, type Profile } from './config.ts';
import { ghForge, realGh, type Forge } from './forge.ts';
import { appendLine, writeJsonAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';
import { activeCount, bodyPath, formatId, updateRegistry, type Session } from './registry.ts';
import { hooksBlocked, mirrorRefusal, readManagedPolicy, type ManagedPolicy } from './managed-policy.ts';
import { confirmationState, describeConfirmation, loadConfirmation } from './org-confirmations.ts';
import { HOOK_RULES_PATH, HOOK_SCRIPT_PATH, HookError, hookSnapshot, parseRulesText, planHook, type FileChange } from './permission-hook.ts';
import { SETTINGS_PATH, SettingsError } from './permission-profiles.ts';
import { EMPTY_CHANGE, readRemoteHookFiles, type RemoteHookFiles } from './permissions.ts';
import { applicable, buildPreflight, hookFilesOf, readHistory, selectFiles } from './preflight.ts';
import { loadRepos, readRemoteHeads, type RemoteHeads } from './repo.ts';

export interface PrepareOptions {
  instruction: string;
  profile?: string;
  model?: string;
  title?: string;
  deadline_min?: number;
  /** Outputs given to this launch only, such as the firstmate adapter. */
  extra_outputs?: OutputConfig[];
  /** Extra lines for the protocol footer, such as the session sheet a dedicated firstmate task needs. */
  footer_lines?: string[];
  claude_session: string | null;
  now: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the remote heads of the repository. */
  heads?: (url: string, revision: string) => RemoteHeads;
  /** Test seam: the kharos permission hook's files on the branch. */
  hookFiles?: (repo: string, revision: string) => RemoteHookFiles;
  /** Test seam: the local copy of the organization's managed settings. */
  managedPolicy?: () => ManagedPolicy;
  /** Test seam: GitHub, for automatic permission preflight. */
  forge?: Forge;
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
  // With the opt-in permission hook, the rules on the branch now are the ones the session's hook uses,
  // so the watcher can attribute its decisions. An unreadable branch gives no rules, and no attribution;
  // nor does a managed policy that runs no repository hook.
  const policy = config.permission_hook || config.preflight_auto ? (opts.managedPolicy ?? (() => readManagedPolicy(env)))() : null;
  let hookRules = null;
  if (config.permission_hook && policy && !hooksBlocked(policy)) {
    const found = (opts.hookFiles ?? ((r, rev) => readRemoteHookFiles(r, rev, env)))(profile.repo, profile.revision);
    hookRules = found.status === 'found' ? hookSnapshot(found.files) : null;
  }
  const forge = opts.forge ?? ghForge(realGh(env));
  const auto = config.preflight_auto && policy ? planAuto(paths, config, profile, instruction, policy, forge) : null;

  const prepared = updateRegistry(paths, (reg) => {
    if (activeCount(reg) >= config.watch.max_open) {
      throw new LaunchError([
        `There are ${activeCount(reg)} sessions open, and watch.max_open is ${config.watch.max_open}.`,
        'Close finished ones with /kharos:close, or raise watch.max_open in the configuration.',
      ]);
    }
    const id = formatId(reg.next_seq);
    reg.next_seq++;
    const body = buildCreateBody({ id, title, instruction, profile, model, footerLines: opts.footer_lines ?? [], now: opts.now });
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
      permission: null,
      result: { status: null, pr: null, branch: null, summary: null, question: null },
      pending_cursor: null,
      seen_start: false,
      extra_outputs: opts.extra_outputs ?? [],
      cursor_reads: 0,
      closed_at: null,
      error: null,
      permission_hook: hookRules,
      preflight: auto === null ? null : 'skipped' in auto ? { status: 'skipped', reason: auto.skipped } : { status: 'creating', branch: `kharos/${id}`, base: profile.revision, applied: auto.patterns },
    };
    reg.sessions[id] = s;
    return s;
  });
  if (auto === null || 'skipped' in auto) return prepared;

  // The side branch is made outside the registry lock: it is a few calls to GitHub.
  const id = prepared.id;
  const branch = `kharos/${id}`;
  const made = forge.createBranch(profile.repo, branch, auto.base, auto.files, `chore: add the kharos permission hook for cloud session ${id}\n\nAutomatic permission preflight; kharos deletes this branch when the session is closed.`);
  return updateRegistry(paths, (reg) => {
    const s = reg.sessions[id] as Session;
    if (!made.ok) {
      s.preflight = { status: 'skipped', reason: `the side branch ${branch} could not be created (${made.error}); the session starts on ${profile.revision} without the suggested rules` };
      return s;
    }
    const body = buildCreateBody({
      id,
      title,
      instruction,
      profile: { ...profile, revision: branch },
      model,
      footerLines: [...(opts.footer_lines ?? []), ...sideBranchLines(branch, profile.revision, made.commit)],
      now: opts.now,
    });
    writeJsonAtomic(bodyPath(paths, id), body);
    s.revision = branch;
    s.permission_hook = auto.rules;
    s.preflight = { status: 'applied', branch, base: profile.revision, commit: made.commit, applied: auto.patterns, mirrored: auto.mirrored, unblock: auto.unblock, note: auto.note, deleted_at: null };
    appendLine(paths.preflight, JSON.stringify({ at: new Date(opts.now).toISOString(), kharos: id, repo: profile.repo, base: profile.revision, branch, commit: made.commit, applied: auto.patterns, mirrored: auto.mirrored, unblock: auto.unblock }));
    return s;
  });
}

type AutoPlan = { patterns: string[]; mirrored: string[]; unblock: boolean; note: string | null; files: { path: string; content: string }[]; base: { commit: string; tree: string }; rules: HookRules | null } | { skipped: string };

/**
 * What automatic permission preflight writes for this launch: the suggested narrow patterns, through
 * the same plan and filters as `kharos permissions hook diff`, with no broad pattern of its own; the
 * organization's ask rules are mirrored while a remembered mirror confirmation matches the managed settings.
 */
function planAuto(paths: Paths, config: Config, profile: Profile, instruction: string, policy: ManagedPolicy, forge: Forge): AutoPlan {
  if (!config.permission_hook) return { skipped: 'preflight_auto is on, but permission_hook is off, so nothing was applied' };
  const blocked = hooksBlocked(policy);
  if (blocked) return { skipped: `${blocked}; nothing was applied` };
  const read = forge.snapshot(profile.repo, profile.revision, selectFiles);
  if (!read.ok) return { skipped: `${repoSlug(profile.repo)}@${profile.revision} could not be read with gh (${read.error}); nothing was applied` };
  const snap = read.snapshot;
  if (!snap.base) return { skipped: `${snap.label} has no commit to start a side branch from; nothing was applied` };
  const unreadable = [SETTINGS_PATH, HOOK_SCRIPT_PATH, HOOK_RULES_PATH].filter((p) => snap.unreadable.has(p));
  if (unreadable.length) return { skipped: `${unreadable.join(', ')} could not be read as text; nothing was applied` };
  const history = readHistory(paths, profile.repo);
  const confirmation = confirmationState(loadConfirmation(paths, 'mirror'), policy);
  const report = buildPreflight({ snapshot: snap, repo: profile.repo, policy, history: history.prompts, sessionsRead: history.sessions, instruction, confirmation, autoMirror: true });
  const patterns = applicable(report);
  // The organization's ask rules are mirrored only with the person's remembered confirmation, while
  // its managed settings still match it, and never as broad rules.
  // The unblock preset, with permission_unblock, only while its own remembered confirmation matches.
  const unblockState = config.permission_unblock ? confirmationState(loadConfirmation(paths, 'unblock'), policy) : null;
  const unblock = unblockState?.state === 'valid' && mirrorRefusal(policy) === null;
  const mirror = !unblock && confirmation.state === 'valid' && mirrorRefusal(policy) === null;
  const notes: string[] = [];
  if (unblockState && !unblock) {
    const refusal = mirrorRefusal(policy);
    notes.push(
      refusal
        ? `the unblock preset was not applied: ${refusal}`
        : `the unblock preset was not applied: ${unblockState.state === 'changed' ? describeConfirmation(unblockState, 'unblock') : 'it is not confirmed'}; \`kharos permissions unblock show\` lists what it opens`,
    );
  }
  if (!unblock && confirmation.state === 'changed') notes.push(`${describeConfirmation(confirmation)}, so the organization's ask rules were not mirrored: \`kharos permissions hook diff --mirror\` in a checkout asks again`);
  const note = notes.length ? notes.join('; ') : null;
  if (patterns.length === 0 && !mirror && !unblock) return { skipped: `the preflight found no narrow rule to apply${note ? `; ${note}` : ''}` };
  let changes: FileChange[];
  let mirrored: string[] = [];
  try {
    const plan = planHook(hookFilesOf(snap), { ...EMPTY_CHANGE, allow: patterns, mirror, unblock: unblock ? 'on' : null }, policy);
    if (!plan.token) return { skipped: `the suggested rules are on the branch already${note ? `; ${note}` : ''}` };
    changes = plan.changes;
    mirrored = plan.mirror?.converted ?? [];
  } catch (err) {
    if (err instanceof HookError || err instanceof SettingsError) return { skipped: `${err.message}; nothing was applied` };
    throw err;
  }
  const rulesText = changes.find((c) => c.path === HOOK_RULES_PATH)?.after ?? hookFilesOf(snap).rules;
  const rules = rulesText ? parseRulesText(rulesText) : null;
  return {
    patterns,
    mirrored,
    unblock,
    note,
    files: changes.flatMap((c) => (c.after === null ? [] : [{ path: c.path, content: c.after }])),
    base: snap.base,
    rules: rules && !('error' in rules) ? rules : null,
  };
}

/** The line a launch prints about automatic permission preflight, or null when it was off. */
export function preflightLine(s: Session): string | null {
  const p = s.preflight;
  if (!p) return null;
  if (p.status === 'skipped') return `permission preflight: ${p.reason}.`;
  if (p.status === 'creating') return `permission preflight: the side branch ${p.branch} was not finished; the session starts on ${p.base}.`;
  const mirrored = p.unblock
    ? `, and the unblock preset, with your remembered confirmation: every permission prompt of the session is allowed, with no person asked`
    : p.mirrored?.length
      ? `, and mirrored ${p.mirrored.length} organization ask rule(s) with your remembered confirmation (${p.mirrored.join(', ')})`
      : '';
  const what = p.applied.length ? `: ${p.applied.join(' | ')}` : '';
  return `permission preflight: wrote ${p.applied.length} narrow allow pattern(s) of the kharos permission hook${mirrored} to the side branch ${p.branch} (from ${p.base}), and the session starts there${what}. ${p.base} is not changed; /kharos:close deletes the branch.${p.note ? ` Note: ${p.note}.` : ''}`;
}

export function readInstruction(file: string | undefined, stdin: () => string): string {
  if (file) return fs.readFileSync(file, 'utf8');
  return stdin();
}

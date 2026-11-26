// /kharos:setup as one guided flow: everything a launch needs, in the order each depends on the one
// before, with its state and the one action that fixes it. Two facts only Claude Code itself can see, the
// account's cloud environments and whether Claude reaches the repository of the current folder, come from
// the bundled /schedule skill, which lists them when it loads; the setup skill passes that text here.
// Nothing is written until every step is settled, and then only the profile: the repository's files change
// through /kharos:permissions, after the person approves its diff.

import path from 'node:path';
import { migrate } from './accounts.ts';
import { ACCOUNT_AUTO_CAVEAT, ACCOUNT_AUTO_EFFECT, applyAccountMode, approveAccountMode, readAccountMode } from './account-mode.ts';
import { CommandError } from './commands.ts';
import { applyUnblockAll, approveUnblockAll, describeUnblockAll, preview, readUnblockAll, UNBLOCK_ALL_SKILL, UNBLOCK_ALL_UNDO, type Part } from './unblock-all.ts';
import { scriptDigest, SETUP_SCRIPT_PATH } from './environment.ts';
import { findSetup, loadSetups, recordSetup } from './state.ts';
import { clean } from './body.ts';
import { DEFAULT_WATCH, isPermissionChoice, loadConfig, MAX_OPEN_CHOICES, MAX_OPEN_TRADEOFF, maxOpenChosen, normalizeRepo, otherAccount, PERMISSION_CHOICES, repoSlug, saveConfig, type Config, type PermissionChoice, type Profile } from './config.ts';
import { activeCount, loadRegistry } from './registry.ts';
import { accountChecks, CHECKED_BY_CLAUDE_CODE, LAUNCH_APPROVAL, runDoctor, type Check, type DoctorDeps } from './doctor.ts';
import { hooksBlocked, mirrorRefusal, type ManagedPolicy } from './managed-policy.ts';
import { hasHookEntry, hookState, UNBLOCK_RISK } from './permission-hook.ts';
import { identify, parseSettings, readRules, SettingsError } from './permission-profiles.ts';
import type { Paths } from './paths.ts';
import { accessFix, loadRepos, recordAccess, type RepoRole } from './repo.ts';
import { writeProfile } from './commands.ts';

/** One cloud environment as Claude Code lists it. */
export interface Environment {
  name: string;
  id: string;
  kind: string;
}

/** What the /schedule skill showed: the account's environments, and its notes about GitHub. */
export interface ScheduleView {
  /** Whether the environment list itself was shown; without it, `environments` says nothing about the account. */
  listed: boolean;
  environments: Environment[];
  notes: string[];
}

const ENV_LINE = /^-\s+(.+?)\s+\(id:\s*(env_\w+),\s*kind:\s*([\w-]+)\)$/;

/**
 * Reads the "Available environments" list and the GitHub notes from the text the /schedule skill showed;
 * null when the text holds neither, so an empty paste reads as "not listed", not as "no environments".
 */
export function parseScheduleView(text: string): ScheduleView | null {
  const environments: Environment[] = [];
  const notes: string[] = [];
  let listed = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^Available environments:?$/i.test(line)) {
      listed = true;
      continue;
    }
    const m = ENV_LINE.exec(line);
    if (m) {
      listed = true;
      if (!environments.some((e) => e.id === m[2])) environments.push({ name: clean(m[1] as string, 100), id: m[2] as string, kind: m[3] as string });
      continue;
    }
    if (/github/i.test(line)) notes.push(clean(line.replace(/^[-*\s⚠]+/u, ''), 400));
  }
  return listed || notes.length > 0 ? { listed, environments, notes } : null;
}

export type GitHub =
  | { state: 'connected' }
  | { state: 'not-connected'; note: string }
  | { state: 'no-access'; note: string }
  | { state: 'unverified'; note: string }
  | { state: 'not-checked'; why: string };

const SLUG = '([\\w.-]+/[\\w.-]+?)';
const NO_ACCESS = [new RegExp(`GitHub not connected for ${SLUG}(?=[\\s,.]|$)`, 'i'), new RegExp(`GitHub App not installed on ${SLUG}(?=[\\s,.]|$)`, 'i')];
const UNVERIFIED = new RegExp(`verify GitHub access for ${SLUG}(?=[\\s,.(]|$)`, 'i');

/**
 * Claude's GitHub side, from the notes of the /schedule skill. It checks only the repository of the folder
 * Claude Code runs in, so silence means access only when that is the target; a missing connection is about
 * the account, so it counts for any repository.
 */
export function readGitHub(view: ScheduleView | null, here: string | null, target: string): GitHub {
  if (!view) return { state: 'not-checked', why: 'Claude Code did not list your account (the /schedule skill was not read)' };
  const same = (repo: string | undefined) => !!repo && repo.toLowerCase() === target.toLowerCase();
  for (const note of view.notes) {
    if (/isn't connected to your Claude account|is not connected to your Claude account/i.test(note)) return { state: 'not-connected', note };
  }
  for (const note of view.notes) {
    if (NO_ACCESS.some((re) => same(re.exec(note)?.[1]))) return { state: 'no-access', note };
    if (same(UNVERIFIED.exec(note)?.[1])) return { state: 'unverified', note };
  }
  if (view.environments.length > 0 && same(here ?? undefined)) return { state: 'connected' };
  return {
    state: 'not-checked',
    why: here ? `Claude Code checks only the repository of the current folder (${here})` : 'the current folder is not a checkout of a GitHub repository',
  };
}

export type StepState = 'ok' | 'missing' | 'choose' | 'check' | 'note' | 'waiting';

export interface Step {
  title: string;
  state: StepState;
  detail: string;
  /** What fixes it, as one action; shown for every state but ok. */
  action?: string;
}

/** A permission mode, or a part of one, with what it does, its trade-off, and whether this account can have it. */
export interface PermissionOption {
  id: PermissionChoice | 'mirror' | 'broad';
  title: string;
  does: string;
  tradeoff: string;
  /** null when available; otherwise why not, for this account and organization. */
  unavailable: string | null;
  /** Something the person should know before choosing it, such as needing a checkout. */
  note?: string;
}

export interface EnvironmentChoice {
  name: string;
  recommended: boolean;
}

export type Next =
  | { kind: 'person'; step: number; action: string }
  | { kind: 'ask-initial-commit' }
  | { kind: 'ask-adopt'; profiles: string[] }
  | { kind: 'ask-environment'; options: EnvironmentChoice[]; problem?: string }
  /** The repository ships a setup script: does the picked environment run it? */
  | { kind: 'ask-environment-ready'; environment: string; script: string; changed: boolean }
  /** No environment fits: the assisted path of `kharos env-guide`. */
  | { kind: 'env-assist'; action: string }
  | {
      kind: 'ask-permissions';
      options: PermissionOption[];
      /** The modes to offer for the repository; empty when that choice is made already. */
      offer: PermissionChoice[];
      /** What unblock-all frees and its token, the preview of that option; null when it is not offered. */
      unblockAll: { text: string; token: string } | null;
    }
  /** How many cloud sessions may be open at once (watch.max_open), asked once per account. */
  | { kind: 'ask-max-open' }
  | { kind: 'ready'; summary: string[] }
  | { kind: 'not-ready'; summary: string[] };

/** The watch.max_open question, asked once per account: the values to offer, recommended first, and the sessions open now. */
export interface MaxOpenQuestion {
  options: number[];
  open: number;
}

export interface SetupResult {
  repo: string;
  profile: string;
  steps: Step[];
  next: Next;
  /** Asked with the question of `next`, or as `next` itself once nothing else is open; null once answered. */
  maxOpen: MaxOpenQuestion | null;
}

export interface SetupInput {
  repo: string;
  profile?: string;
  revision?: string;
  model?: string;
  deadline_min?: number;
  allowed_tools?: string[];
  connectors?: boolean;
  makeDefault: boolean;
  /** What the /schedule skill showed, or null when it was not read. */
  view: ScheduleView | null;
  /** owner/name of the current folder's GitHub origin, where the /schedule skill checked access. */
  here: string | null;
  /** The environment the person picked: its name, its id, or `new` for one still to create. */
  environment?: string;
  /** The permission mode the person picked. */
  permissions?: string;
  /** For scripts: whether this account's sessions start in auto mode, `auto` with the token of the approved diff, or `as-is`. Setup asks it only as part of unblock-all. */
  accountMode?: 'auto' | 'as-is';
  accountExpect?: string;
  /** With permissions unblock-all: the token of what it frees, which the person confirmed. */
  unblockExpect?: string;
  /** The person said the picked environment is set up for the repository (it runs its setup script). */
  confirmed?: boolean;
  /** How many cloud sessions may be open at once, the person's answer to the watch.max_open question. */
  maxOpen?: number;
  /** The folders every account shared, when this account has files of its own. */
  shared: Paths | null;
  /** Profiles of the shared files whose account kharos cannot tell, that the person said are theirs; [] for none. */
  adopt: string[] | null;
  noRemoteTool: boolean;
  now: number;
  env: NodeJS.ProcessEnv;
}

export type SetupDeps = DoctorDeps;

export const TITLES = ['Account and plan', 'GitHub connection', 'Repository access', 'Cloud environment', 'Commit identity', 'Permission prompts', 'Profile'] as const;

export function profileName(repo: string): string {
  const base = (repoSlug(repo).split('/')[1] ?? 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  return base || 'default';
}

const NEW_ENVIRONMENT = (slug: string) =>
  `kharos env-guide --repo ${slug} --copy --open prepares what to paste into a new environment (the repository's setup script, the variable names, the network level); create it on https://claude.ai/code, then say so, and setup lists your environments again.`;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The environments to offer, the best fit for the repository first. */
export function rankEnvironments(envs: Environment[], slug: string, config: Config): Environment[] {
  const repoName = norm(slug.split('/')[1] ?? '');
  const usedHere = new Set(Object.values(config.profiles).filter((p) => repoSlug(p.repo).toLowerCase() === slug.toLowerCase()).map((p) => p.environment));
  const score = (e: Environment) =>
    norm(e.name) === repoName ? 0 : repoName && norm(e.name).includes(repoName) ? 1 : usedHere.has(e.id) ? 2 : e.kind === 'anthropic_cloud' && norm(e.name) === 'default' ? 3 : 4;
  return envs.map((e, i) => ({ e, i })).sort((a, b) => score(a.e) - score(b.e) || a.i - b.i).map((x) => x.e);
}

/** Every permission mode kharos has, marked unavailable with the reason when this account or organization rules it out. */
export function permissionOptions(
  policy: ManagedPolicy,
  ctx: { standardInPlace: boolean; hookInPlace: boolean; checkout: string | null; role: RepoRole; slug: string; unblockAll?: readonly Part[] },
): PermissionOption[] {
  const blocked = hooksBlocked(policy);
  const refusal = mirrorRefusal(policy)?.replace(/^(mirroring is unavailable|refused): /, '') ?? null;
  const noAsk = policy.status === 'found' && policy.ask.length === 0 ? "the organization's managed settings have no ask rule to mirror" : null;
  const inRepo = [
    ctx.checkout ? null : `needs a checkout of ${ctx.slug}: run /kharos:permissions there`,
    ctx.role === 'read' ? `your GitHub login cannot push to ${ctx.slug}: its maintainers commit the change` : null,
  ]
    .filter(Boolean)
    .join('; ');
  const withNote = (o: PermissionOption, note: string): PermissionOption => (note ? { ...o, note } : o);
  return [
    {
      id: 'as-is',
      title: 'Leave the rules as they are',
      does: 'nothing changes; before each launch kharos lists the prompts the session is likely to hit, and tells you when one waits',
      tradeoff: 'a session stops at every ask rule and after repeated classifier blocks, until you answer on its page',
      unavailable: null,
    },
    withNote(
      {
        id: 'standard',
        title: 'Standard profile',
        does: "adds narrow allow rules to the repository's .claude/settings.json: file tools, read-only shell commands, git commands that read, commit and branch, and the repository's build and test commands",
        tradeoff: 'a change to a tracked file that you commit and push; it does nothing against ask rules, the organization\'s included',
        unavailable: ctx.standardInPlace ? 'already in place on the launch branch' : null,
      },
      inRepo,
    ),
    withNote(
      {
        id: 'hook',
        title: 'Permission hook (opt-in)',
        does: 'answers prompts inside cloud sessions with your own narrow allow patterns and prefix rules, and denies the rest with the allowed form, so a session never waits at a prompt',
        tradeoff: 'it answers with no person asked; three files to commit; turns permission_hook on for this machine',
        unavailable: blocked ?? (ctx.hookInPlace ? 'already in place on the launch branch' : null),
      },
      inRepo,
    ),
    withNote(
      {
        id: 'standard+hook',
        title: 'Standard profile and permission hook',
        does: 'both of the above: narrow allow rules against the classifier, the hook against ask rules',
        tradeoff: 'both trade-offs; two changes to review',
        unavailable: blocked,
      },
      inRepo,
    ),
    {
      id: 'mirror',
      title: "Mirror the organization's ask rules (part of the hook)",
      does: "turns the organization's Bash ask rules into a cloud-only allow, after you confirm the list",
      tradeoff: 'allows what the organization chose to have a person approve: check with its administrator first',
      unavailable: blocked ?? refusal ?? noAsk,
    },
    {
      id: 'broad',
      title: 'Broad patterns, --broad (part of the hook)',
      does: 'lets the hook allow a shell, an interpreter, a wrapper or a wildcard program, or mirror broad organization rules',
      tradeoff: 'any command such a rule covers runs with no person asked',
      unavailable: blocked,
    },
    {
      id: 'auto-preflight',
      title: 'Automatic preflight (opt-in)',
      does: 'at each launch, writes the narrow rules the preflight suggests to a side branch kharos/<id>, and the session starts there; the launch branch never changes',
      tradeoff: 'a merged or prefix rule can allow more than the command it was learned from; needs the permission hook on',
      unavailable: blocked,
    },
    withNote(
      {
        id: 'unblock',
        title: 'Unblock preset (opt-in)',
        does: "the hook allows every prompt in this repository's cloud sessions, of any tool, and mirrors every organization ask rule; deny rules stay",
        tradeoff: `${UNBLOCK_RISK}; confirmed once against the organization's settings, and asked again when they change`,
        unavailable: blocked ?? refusal,
      },
      inRepo,
    ),
    unblockAllOption(ctx.unblockAll ?? null),
  ];
}

/** Everything kharos can free for this account, in one step: available while any of its parts is. */
function unblockAllOption(parts: readonly Part[] | null): PermissionOption {
  const out = parts?.filter((p) => p.unavailable && !p.on) ?? [];
  const option: PermissionOption = {
    id: 'unblock-all',
    title: 'Unblock all (opt-in, for the whole account)',
    does: "one confirmation frees every prompt kharos can free: the unblock preset, confirmed for the organization's settings, goes on a side branch of each launch (no checkout changes), and this account's sessions start in auto mode, so launches need no approval prompt",
    tradeoff: `${UNBLOCK_RISK}, at every launch, while your confirmation matches the organization's settings; and ${ACCOUNT_AUTO_EFFECT}; \`${UNBLOCK_ALL_UNDO}\` takes all of it back`,
    unavailable: !parts
      ? null
      : out.length === parts.length
        ? out.map((p) => p.unavailable).join('; ')
        : describeUnblockAll(parts).overall === 'on' || parts.every((p) => p.on || p.unavailable)
          ? 'already in place'
          : null,
  };
  return out.length && out.length < (parts?.length ?? 0) ? { ...option, note: `here it leaves out: ${out.map((p) => `${p.title} (${p.unavailable})`).join('; ')}` } : option;
}

const CHOICE_TEXT: Record<PermissionChoice, string> = {
  'as-is': 'left as they are; kharos lists likely prompts before each launch and tells you when one waits',
  standard: 'the standard profile',
  hook: 'the permission hook',
  'standard+hook': 'the standard profile and the permission hook',
  'auto-preflight': 'automatic preflight on a side branch of each launch',
  unblock: 'the unblock preset',
  'unblock-all': "unblock all: the unblock preset on a side branch of each launch, and this account's sessions in auto mode",
  'auto-unblock': 'automatic unblock on a side branch of each launch',
};

/** The one next action a permission mode still needs, or null when nothing is left to do. */
function permissionAction(choice: PermissionChoice, ctx: { standardInPlace: boolean; hookInPlace: boolean; config: Config; checkout: string | null; slug: string; unblockAllOn: boolean }): string | null {
  const where = ctx.checkout ? '' : ` in a checkout of ${ctx.slug}`;
  const standard = !ctx.standardInPlace ? `/kharos:permissions standard${where}` : null;
  const hook = !ctx.hookInPlace ? `/kharos:permissions hook${where}` : null;
  const enable = ctx.config.permission_hook ? null : 'kharos permissions hook enable';
  switch (choice) {
    case 'as-is':
      return null;
    case 'standard':
      return standard;
    case 'hook':
      return hook;
    case 'standard+hook':
      return [standard, hook].filter(Boolean).join(', then ') || null;
    case 'auto-preflight':
      return ctx.config.preflight_auto ? null : [enable, 'kharos permissions auto preflight on'].filter(Boolean).join(', then ') + ' (yours to run)';
    case 'unblock':
      return `/kharos:permissions unblock${where}`;
    case 'auto-unblock':
      return ctx.config.permission_unblock ? null : UNBLOCK_ALL_SKILL;
    case 'unblock-all':
      return ctx.unblockAllOn ? null : UNBLOCK_ALL_SKILL;
  }
}

/** The modes to offer in the one question, recommended first; any other listed mode can be named instead. */
function offer(options: PermissionOption[], recommended: PermissionChoice): PermissionChoice[] {
  const ids = options.filter((o) => o.unavailable === null && isPermissionChoice(o.id)).map((o) => o.id as PermissionChoice);
  // Unblock all, the one step that frees everything, is always among the offered modes when it is available.
  const first = [recommended, 'unblock-all' as const].filter((id) => ids.includes(id));
  return [...first, ...ids.filter((id) => !first.includes(id))].slice(0, 4);
}

/** Runs the steps in order, writes the profile once they are settled, and says the one next action. */
export function runSetup(paths: Paths, input: SetupInput, deps: SetupDeps): SetupResult {
  const url = normalizeRepo(input.repo);
  const slug = repoSlug(url);
  const auth = deps.auth();
  const account = auth?.account ?? null;
  // Setup is per Claude account: first take this account's profiles and sessions out of the files every account shared.
  const moved = migrate(paths, input.shared, account, input.adopt, input.now);
  const config = loadConfig(paths).config;
  // One file serves every account on the machine; a profile of another account keeps its name, and this one gets its own.
  let name = input.profile ?? profileName(url);
  const taken = config.profiles[name];
  if (taken && otherAccount(taken, account)) {
    if (input.profile !== undefined) throw new SetupError(`profile "${name}" was set up on another Claude account; pick another name with --profile`);
    name = `${name}-${(account as string).replace(/^sha256:/, '').slice(0, 6)}`;
  }
  const existing: Profile | undefined = config.profiles[name];
  const steps: Step[] = [];
  const add = (state: StepState, detail: string, action?: string) => {
    steps.push(action ? { title: TITLES[steps.length] as string, state, detail, action } : { title: TITLES[steps.length] as string, state, detail });
  };

  // 1. Account and plan.
  const login = accountChecks({ noRemoteTool: input.noRemoteTool, env: input.env }, deps, auth);
  const failed = login.find((c) => c.level === 'fail');
  const signedIn = !failed;
  const files = `kharos files of this account: ${path.dirname(paths.config)}`;
  if (failed) add('missing', `${failed.name}: ${failed.detail}`, failed.fix?.join(' '));
  else if (moved.state === 'busy') {
    add(
      'missing',
      `${files}; the files every account on this machine shared hold open sessions of this account that a follower reads right now from those files (${moved.sessions.join(', ')}), so nothing moved: that follower would lose them`,
      'Run /kharos:setup again once they end, or once that follower stops; nothing of this account changes before then.',
    );
  } else if (moved.state === 'ask') {
    add(
      'choose',
      `${files}; the files every account on this machine shared hold profiles whose account kharos cannot tell: ${moved.unknown.join(', ')}`,
      'Say which of them are this account\'s, once; they move to its files, and the others stay for the other accounts.',
    );
  } else {
    const warn = login.find((c) => c.level === 'warn');
    const ok = (n: string) => login.find((c) => c.level === 'ok' && c.name === n)?.detail;
    const plan = ok('plan');
    const parts = [ok('login'), plan ? `${plan.split(':')[0]} plan` : undefined, ok('claude') ? `Claude Code ${ok('claude')?.replace(/\s*\(Claude Code\)$/, '')}` : undefined].filter((x): x is string => !!x);
    const movedNote = moved.state === 'done' ? `; moved from the shared files: ${[moved.profiles.length ? `profile(s) ${moved.profiles.join(', ')}` : '', moved.sessions ? `${moved.sessions} session(s)` : ''].filter(Boolean).join(' and ')}` : '';
    if (warn) add('note', `${parts.join(', ')}; ${warn.detail}; ${files}${movedNote}`);
    else add('ok', `${parts.join(', ')}; ${files}${movedNote}`);
  }

  // 2. GitHub connection of the Claude account.
  const github = signedIn ? readGitHub(input.view, input.here, slug) : null;
  if (!github) add('waiting', 'checked once step 1 is done');
  else if (github.state === 'not-connected') {
    add('missing', github.note, 'Run /web-setup here (it connects the GitHub login of your gh), or connect GitHub at https://claude.ai/connect-github. Then say so, and setup checks again.');
  } else if (github.state === 'connected') add('ok', `connected: Claude Code reached ${slug}`);
  else if (github.state === 'unverified') add('check', github.note, 'Run /kharos:setup again in a few minutes; the first launch also checks it, at no cost.');
  else if (github.state === 'no-access') add('check', `your Claude account does not reach ${slug} yet (step 3)`);
  else add('check', `not confirmed here: ${github.why}`, `The first launch checks it before any session starts, at no cost; to check it now, run /kharos:setup in a checkout of ${slug}.`);

  // 3. The repository, and Claude's access to it.
  let revision = input.revision ?? existing?.revision;
  if (revision === undefined) revision = deps.heads(url, 'HEAD').defaultBranch ?? 'main';
  const heads = deps.heads(url, revision);
  const record = loadRepos(paths)[slug];
  let initialCommit = false;
  if (heads.readable && heads.empty) {
    initialCommit = true;
    add('missing', `${slug} has no commit, and a cloud session cannot start from an empty repository`, 'Setup can create an initial commit with a README.md, after you agree.');
  } else if (heads.readable && !heads.hasRevision) {
    add('missing', `"${revision}" is not a branch or tag of ${slug}${heads.defaultBranch ? ` (default branch: ${heads.defaultBranch})` : ''}`, `Run /kharos:setup ${slug} --revision <an existing branch>.`);
  } else if (github?.state === 'no-access') {
    add('missing', github.note, accessFix(url, deps.ownerType(url)).slice(1, -1).map((l) => l.trim()).join(' ') + ' Then say so, and setup checks again.');
  } else if (github?.state === 'connected') {
    recordAccess(paths, url, 'ok', CHECKED_BY_CLAUDE_CODE, input.now);
    add('ok', `Claude reaches ${slug}@${revision}`);
  } else if (record?.access === 'denied') {
    add('missing', `the service answered ${record.reason ?? 'access denied'} for ${slug} on ${record.checked_at.slice(0, 10)}`, accessFix(url, deps.ownerType(url)).slice(1).map((l) => l.trim()).join(' '));
  } else if (record?.access === 'ok') add('ok', `Claude reaches ${slug}@${revision} (confirmed on ${record.checked_at.slice(0, 10)})`);
  else {
    const local = heads.readable ? `${slug}@${revision} has commits` : `this machine's git could not read ${slug} (${heads.error ?? 'unknown error'}), which the cloud does not need`;
    add('check', `${local}; Claude's access is not confirmed yet`, 'The first launch checks it before any session starts, at no cost (its routine is created disabled).');
  }

  // 4. The cloud environment, picked by name.
  let environment: Environment | null = null;
  let envQuestion: Next | null = null;
  const envs = input.view?.environments ?? [];
  if (!signedIn) add('waiting', 'listed once step 1 is done');
  else if (input.environment === 'new') add('missing', 'a new environment, to create on claude.ai/code', NEW_ENVIRONMENT(slug));
  else if (input.environment !== undefined) {
    const want = input.environment.toLowerCase();
    environment = envs.find((e) => e.name.toLowerCase() === want || e.id === input.environment) ?? null;
    if (!environment && !input.view?.listed && /^env_\w+$/.test(input.environment)) environment = { name: '', id: input.environment, kind: '' };
    if (environment) add('ok', environment.name ? `"${environment.name}"` : `${environment.id} (by id, not checked by name)`);
    else {
      const ranked = rankEnvironments(envs, slug, config);
      add('choose', `no environment of yours is named "${clean(input.environment, 100)}"`, 'Pick one of the environments listed below by name.');
      envQuestion = { kind: 'ask-environment', options: ranked.map((e, i) => ({ name: e.name, recommended: i === 0 })), problem: `no environment named "${clean(input.environment, 100)}"` };
    }
  } else if (!input.view?.listed) {
    if (existing) {
      environment = { name: existing.environment_name ?? '', id: existing.environment, kind: '' };
      add('check', `keeps ${existing.environment_name ? `"${existing.environment_name}"` : existing.environment}, not checked against your environments`, 'Run /kharos:setup again through the skill, which lists your environments.');
    } else add('missing', 'your environments were not listed', 'Run /kharos:setup through the skill: it lists your environments with /schedule.');
  } else if (envs.length === 0) {
    add('missing', 'Claude Code listed no environment for your account', `Run /kharos:setup again in a few minutes. If it still lists none: ${NEW_ENVIRONMENT(slug)}`);
  } else {
    const kept = existing ? envs.find((e) => e.id === existing.environment) : undefined;
    if (kept) environment = kept;
    else if (envs.length === 1) environment = envs[0] as Environment;
    const foreign = existing && !kept ? `profile ${name} points at ${existing.environment}, which is not one of this account's environments; ` : '';
    if (environment) add('ok', `${foreign}"${environment.name}"${kept ? ' (kept)' : ' (your only environment)'}`);
    else {
      const ranked = rankEnvironments(envs, slug, config);
      add('choose', `${foreign}${envs.length} environments: ${ranked.map((e) => `"${e.name}"`).join(', ')}`, 'Pick one by name.');
      envQuestion = { kind: 'ask-environment', options: ranked.map((e, i) => ({ name: e.name, recommended: i === 0 })) };
    }
  }

  // A repository that ships a setup script needs an environment that runs it, which only the person can say.
  let readyQuestion: Next | null = null;
  const script = environment && !(heads.readable && (heads.empty || !heads.hasRevision)) ? deps.setupScript(url, revision) : null;
  const confirmedSetup = findSetup(loadSetups(paths), account, slug, revision);
  if (environment && script?.status === 'found' && !input.confirmed) {
    const same = confirmedSetup?.environment === environment.id;
    const changed = same && confirmedSetup.script_sha256 !== scriptDigest(script.text);
    if (!same || changed) {
      const label = environment.name ? `"${environment.name}"` : environment.id;
      steps[3] = {
        title: TITLES[3],
        state: 'choose',
        detail: `${label}; ${slug} ships ${SETUP_SCRIPT_PATH}${changed ? ', which changed since you confirmed this environment' : ''}`,
        action: `Say whether ${label} runs it; if not, kharos env-guide prepares it to paste.`,
      };
      readyQuestion = { kind: 'ask-environment-ready', environment: environment.name || environment.id, script: SETUP_SCRIPT_PATH, changed };
    }
  }

  // 5. Commit identity: kharos cannot read the environment's variables, so it says how it works.
  const envLabel = environment?.name ? `"${environment.name}"` : 'the environment';
  add(
    'note',
    'pushes go through the GitHub credential of your Claude account; commits are authored as Claude <noreply@anthropic.com> unless the environment sets GIT_AUTHOR_* and GIT_COMMITTER_*',
    `on https://claude.ai/code open the environment selector, the settings of ${envLabel}, and add under Environment variables GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL (an email of your GitHub account, or its noreply address).`,
  );

  // 6. Permission prompts: every mode, asked once.
  const policy = deps.managedPolicy();
  const remote = heads.readable && !heads.empty && heads.hasRevision ? deps.settings(url, revision) : ({ status: 'unreadable', error: 'the branch could not be read' } as const);
  let standardInPlace = false;
  let hookInPlace = false;
  let current = 'not read';
  if (remote.status !== 'unreadable') {
    try {
      const settings = parseSettings(remote.status === 'found' ? remote.text : null);
      standardInPlace = identify(readRules(settings)) === 'standard';
      if (hasHookEntry(settings)) {
        const files = deps.hookFiles(url, revision);
        hookInPlace = files.status === 'found' && hookState(files.files).script === 'current';
      }
      current = `${identify(readRules(settings))} profile, ${hookInPlace ? 'with' : 'no'} kharos permission hook`;
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      current = err.message;
    }
  }
  const here = input.here?.toLowerCase() === slug.toLowerCase() ? '.' : null;
  const role = deps.repoRole(url);
  // The account's own mode, which decides whether a launch stops for approval: part of unblock all, with the rest of what it frees.
  const acct = readAccountMode(input.env);
  const acctAuto = !('error' in acct) && acct.mode === 'auto';
  const ua = preview(paths, input.env, 'on', policy);
  const options = permissionOptions(policy, { standardInPlace, hookInPlace, checkout: here, role, slug, unblockAll: ua.parts });
  const actx = { standardInPlace, hookInPlace, config, checkout: here, slug, unblockAllOn: ua.token === null };
  let choice: PermissionChoice | null = null;
  let permQuestion: Next | null = null;
  if (input.permissions !== undefined) {
    // `default` is what /kharos:permissions calls leaving the rules as they are.
    const wanted = input.permissions === 'default' ? 'as-is' : input.permissions;
    const picked = options.find((o) => o.id === wanted);
    if (!picked || !isPermissionChoice(picked.id)) throw new SetupError(`--permissions must be one of ${PERMISSION_CHOICES.join(', ')} (default is as-is)`);
    if (picked.unavailable && !/already in place/.test(picked.unavailable)) throw new SetupError(`${picked.title} is not available here: ${picked.unavailable}`);
    choice = picked.id;
  } else if (existing?.permissions) choice = existing.permissions;
  // Unblock all, picked now: its one confirmation is the token of what it frees, asked with the mode when it is missing.
  const unblockNow = input.permissions === 'unblock-all' && ua.token !== null;
  const confirmUnblock = unblockNow && !input.unblockExpect;
  const accountPart = ua.parts.find((p) => p.id === 'account');
  const willAuto = (unblockNow && !!input.unblockExpect && !accountPart?.unavailable) || (choice !== 'unblock-all' && input.accountMode === 'auto');
  const launches = acctAuto
    ? `this account starts its sessions in auto mode, so launches need no approval prompt, ${ACCOUNT_AUTO_CAVEAT}`
    : willAuto
      ? 'this account starts its sessions in auto mode once the confirmed change is written'
      : 'each launch asks for your approval (headless: claude -p --permission-mode auto)';
  if (choice && !confirmUnblock) {
    const todo = unblockNow ? null : permissionAction(choice, actx);
    add('ok', `${CHOICE_TEXT[choice]} (now on ${slug}@${revision}: ${current}); ${launches}`, todo ? `Then: ${todo}.` : undefined);
  } else {
    const ask = choice ? 'whether to free all of what unblock all lists below, with one confirmation' : 'the mode for this repository';
    add('choose', `now on ${slug}@${revision}: ${current}; ${options.filter((o) => o.unavailable === null).length} of ${options.length} modes available here`, `Pick ${ask}; it is asked once.`);
    const unblockAll = ua.token && (choice === 'unblock-all' || options.some((o) => o.id === 'unblock-all' && o.unavailable === null)) ? { text: ua.text, token: ua.token } : null;
    permQuestion = { kind: 'ask-permissions', options, offer: choice ? [] : offer(options, standardInPlace ? 'as-is' : 'standard'), unblockAll };
  }

  // The cap on open sessions, kharos's own: asked once per account, with the next question that is asked anyway.
  const maxOpen: MaxOpenQuestion | null =
    input.maxOpen === undefined && !maxOpenChosen(paths) ? { options: [...MAX_OPEN_CHOICES], open: activeCount(loadRegistry(paths)) } : null;

  // 7. The profile, written once everything above is settled.
  const blockedAt = steps.findIndex((s) => s.state === 'missing' || s.state === 'choose' || s.state === 'waiting');
  const result = (next: Next): SetupResult => ({ repo: slug, profile: name, steps, next, maxOpen });
  if (blockedAt < 0 && maxOpen) {
    add('choose', `${name}: written once you say how many cloud sessions may be open at once`, 'Pick watch.max_open, asked once for this account.');
    return result({ kind: 'ask-max-open' });
  }
  if (blockedAt >= 0) {
    add('waiting', `${name}: written once steps 1 to ${TITLES.length - 1} are settled`);
    const s = steps[blockedAt] as Step;
    if (s.state === 'choose' && blockedAt === 0 && moved.state === 'ask') return result({ kind: 'ask-adopt', profiles: moved.unknown });
    if (s.state === 'choose') return result((blockedAt === 3 ? (envQuestion ?? readyQuestion) : permQuestion) as Next);
    if (blockedAt === 3 && input.environment === 'new') return result({ kind: 'env-assist', action: s.action as string });
    if (blockedAt === 2 && initialCommit) return result({ kind: 'ask-initial-commit' });
    return result({ kind: 'person', step: blockedAt + 1, action: s.action ?? s.detail });
  }
  const env = environment as Environment;
  // Unblock all sets the account's mode itself, so an --account-mode answer does not apply with it.
  const acctChange = input.accountMode === 'auto' && !acctAuto && choice !== 'unblock-all' ? approveAccountMode(paths, input.env, 'auto', input.accountExpect, policy) : null;
  if (unblockNow) {
    try {
      approveUnblockAll(paths, input.env, 'on', input.unblockExpect, policy);
    } catch (err) {
      if (err instanceof CommandError) throw new SetupError(err.message);
      throw err;
    }
  }
  const written = writeProfile(paths, {
    name,
    repo: url,
    environment: env.id,
    revision,
    ...(env.name ? { environment_name: env.name } : {}),
    ...(choice ? { permissions: choice } : {}),
    ...(account ? { account } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.deadline_min !== undefined ? { deadline_min: input.deadline_min } : {}),
    ...(input.allowed_tools !== undefined ? { allowed_tools: input.allowed_tools } : {}),
    ...(input.connectors !== undefined ? { connectors: input.connectors } : {}),
    makeDefault: input.makeDefault,
  });
  if (input.confirmed && account) {
    recordSetup(paths, {
      account,
      repo: slug,
      revision,
      environment: env.id,
      confirmed_at: new Date(input.now).toISOString(),
      script_sha256: script?.status === 'found' ? scriptDigest(script.text) : null,
    });
  }
  if (acctChange) applyAccountMode(paths, input.env, acctChange);
  let unblockFailed: string | null = null;
  if (unblockNow) {
    try {
      applyUnblockAll(paths, input.env, 'on', input.unblockExpect, input.now, policy);
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      unblockFailed = err.message;
    }
  }
  if (input.accountMode !== undefined || input.maxOpen !== undefined) {
    const cfg = loadConfig(paths).config;
    saveConfig(paths, {
      ...cfg,
      ...(input.accountMode !== undefined ? { account_mode: input.accountMode } : {}),
      ...(input.maxOpen !== undefined ? { watch: { ...cfg.watch, max_open: input.maxOpen } } : {}),
    });
  }
  const isDefault = /\(default\)/.test(written.split('\n')[0] ?? '');
  add('ok', written.split('\n')[0] as string);

  // The doctor's own checks still run, every one of them; only what the person can act on is shown.
  const checks = runDoctor(paths, { profile: name, noRemoteTool: input.noRemoteTool, now: input.now, env: input.env }, deps);
  if (unblockFailed) return result({ kind: 'not-ready', summary: [`Not ready: unblock all stopped part way (profile ${name} is written):`, ...unblockFailed.split('\n')] });
  const fails = checks.filter((c) => c.level === 'fail');
  const warns = checks.filter((c) => c.level === 'warn');
  const where = `${slug}@${revision}`;
  if (fails.length) {
    const f = fails[0] as Check;
    return result({ kind: 'not-ready', summary: [`Not ready: ${f.name}: ${f.detail}`, `Next: ${f.fix?.[0] ?? 'run /kharos:doctor for the fix'}`] });
  }
  const confirmed = github?.state === 'connected' || loadRepos(paths)[slug]?.access === 'ok';
  const todo = choice ? permissionAction(choice, actx) : null;
  // A permissions warning that the next action fixes is that action, not a second thing to look at.
  const open = warns.filter((c) => !(todo && c.name === `${name}: permissions`));
  const summary = [
    `Ready: profile ${name}${isDefault ? ' (default)' : ''} launches on ${where} in ${env.name ? `"${env.name}"` : env.id}.`,
    confirmed ? `GitHub: Claude reaches ${slug}.` : `GitHub: not confirmed for ${slug} yet; the first launch checks it before any session starts, at no cost.`,
    `Commits: authored as Claude <noreply@anthropic.com> unless ${envLabel} sets GIT_AUTHOR_* and GIT_COMMITTER_* (on claude.ai/code: the environment's settings, Environment variables).`,
    `Permissions: ${choice ? CHOICE_TEXT[choice] : 'not chosen'}${choice === 'unblock-all' ? ` (now ${describeUnblockAll(readUnblockAll(paths, input.env, policy).parts).text})` : ''}; ${accountAutoNow(input.env) ? `this account starts its sessions in auto mode, so launches need no approval prompt, ${ACCOUNT_AUTO_CAVEAT}` : launches}.`,
    ...(input.confirmed && script?.status === 'unreadable'
      ? [`Setup script: ${SETUP_SCRIPT_PATH} could not be read (${clean(script.error, 120)}), so /kharos:doctor will ask you to paste it again, and to confirm once it can read it.`]
      : open.length
        ? [`Check: ${open.length} warning(s) in /kharos:doctor; the first: ${(open[0] as Check).name}: ${clean((open[0] as Check).detail, 160)}`]
        : []),
    `Next: ${todo ?? '/kharos:run "<instruction>"'}`,
  ];
  return result({ kind: 'ready', summary });
}

function accountAutoNow(env: NodeJS.ProcessEnv): boolean {
  const a = readAccountMode(env);
  return !('error' in a) && a.mode === 'auto';
}

export class SetupError extends Error {}

function maxOpenQuestion(q: MaxOpenQuestion, also: boolean): string {
  const [rec, ...rest] = q.options;
  return (
    `${also ? 'Ask too: open sessions: h' : 'H'}ow many cloud sessions may be open at once on this account (watch.max_open, asked once)? ` +
    `Offer ${rec} (recommended)${rest.length ? `, ${rest.join(', ')}` : ''}; any positive number can be named. ` +
    `Trade-off: ${MAX_OPEN_TRADEOFF}. Open now: ${q.open}; the default is ${DEFAULT_WATCH.max_open}.`
  );
}

const LABEL: Record<StepState, string> = { ok: 'ok', missing: 'missing', choose: 'choose', check: 'check', note: 'note', waiting: 'waiting' };

/** The report: the whole list up front while something is left, the short summary once it is ready. */
export function formatSetup(r: SetupResult): string {
  if (r.next.kind === 'ready' || r.next.kind === 'not-ready') return [...r.next.summary, `next: ${r.next.kind}`].join('\n');
  const lines = [`kharos setup for ${r.repo} (profile ${r.profile}):`];
  r.steps.forEach((s, i) => {
    lines.push(`${String(i + 1)}. ${LABEL[s.state].padEnd(7)} ${s.title}: ${s.detail}`);
    if (s.action && s.state !== 'ok') lines.push(`           ${s.state === 'note' ? 'to author commits as you' : 'do'}: ${s.action}`);
    else if (s.action) lines.push(`           ${s.action}`);
  });
  const n = r.next;
  if (n.kind === 'ask-environment-ready') {
    lines.push('', `Does "${n.environment}" run ${n.script}${n.changed ? ' as it is now' : ''}? Yes records it; no runs kharos env-guide to paste it.`);
  } else if (n.kind === 'env-assist') {
    lines.push('', n.action);
  } else if (n.kind === 'ask-adopt') {
    lines.push('', 'Profiles of unknown account in the shared files:', ...n.profiles.map((p) => `  ${p}`));
  } else if (n.kind === 'ask-environment') {
    lines.push('', `Environments, best fit first${n.problem ? ` (${n.problem})` : ''}:`, ...n.options.map((o) => `  "${o.name}"${o.recommended ? ' (recommended)' : ''}`));
  } else if (n.kind === 'ask-permissions') {
    lines.push('', 'Permission modes (each with what it does and its trade-off):');
    for (const o of n.options) {
      lines.push(`  ${o.id}: ${o.title}${o.unavailable ? ` [not available: ${o.unavailable}]` : ''}`);
      lines.push(`      does: ${o.does}`, `      trade-off: ${o.tradeoff}`);
      if (o.note && !o.unavailable) lines.push(`      note: ${o.note}`);
    }
    lines.push(`Launch approval: ${LAUNCH_APPROVAL}.`);
    if (n.offer.length) lines.push(`To offer in the question, recommended first: ${n.offer.join(', ')}; any other available mode above can be named.`);
    if (n.unblockAll) {
      lines.push(
        '',
        `Unblock all, everything it frees, for the one confirmation (token ${n.unblockAll.token}); picking it confirms all of this, so it is the preview of that option${n.offer.length ? '' : ', and the question itself'}:`,
        n.unblockAll.text,
      );
    }
  }
  // Asked in the same AskUserQuestion call as the question of this step, or alone once it is the last one.
  if (r.maxOpen && n.kind.startsWith('ask-')) lines.push('', maxOpenQuestion(r.maxOpen, n.kind !== 'ask-max-open'));
  lines.push(`next: ${n.kind === 'person' ? `person (step ${n.step})` : n.kind}`);
  return lines.join('\n');
}

// The kharos permission hook on a branch: three files, which automatic preflight writes to the side branch
// of a launch, never to the branch the launch starts from.
//   .claude/settings.json            a PermissionRequest entry that runs the script in cloud sessions
//   .claude/hooks/kharos-permission.mjs  the script, copied from cloud/kharos-permission.mjs of the plugin
//   .claude/kharos-permissions.json  the rules: narrow allow patterns and prefix rules the preflight suggests;
//                                    with the unblock preset, the organization's Bash ask rules mirrored and
//                                    every other prompt allowed. Without it, every other prompt is denied
// A repository allow rule cannot outrank an ask rule, least of all a managed one, and a cloud session
// has no bypass mode; a PermissionRequest hook answers the prompt on the person's behalf instead.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { bashRuleMatches, broadPatternWhy, broadRuleWhy, parsePattern, prefixOf, prefixRuleWhy, readHookRules, type HookRules } from '../cloud/kharos-permission.mjs';
import { mirrorRefusal, planMirror, staleMirror, type ManagedPolicy, type MirrorPlan } from './managed-policy.ts';
import { parseSettings, readRules, renderSettings, SETTINGS_PATH, SettingsError } from './settings.ts';

export const HOOK_SCRIPT_PATH = '.claude/hooks/kharos-permission.mjs';
export const HOOK_RULES_PATH = '.claude/kharos-permissions.json';
/** On a person's machine the entry exits at once, so only cloud sessions start Node.js for it. */
export const HOOK_COMMAND = `[ "$CLAUDE_CODE_REMOTE" != true ] || node "$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT_PATH}"`;
const HOOK_TIMEOUT_S = 10;

export class HookError extends Error {}

export function shippedScript(): string {
  return fs.readFileSync(new URL('../cloud/kharos-permission.mjs', import.meta.url), 'utf8');
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isKharosHook(h: unknown): boolean {
  const o = rec(h);
  return typeof o?.command === 'string' && o.command.includes('kharos-permission.mjs');
}

/** The PermissionRequest entries of a settings object, checked, so kharos never rewrites a shape it does not know. */
function permissionEntries(settings: Record<string, unknown>): Record<string, unknown>[] {
  if (settings.hooks === undefined) return [];
  const hooks = rec(settings.hooks);
  if (!hooks) throw new SettingsError('"hooks" must be an object');
  const list = hooks.PermissionRequest;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((e) => !rec(e))) throw new SettingsError('"hooks.PermissionRequest" must be a list of objects');
  return list as Record<string, unknown>[];
}

export function hasHookEntry(settings: Record<string, unknown>): boolean {
  return permissionEntries(settings).some((e) => Array.isArray(e.hooks) && e.hooks.some(isKharosHook));
}

function withHookEntry(settings: Record<string, unknown>): Record<string, unknown> {
  if (hasHookEntry(settings)) return settings;
  const entry = { matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_S }] };
  const hooks = { ...(rec(settings.hooks) ?? {}) };
  hooks.PermissionRequest = [...permissionEntries(settings), entry];
  return { ...settings, hooks };
}


/** The three files as they are in a checkout or on a branch; null is a missing file. */
export interface HookFiles {
  settings: string | null;
  script: string | null;
  rules: string | null;
}

export interface HookState {
  installed: boolean;
  script: 'current' | 'outdated' | 'missing';
  rules: HookRules | { error: string } | null;
}

export function parseRulesText(text: string): HookRules | { error: string } {
  try {
    return readHookRules(JSON.parse(text));
  } catch (err) {
    return { error: err instanceof SyntaxError ? `invalid JSON (${err.message})` : (err as Error).message };
  }
}

export function hookState(files: HookFiles): HookState {
  return {
    installed: hasHookEntry(parseSettings(files.settings)),
    script: files.script === null ? 'missing' : files.script === shippedScript() ? 'current' : 'outdated',
    rules: files.rules === null ? null : parseRulesText(files.rules),
  };
}

/**
 * The rules the hook answers with on a branch, or null when the hook would not answer there: the
 * settings entry or the script is missing, or the rules file cannot be used.
 */
export function hookSnapshot(files: HookFiles): HookRules | null {
  try {
    const st = hookState(files);
    if (!st.installed || st.script === 'missing' || st.rules === null || 'error' in st.rules) return null;
    return st.rules;
  } catch (err) {
    if (err instanceof SettingsError) return null;
    throw err;
  }
}

/** A pattern that allows any command it covers: its program is a wildcard, or runs other commands. */
export function isBroadPattern(pattern: string): boolean {
  const p = parsePattern(pattern, true);
  return p.ok && broadPatternWhy(p.words) !== null;
}

/** The broad rules of a rules file: allow patterns, mirrored organization rules and prefix rules. */
export function broadRules(r: HookRules): string[] {
  return [...r.allow.filter(isBroadPattern), ...r.mirror.filter((m) => broadRuleWhy(m) !== null), ...(r.prefix ?? []).filter((m) => broadRuleWhy(m) !== null)];
}

export const BROAD_RISK = "allow any command they cover in this repository's cloud sessions, with no person asked";

export const UNBLOCK_RISK = "every permission prompt in this repository's cloud sessions is allowed, of any tool, with no person asked";

const REMOTE_DATABASES: [RegExp, string][] = [
  [/rds\.amazonaws\.com/i, 'Amazon RDS'],
  [/cache\.amazonaws\.com/i, 'Amazon ElastiCache'],
  [/docdb\.amazonaws\.com/i, 'Amazon DocumentDB'],
  [/mongodb\.net|mongodb\+srv/i, 'MongoDB Atlas'],
];

/** What the unblock preset opens under this policy, as the person confirms it; empty when kharos refuses it. */
export function unblockOpens(policy: ManagedPolicy): string[] {
  if (policy.status !== 'found') return [];
  const remote = policy.ask.flatMap((r) => REMOTE_DATABASES.filter(([re]) => re.test(r)).map(([, name]) => `${r} (${name})`));
  return [
    `${UNBLOCK_RISK}: Bash commands of any form (chained, piped, with variables, for any program, shells and interpreters too), web fetches, connector tools and every other tool that asks`,
    `the organization's ask rules it answers (${policy.ask.length}), as mirrored rules and through the preset: ${policy.ask.length ? policy.ask.join(', ') : 'none'}`,
    `remote databases: a session may connect with no person asked to any database the cloud machine can reach, such as Amazon RDS, ElastiCache, DocumentDB, or MongoDB Atlas through a connection string${remote.length ? `; the organization asks before these hosts today: ${remote.join(', ')}` : ''}`,
    `what stays: the organization's deny rules (${policy.deny.length}), which Claude Code enforces before any prompt, and every prompt on a person's machine, where the hook says nothing`,
  ];
}

/** What automatic preflight adds to a launch branch's hook: narrow allow patterns, prefix rules, and the unblock preset. */
export interface HookChange {
  allow: string[];
  /** Prefix rules, `Bash(<program> <subcommands>:*)`, which allow any arguments. */
  prefix: string[];
  /** Turn the unblock preset on: it mirrors every organization Bash ask rule, broad ones included, and allows every other prompt. */
  unblock: boolean;
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface HookPlan {
  changes: FileChange[];
  /** A short id of the change; null when the files hold it already. */
  token: string | null;
  /** Set when the change mirrors the organization's ask rules, which the unblock preset does. */
  mirror: MirrorPlan | null;
}

function renderRules(r: HookRules): string {
  return JSON.stringify({ version: 1, ...(r.broad ? { broad: true } : {}), ...(r.unblock ? { unblock: true } : {}), allow: r.allow, ...(r.prefix?.length ? { prefix: r.prefix } : {}), mirror: r.mirror }, null, 2) + '\n';
}

/** A deny rule that would cover calls an allow pattern names: the hook could never approve them. */
function deniedBy(pattern: string, deny: readonly string[]): string | null {
  const p = parsePattern(pattern, true);
  if (!p.ok) return null;
  const sample = p.words.map((w) => (w === null ? 'x' : w)).join(' ');
  return deny.find((d) => bashRuleMatches(d, sample)) ?? null;
}

/**
 * Why kharos refuses an allow pattern, or null when it accepts it: the pattern is not valid, it is broad
 * and the change does not accept broad rules, or a deny rule of the organization or the repository covers it.
 */
export function allowRefusal(pattern: string, broad: boolean, policy: ManagedPolicy, repoDeny: readonly string[]): string | null {
  const r = parsePattern(pattern, broad);
  if (!r.ok) {
    const loose = parsePattern(pattern, true);
    const why = loose.ok ? broadPatternWhy(loose.words) : null;
    return why ? `allow pattern "${pattern}" is refused: it is broad (${why}), so it would allow any command` : `allow pattern "${pattern}" is refused: ${r.why}`;
  }
  const deny = deniedBy(pattern, [...(policy.status === 'found' ? policy.deny : []), ...repoDeny]);
  return deny ? `allow pattern "${pattern}" is refused: the deny rule ${deny} covers it, and a hook cannot approve what a deny rule refuses` : null;
}

/**
 * Why kharos refuses a prefix rule, or null when it accepts it: the rule is not valid, it is broad and
 * the change does not accept broad rules, or a deny rule of the organization or the repository covers it.
 */
export function prefixRefusal(rule: string, broad: boolean, policy: ManagedPolicy, repoDeny: readonly string[]): string | null {
  const why = prefixRuleWhy(rule, broad);
  if (why) return `prefix rule "${rule}" is refused: ${why}${why.startsWith('it is broad') ? ', so it would allow any command' : ''}`;
  const head = prefixOf(rule);
  const deny = [...(policy.status === 'found' ? policy.deny : []), ...repoDeny].find((d) => bashRuleMatches(d, head) || bashRuleMatches(d, `${head} x`));
  return deny ? `prefix rule "${rule}" is refused: the deny rule ${deny} covers it, and a hook cannot approve what a deny rule refuses` : null;
}

/**
 * The change to the three files of a branch. Throws HookError for a change kharos refuses: an allow pattern
 * or prefix rule that is broad (unless the unblock preset allows everything anyway) or that a deny rule
 * covers, the unblock preset where the organization rules it out, or a hook the organization's settings
 * now bind (bypass mode disabled after rules were mirrored or the preset was put in).
 */
export function planHook(files: HookFiles, change: HookChange, policy: ManagedPolicy): HookPlan {
  const settings = parseSettings(files.settings);
  const repoDeny = readRules(settings).deny;
  const current = files.rules === null ? null : parseRulesText(files.rules);
  if (current && 'error' in current) throw new HookError(`${HOOK_RULES_PATH}: ${current.error}; fix it on the branch, or remove the hook from it`);
  const base: HookRules = current ?? { allow: [], mirror: [] };
  const basePrefix = base.prefix ?? [];
  if (change.unblock) {
    const refusal = mirrorRefusal(policy);
    if (refusal) throw new HookError(`the unblock preset: ${refusal}`);
  }
  if (base.unblock && policy.status === 'found' && policy.bypassDisabled) {
    throw new HookError("refused: the hook here has the unblock preset, but the organization's managed settings now set disableBypassPermissionsMode, so its ask rules bind every session; take the preset out of the branch's .claude/kharos-permissions.json, or remove the hook from the branch");
  }
  const stale = staleMirror(policy, base.mirror);
  if (stale) throw new HookError(`refused: ${stale}`);
  for (const p of change.allow) {
    const refusal = allowRefusal(p, change.unblock, policy, repoDeny);
    if (refusal) throw new HookError(refusal);
  }
  for (const p of change.prefix) {
    const refusal = prefixRefusal(p, change.unblock, policy, repoDeny);
    if (refusal) throw new HookError(refusal);
  }
  const mirror = change.unblock ? planMirror(policy.status === 'found' ? policy.ask : [], true) : null;
  const prefix = [...basePrefix, ...change.prefix.filter((p, i, a) => a.indexOf(p) === i && !basePrefix.includes(p))];
  const kept: HookRules = {
    allow: [...base.allow, ...change.allow.filter((p, i, a) => a.indexOf(p) === i && !base.allow.includes(p))],
    mirror: mirror ? mirror.converted : base.mirror,
    ...(prefix.length ? { prefix } : {}),
  };
  const withBroad: HookRules = broadRules(kept).length ? { ...kept, broad: true } : kept;
  const rules: HookRules = change.unblock || base.unblock === true ? { ...withBroad, unblock: true } : withBroad;
  const next = { settings: withHookEntry(settings), script: shippedScript(), rules: renderRules(rules) };

  const settingsAfter = JSON.stringify(next.settings) === JSON.stringify(settings) ? files.settings : renderSettings(next.settings, files.settings);
  const changes = [
    { path: SETTINGS_PATH, before: files.settings, after: settingsAfter },
    { path: HOOK_SCRIPT_PATH, before: files.script, after: next.script },
    { path: HOOK_RULES_PATH, before: files.rules, after: next.rules },
  ].filter((c) => c.before !== c.after);
  const token = changes.length ? sha(JSON.stringify(changes.map((c) => [c.path, c.before, c.after]))) : null;
  return { changes, token, mirror };
}


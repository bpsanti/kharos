// The kharos permission hook in a repository: three files, changed only as one approved diff.
//   .claude/settings.json            a PermissionRequest entry that runs the script in cloud sessions
//   .claude/hooks/kharos-permission.mjs  the script, copied from cloud/kharos-permission.mjs of the plugin
//   .claude/kharos-permissions.json  the rules: the person's own allow patterns and the organization ask
//                                    rules the person chose to mirror; every other prompt is denied. Broad
//                                    rules, which allow any command they cover, only with --broad
// A repository allow rule cannot outrank an ask rule, least of all a managed one, and a cloud session
// has no bypass mode; a PermissionRequest hook answers the prompt on the person's behalf instead.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { bashRuleMatches, broadPatternWhy, broadRuleWhy, HOOK_VERSION, parsePattern, readHookRules, type HookRules } from '../cloud/kharos-permission.mjs';
import { mirrorRefusal, planMirror, staleMirror, type ManagedPolicy, type MirrorPlan } from './managed-policy.ts';
import { parseSettings, readRules, renderSettings, SETTINGS_PATH, SettingsError, unifiedDiff } from './permission-profiles.ts';

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

function withoutHookEntry(settings: Record<string, unknown>): Record<string, unknown> {
  if (!hasHookEntry(settings)) return settings;
  const entries = permissionEntries(settings)
    .map((e) => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !isKharosHook(h)) } : e))
    .filter((e) => !Array.isArray(e.hooks) || e.hooks.length > 0);
  const hooks = { ...(rec(settings.hooks) ?? {}) };
  if (entries.length) hooks.PermissionRequest = entries;
  else delete hooks.PermissionRequest;
  const next: Record<string, unknown> = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
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

/** The broad rules of a rules file: allow patterns and mirrored organization rules. */
export function broadRules(r: HookRules): string[] {
  return [...r.allow.filter(isBroadPattern), ...r.mirror.filter((m) => broadRuleWhy(m) !== null)];
}

const mark = (rule: string, broad: boolean) => (broad ? `${rule} (broad)` : rule);

function listRules(r: HookRules): string[] {
  return [
    `allow patterns (${r.allow.length}): ${r.allow.length ? r.allow.map((p) => mark(p, isBroadPattern(p))).join(' | ') : 'none'}`,
    `mirrored organization ask rules (${r.mirror.length}): ${r.mirror.length ? r.mirror.map((m) => mark(m, broadRuleWhy(m) !== null)).join(', ') : 'none'}`,
  ];
}

export const BROAD_RISK = "allow any command they cover in this repository's cloud sessions, with no person asked";

export function describeHook(st: HookState): string[] {
  const out = [`kharos permission hook: ${st.installed ? 'in .claude/settings.json' : 'not in .claude/settings.json'}; script ${st.script === 'missing' ? 'missing' : st.script === 'current' ? `current (version ${HOOK_VERSION})` : 'not the one this kharos ships'}`];
  if (st.rules === null) out.push(`  rules: no ${HOOK_RULES_PATH}`);
  else if ('error' in st.rules) out.push(`  rules: ${st.rules.error}`);
  else {
    out.push(...listRules(st.rules).map((l) => `  ${l}`));
    const broad = broadRules(st.rules);
    if (broad.length) out.push(`  broad rules (${broad.length}) ${BROAD_RISK}: ${broad.join(', ')}`);
    out.push('  any other prompt in a cloud session: denied, with a message that names the allowed forms');
  }
  return out;
}

export interface HookChange {
  allow: string[];
  drop: string[];
  mirror: boolean;
  unmirror: boolean;
  uninstall: boolean;
  /** Accept broad rules: allow patterns and mirrored organization rules that allow any command they cover. */
  broad: boolean;
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface HookPlan {
  changes: FileChange[];
  token: string | null;
  lines: string[];
  /** Set when the change mirrors the organization's ask rules: the write then needs --org-confirmed. */
  mirror: MirrorPlan | null;
}

function renderRules(r: HookRules): string {
  return JSON.stringify({ version: 1, ...(r.broad ? { broad: true } : {}), allow: r.allow, mirror: r.mirror }, null, 2) + '\n';
}

/** A deny rule that would cover calls an allow pattern names: the hook could never approve them. */
function deniedBy(pattern: string, deny: readonly string[]): string | null {
  const p = parsePattern(pattern, true);
  if (!p.ok) return null;
  const sample = p.words.map((w) => (w === null ? 'x' : w)).join(' ');
  return deny.find((d) => bashRuleMatches(d, sample)) ?? null;
}

/**
 * The change to the three files. Throws HookError for a request kharos refuses, with the reason the
 * person reads.
 */
export function planHook(files: HookFiles, change: HookChange, policy: ManagedPolicy): HookPlan {
  const settings = parseSettings(files.settings);
  const repoDeny = readRules(settings).deny;
  const lines: string[] = [];
  let next: { settings: Record<string, unknown>; script: string | null; rules: string | null };
  let mirror: MirrorPlan | null = null;

  if (change.uninstall) {
    if (change.allow.length || change.drop.length || change.mirror || change.unmirror || change.broad) throw new HookError('--uninstall takes no other change');
    next = { settings: withoutHookEntry(settings), script: null, rules: null };
    lines.push('removes the kharos permission hook: its settings entry, the script and the rules file; every other key of the settings stays');
  } else {
    if (change.mirror && change.unmirror) throw new HookError('--mirror and --unmirror cannot go together');
    const current = files.rules === null ? null : parseRulesText(files.rules);
    if (current && 'error' in current) throw new HookError(`${HOOK_RULES_PATH}: ${current.error}; fix it by hand, or remove the hook with --uninstall`);
    const base: HookRules = current ?? { allow: [], mirror: [] };
    const stale = change.unmirror ? null : staleMirror(policy, base.mirror);
    if (stale) throw new HookError(`refused: ${stale}`);
    for (const p of change.allow) {
      const r = parsePattern(p, change.broad);
      if (!r.ok) {
        const loose = parsePattern(p, true);
        const why = loose.ok ? broadPatternWhy(loose.words) : null;
        throw new HookError(
          why ? `allow pattern "${p}" is refused: it is broad (${why}), so it would allow any command; add --broad to allow it anyway` : `allow pattern "${p}" is refused: ${r.why}`,
        );
      }
      const deny = deniedBy(p, [...(policy.status === 'found' ? policy.deny : []), ...repoDeny]);
      if (deny) throw new HookError(`allow pattern "${p}" is refused: the deny rule ${deny} covers it, and a hook cannot approve what a deny rule refuses`);
    }
    for (const p of change.drop) if (!base.allow.includes(p)) throw new HookError(`"${p}" is not an allow pattern of ${HOOK_RULES_PATH}`);
    let mirrored = base.mirror;
    if (change.mirror) {
      const refusal = mirrorRefusal(policy);
      if (refusal) throw new HookError(refusal);
      mirror = planMirror(policy.status === 'found' ? policy.ask : [], change.broad);
      mirrored = mirror.converted;
    } else if (change.unmirror) mirrored = [];
    const kept: HookRules = {
      allow: [...base.allow.filter((p) => !change.drop.includes(p)), ...change.allow.filter((p, i, a) => a.indexOf(p) === i && !base.allow.includes(p))],
      mirror: mirrored,
    };
    const broad = broadRules(kept);
    const rules: HookRules = broad.length ? { ...kept, broad: true } : kept;
    const added = broad.filter((r) => !broadRules(base).includes(r));
    next = { settings: withHookEntry(settings), script: shippedScript(), rules: renderRules(rules) };
    lines.push(`${hasHookEntry(settings) ? 'updates' : 'installs'} the kharos permission hook; it decides only in cloud sessions (CLAUDE_CODE_REMOTE=true), and says nothing on a person's machine`);
    lines.push(listRules(rules)[0] as string);
    lines.push('any other prompt in a cloud session: denied, with a message that names the allowed forms');
    if (added.length) lines.push(`WARNING: this change adds ${added.length} broad rule(s), which ${BROAD_RISK}: ${added.join(', ')}`);
    else if (broad.length) lines.push(`broad rules (${broad.length}), unchanged: ${broad.join(', ')}`);
    if (mirror) {
      lines.push(
        `WARNING: check with your organization's administrator before approving this. The organization's managed settings ask a person before these commands; in cloud sessions on this repository the hook will allow them, as single simple commands, with no person asked.`,
        `organization ask rules this turns into a cloud-only allow (${mirror.converted.length}): ${mirror.converted.length ? mirror.converted.map((r) => mark(r, mirror?.broad.includes(r) === true)).join(', ') : 'none'}`,
      );
      for (const k of mirror.kept) lines.push(`  stays a prompt: ${k.rule} (${k.why})${k.broad ? ', unless mirrored with --broad' : ''}`);
      lines.push(`organization deny rules are never touched (${policy.status === 'found' ? policy.deny.length : 0} stay as they are)`);
    } else if (rules.mirror.length) lines.push(`mirrored organization ask rules (${rules.mirror.length}), unchanged: ${rules.mirror.map((m) => mark(m, broadRuleWhy(m) !== null)).join(', ')}`);
  }

  const settingsAfter = JSON.stringify(next.settings) === JSON.stringify(settings) ? files.settings : renderSettings(next.settings, files.settings);
  const changes = [
    { path: SETTINGS_PATH, before: files.settings, after: settingsAfter },
    { path: HOOK_SCRIPT_PATH, before: files.script, after: next.script },
    { path: HOOK_RULES_PATH, before: files.rules, after: next.rules },
  ].filter((c) => c.before !== c.after);
  const token = changes.length ? sha(JSON.stringify(changes.map((c) => [c.path, c.before, c.after]))) : null;
  return { changes, token, lines, mirror };
}

/** The diff of a plan as a person reads it. The script is the plugin's own file, so it shows as its hash. */
export function renderPlan(plan: HookPlan): string {
  const out: string[] = [];
  for (const c of plan.changes) {
    if (c.path === HOOK_SCRIPT_PATH && c.after !== null) {
      out.push(`${c.before === null ? 'adds' : 'replaces'} ${c.path}: the script cloud/kharos-permission.mjs of this kharos, version ${HOOK_VERSION}, ${c.after.split('\n').length} lines, sha256 ${sha(c.after)}`);
    } else if (c.after === null) {
      out.push(`deletes ${c.path}`);
    } else out.push(unifiedDiff(c.before, c.after, c.path));
  }
  return out.join('\n');
}

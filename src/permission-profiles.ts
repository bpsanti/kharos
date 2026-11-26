// Permission profiles for the repository a cloud session starts in. A session on one repository reads
// that repository's .claude/settings.json; the user's own settings and .claude/settings.local.json stay
// on the person's machine. A session that a routine starts begins in auto mode when it is available:
// broad allow rules are dropped, narrow ones resolve before the classifier, ask rules always prompt, and
// the classifier decides the rest, with a prompt after it blocks 3 actions in a row or 20 in the session.
// A prompt waits for a person. The standard profile adds narrow allow rules, which auto mode keeps, so
// fewer actions reach the classifier or a prompt. It never touches ask or deny rules.

import crypto from 'node:crypto';

export const PERMISSION_PROFILES = ['default', 'standard'] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export const SETTINGS_PATH = '.claude/settings.json';

export function isPermissionProfile(v: string): v is PermissionProfile {
  return (PERMISSION_PROFILES as readonly string[]).includes(v);
}

export const PROFILE_SUMMARY: Record<PermissionProfile, string> = {
  default: 'changes nothing',
  standard: 'allows file tools, read-only shell and git commands, and the build, test and dev commands of the repository, as narrow rules that auto mode keeps; keeps ask and deny rules',
};

export class SettingsError extends Error {}

export interface Rules {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode: string | null;
  /** The file has autoMode settings, which a project's settings cannot set. */
  autoMode: boolean;
}

/** What the repository holds, so the standard profile allows its own build and test commands. */
export interface RepoFacts {
  files: string[];
  /** Script names of package.json. */
  scripts: string[];
  /** Target names of the Makefile. */
  makeTargets: string[];
}

export const STANDARD_BASE: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(ls *)',
  'Bash(pwd)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(diff *)',
  'Bash(which *)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git branch *)',
  'Bash(git rev-parse *)',
  'Bash(git fetch *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git switch -c *)',
  'Bash(git checkout -b *)',
];

/** Script and target names that build, test, check or run the project for development, and name no deploy, release, publish, upload or push step. */
const BUILD_TEST_RE = /^(?!.*(?:deploy|release|publish|upload|push))(?:build|test|tests|check|lint|typecheck|type-check|types|format|fmt|compile|verify|dev|start|serve)(?:[:._-][\w:.-]*)?$/i;
const SAFE_NAME_RE = /^[\w:.-]+$/;

function packageManager(files: readonly string[]): string {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun';
  return 'npm';
}

/**
 * The build, test and dev rules for what the repository holds at its root. Auto mode drops
 * package-manager run rules with a wildcard, so package scripts get exact rules.
 */
export function buildRules(facts: RepoFacts): string[] {
  const has = (f: string) => facts.files.includes(f);
  const out: string[] = [];
  if (has('package.json')) {
    const pm = packageManager(facts.files);
    out.push(pm === 'npm' ? 'Bash(npm ci)' : `Bash(${pm} install --frozen-lockfile)`, `Bash(${pm} install)`, `Bash(${pm} test)`);
    for (const s of facts.scripts) if (BUILD_TEST_RE.test(s) && SAFE_NAME_RE.test(s)) out.push(`Bash(${pm} run ${s})`);
  }
  if (has('Cargo.toml')) out.push('Bash(cargo build *)', 'Bash(cargo test *)', 'Bash(cargo check *)', 'Bash(cargo clippy *)', 'Bash(cargo fmt *)');
  if (has('go.mod')) out.push('Bash(go build *)', 'Bash(go test *)', 'Bash(go vet *)');
  if (['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pytest.ini', 'tox.ini'].some(has)) out.push('Bash(pytest *)');
  if (has('Makefile') || has('makefile') || has('GNUmakefile')) {
    for (const t of facts.makeTargets) if (BUILD_TEST_RE.test(t) && SAFE_NAME_RE.test(t)) out.push(`Bash(make ${t})`);
  }
  if (has('gradlew')) out.push('Bash(./gradlew build)', 'Bash(./gradlew test)', 'Bash(./gradlew check)');
  if (has('pom.xml')) out.push('Bash(mvn compile)', 'Bash(mvn test)', 'Bash(mvn verify)', 'Bash(mvn package)');
  return [...new Set(out)];
}

export function readFacts(files: string[], packageJson: string | null, makefile: string | null): RepoFacts {
  let scripts: string[] = [];
  if (packageJson !== null) {
    try {
      const pkg = JSON.parse(packageJson) as { scripts?: unknown };
      if (typeof pkg.scripts === 'object' && pkg.scripts !== null && !Array.isArray(pkg.scripts)) scripts = Object.keys(pkg.scripts);
    } catch {
      // an unreadable package.json gives no scripts
    }
  }
  const makeTargets = makefile === null ? [] : [...makefile.matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1] as string);
  return { files, scripts, makeTargets: [...new Set(makeTargets)] };
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new SettingsError(`${where} must be a list of strings`);
  return v as string[];
}

/** The settings object of a file, or an empty one when there is no file. */
export function parseSettings(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`${SETTINGS_PATH} is not valid JSON (${(err as Error).message}); kharos does not edit it`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SettingsError(`${SETTINGS_PATH} must hold a JSON object`);
  return v as Record<string, unknown>;
}

export function readRules(settings: Record<string, unknown>): Rules {
  const p = settings.permissions;
  const autoMode = settings.autoMode !== undefined;
  if (p === undefined) return { allow: [], ask: [], deny: [], defaultMode: null, autoMode };
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new SettingsError('"permissions" must be an object');
  const o = p as Record<string, unknown>;
  return {
    allow: strings(o.allow, 'permissions.allow'),
    ask: strings(o.ask, 'permissions.ask'),
    deny: strings(o.deny, 'permissions.deny'),
    defaultMode: typeof o.defaultMode === 'string' ? o.defaultMode : null,
    autoMode,
  };
}

/** The settings after a profile: existing allow rules stay, new ones go after them, deny rules never change. */
export function applyProfile(settings: Record<string, unknown>, profile: PermissionProfile, facts: RepoFacts): Record<string, unknown> {
  if (profile === 'default') return settings;
  const rules = readRules(settings);
  const add = [...STANDARD_BASE, ...buildRules(facts)];
  const allow = [...rules.allow, ...add.filter((r) => !rules.allow.includes(r))];
  const permissions = { ...(settings.permissions as Record<string, unknown> | undefined) };
  permissions.allow = allow;
  return { ...settings, permissions };
}

const INTERPRETER_RE = /^(?:python[\d.]*|node|deno|bun|ruby|perl|php|sh|bash|zsh|fish|pwsh|powershell)(?:\*|[\s:].*\*)/;
const WRAPPER_RE = /^(?:timeout|env|xargs|nohup|nice|time|sudo|exec|eval|command|watch|npx|pnpx|bunx|uvx)(?:\s+\*|:\*)$/;
const PM_RUN_RE = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run|run-script|exec|dlx|x)|(?:cargo|poetry|uv|pipenv|deno)\s+run)\b.*\*/;

/**
 * An allow rule of the kinds that auto mode drops on entering it: every command of a shell, a rule
 * that starts with a wildcard, a wildcarded interpreter, a wrapper followed only by a wildcard, a
 * package-manager run with a wildcard, and Agent or Monitor rules.
 */
export function isBroadRule(rule: string): boolean {
  if (['Bash', 'PowerShell', 'Agent', 'Monitor'].includes(rule) || /^(?:Agent|Monitor)\(/.test(rule)) return true;
  const m = rule.match(/^(?:Bash|PowerShell)\((.*)\)$/);
  if (!m) return false;
  const c = (m[1] as string).trim();
  return c.startsWith('*') || INTERPRETER_RE.test(c) || WRAPPER_RE.test(c) || PM_RUN_RE.test(c);
}

/** Which profile the rules match: standard, default (no rules at all) or custom. */
export function identify(rules: Rules): 'standard' | 'default' | 'custom' {
  if (STANDARD_BASE.every((r) => rules.allow.includes(r))) return 'standard';
  if (rules.allow.length === 0 && rules.ask.length === 0 && rules.deny.length === 0 && rules.defaultMode === null) return 'default';
  return 'custom';
}

export interface Finding {
  level: 'warn' | 'info';
  text: string;
}

function some(xs: string[]): string {
  return xs.slice(0, 3).join(', ') + (xs.length > 3 ? ', ...' : '');
}

/** What in the rules would hold a cloud session at a prompt nobody sees, or does not work there. */
export function assess(rules: Rules): Finding[] {
  const out: Finding[] = [];
  if (rules.ask.length) {
    out.push({ level: 'warn', text: `${rules.ask.length} ask rule(s) (${some(rules.ask)}) prompt even in auto mode, and the session waits until a person answers` });
  }
  const broad = rules.allow.filter(isBroadRule);
  if (broad.length) {
    out.push({ level: 'warn', text: `${broad.length} broad allow rule(s) (${some(broad)}) are dropped by auto mode, which routine runs start in, so they allow nothing in a cloud session` });
  }
  if (!rules.allow.some((r) => r.startsWith('Bash(') && !isBroadRule(r))) {
    out.push({
      level: 'warn',
      text: 'no narrow allow rule for Bash: every command goes to the auto mode classifier, and after 3 blocks in a row or 20 in the session a prompt waits for a person (at the first command when auto mode is not available)',
    });
  }
  if (rules.defaultMode === 'bypassPermissions' || rules.defaultMode === 'dontAsk') {
    out.push({ level: 'warn', text: `defaultMode "${rules.defaultMode}" is ignored by cloud sessions, which have no such mode` });
  } else if (rules.defaultMode === 'auto') {
    out.push({ level: 'info', text: 'defaultMode "auto" does not take effect from a repository\'s settings; routine runs start in auto mode anyway' });
  }
  if (rules.autoMode) out.push({ level: 'info', text: 'autoMode settings are not read from a repository\'s .claude/settings.json, only from user or managed settings' });
  return out;
}

export function describeRules(rules: Rules): string[] {
  const list = (name: string, xs: string[]) => (xs.length ? `${name} (${xs.length}): ${xs.join(', ')}` : `${name}: none`);
  return [list('allow', rules.allow), list('ask', rules.ask), list('deny', rules.deny), `defaultMode: ${rules.defaultMode ?? 'not set'}`];
}

/** The indentation the file uses, so a rewrite keeps its look. */
function indentOf(text: string | null): string | number {
  const m = text?.match(/^[ \t]+(?=")/m);
  if (!m) return 2;
  return m[0].includes('\t') ? '\t' : m[0].length;
}

export function renderSettings(settings: Record<string, unknown>, original: string | null): string {
  return JSON.stringify(settings, null, indentOf(original)) + '\n';
}

/** A short id of one change: the file it was computed from and the text it writes. */
export function changeToken(before: string | null, after: string): string {
  return crypto.createHash('sha256').update(`${before ?? '\u0000absent'}\u0000${after}`).digest('hex').slice(0, 12);
}

/** A unified diff of two texts, with three lines of context. */
export function unifiedDiff(before: string | null, after: string, label: string): string {
  const a = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const ops = lineOps(a, b);
  const head = [`--- ${before === null ? '/dev/null' : `a/${label}`}`, `+++ b/${label}`];
  const hunks: string[] = [];
  const CONTEXT = 3;
  let i = 0;
  while (i < ops.length) {
    if ((ops[i] as Op).kind === ' ') {
      i++;
      continue;
    }
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    // extend over changes closer than twice the context
    for (let j = i; j < ops.length; j++) {
      if ((ops[j] as Op).kind !== ' ') end = j;
      else if (j - end > 2 * CONTEXT) break;
    }
    const stop = Math.min(ops.length, end + CONTEXT + 1);
    const slice = ops.slice(start, stop);
    const aStart = slice.find((o) => o.a !== null)?.a ?? (ops.slice(0, start).filter((o) => o.a !== null).length);
    const bStart = slice.find((o) => o.b !== null)?.b ?? (ops.slice(0, start).filter((o) => o.b !== null).length);
    const aLen = slice.filter((o) => o.kind !== '+').length;
    const bLen = slice.filter((o) => o.kind !== '-').length;
    hunks.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) hunks.push(`${o.kind}${o.text}`);
    i = stop;
  }
  return [...head, ...hunks].join('\n');
}

interface Op {
  kind: ' ' | '-' | '+';
  text: string;
  a: number | null;
  b: number | null;
}

/** The edit script of two line lists, from their longest common subsequence. */
function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] = a[i] === b[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string, a: i, b: j });
      i++;
      j++;
    } else if (i < n && (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) {
      ops.push({ kind: '-', text: a[i] as string, a: i, b: null });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j] as string, a: null, b: j });
      j++;
    }
  }
  return ops;
}

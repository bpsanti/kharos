// The repository's .claude/settings.json, as a cloud session reads it. A session on one repository reads
// that repository's file; the user's own settings and .claude/settings.local.json stay on the person's
// machine. A session that a routine starts begins in auto mode when it is available: broad allow rules are
// dropped, narrow ones resolve before the classifier, ask rules always prompt, and the classifier decides
// the rest, with a prompt after it blocks 3 actions in a row or 20 in the session. A prompt waits for a person.

import crypto from 'node:crypto';

export const SETTINGS_PATH = '.claude/settings.json';

export class SettingsError extends Error {}

export interface Rules {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode: string | null;
  /** The file has autoMode settings, which a project's settings cannot set. */
  autoMode: boolean;
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

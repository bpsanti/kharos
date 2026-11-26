// The permission preflight: before a launch, the permission prompts its cloud session is likely to
// hit, each with the narrow allow pattern of the kharos permission hook that answers it, and why.
// Three sources, each simple enough to explain in one line:
//   1. the ask rules of the organization's managed settings (the local copy the doctor reads) and of the
//      repository's .claude/settings.json: each one prompts in every cloud session;
//   2. commands the repository itself runs that such an ask rule covers: package.json scripts, Makefile
//      recipes, shell scripts, the docker compose commands of a compose file, and shell blocks of its docs;
//   3. the Bash permission prompts kharos recorded in earlier sessions on the same repository.
// A suggestion goes through the same safety filter as `kharos permissions hook diff`: never a broad
// pattern, and never one a deny rule covers. Mirroring the organization's ask rules is separate: only
// automatic preflight does it, while a remembered mirror confirmation matches the managed settings.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { bashRuleMatches, broadRuleWhy, decide, parsePattern, showPattern, type HookRules } from '../cloud/kharos-permission.mjs';
import { promptCommand } from './approvals.ts';
import { isPermissionPrompt } from './classify.ts';
import { normalizeRepo } from './config.ts';
import type { RepoSnapshot } from './forge.ts';
import { readStoredEvents } from './logparse.ts';
import { hooksBlocked, mirrorRefusal, planMirror, type ManagedPolicy } from './managed-policy.ts';
import { describeConfirmation, type ConfirmationState } from './org-confirmations.ts';
import { allowRefusal, HOOK_RULES_PATH, HOOK_SCRIPT_PATH, hookState, type HookFiles } from './permission-hook.ts';
import { parseSettings, readRules, SETTINGS_PATH, SettingsError } from './permission-profiles.ts';
import type { Paths } from './paths.ts';
import { loadRegistry, logPath } from './registry.ts';

/** Most files the preflight reads from a branch, besides the three of the permission hook. */
export const MAX_FILES = 60;
const MAX_FILE_BYTES = 256 * 1024;

const ROOT_FILES = ['package.json', 'Makefile', 'makefile', 'GNUmakefile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'README.md', 'CONTRIBUTING.md'];
const COMPOSE_FILES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const SKIP_DIR_RE = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|\.git)\//;

const depth = (p: string) => p.split('/').length - 1;

/** The files the preflight reads: the hook's three, then the ones that hold commands, in that order, at most MAX_FILES of the second kind. */
export function selectFiles(all: readonly string[]): string[] {
  const set = new Set(all);
  const hook = [SETTINGS_PATH, HOOK_SCRIPT_PATH, HOOK_RULES_PATH].filter((p) => set.has(p));
  const ok = all.filter((p) => !SKIP_DIR_RE.test(p));
  const picked = [
    ...ROOT_FILES.filter((f) => set.has(f)),
    ...ok.filter((p) => /^(?:scripts|bin)\/[^/]+(?:\/[^/]+)?$/.test(p) && /(?:^|\/)[^./]+$|\.(?:sh|bash)$/.test(p)),
    ...ok.filter((p) => p.endsWith('.sh') && depth(p) <= 2),
    ...ok.filter((p) => /^docs\/.+\.md$/.test(p) && depth(p) <= 3),
  ];
  return [...hook, ...[...new Set(picked)].filter((p) => !hook.includes(p)).slice(0, MAX_FILES)];
}

/** The files of a local checkout, the same selection as a branch read through gh. */
export function localSnapshot(root: string, env: NodeJS.ProcessEnv): RepoSnapshot {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', timeout: 15_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  const all = r.status === 0 ? r.stdout.split('\0').filter((p) => p !== '') : fs.readdirSync(root);
  const files = new Map<string, string>();
  const unreadable = new Set<string>();
  for (const p of selectFiles(all)) {
    const file = path.join(root, p);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        unreadable.add(p);
        continue;
      }
      files.set(p, fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.add(p);
    }
  }
  return { label: root, paths: all, files, unreadable, base: null };
}

export function hookFilesOf(s: RepoSnapshot): HookFiles {
  return { settings: s.files.get(SETTINGS_PATH) ?? null, script: s.files.get(HOOK_SCRIPT_PATH) ?? null, rules: s.files.get(HOOK_RULES_PATH) ?? null };
}

// --- reading commands out of text ---------------------------------------------------------------

/** The simple commands of a line, cut at chaining, pipes and background marks, without redirections or a comment. */
export function simpleCommands(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (cur.trim() !== '') parts.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === '\\' && quote !== "'" && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1] as string))) break;
    if (c === '>' || c === '<') {
      // A redirection and its target go: the descriptor in front (2>), the operator (>>, >&), the word after.
      cur = cur.replace(/\d+$/, '');
      let j = i + 1;
      while (j < line.length && /[<>&\d]/.test(line[j] as string)) j++;
      while (j < line.length && /\s/.test(line[j] as string)) j++;
      while (j < line.length && !/[\s;&|()<>]/.test(line[j] as string)) j++;
      i = j - 1;
      continue;
    }
    if (';|&()'.includes(c)) {
      end();
      continue;
    }
    cur += c;
  }
  end();
  return parts;
}

interface Token {
  /** The word as the shell sees it, quotes removed. */
  value: string;
  /** The word as written. */
  raw: string;
  /** It expands, globs or substitutes: its value is not known from the text. */
  dynamic: boolean;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let value = '';
  let raw = '';
  let dynamic = false;
  let started = false;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (started) out.push({ value, raw, dynamic });
    value = '';
    raw = '';
    dynamic = false;
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      raw += c;
      if (quote === '"' && c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1] as string)) {
        value += text[i + 1];
        raw += text[i + 1];
        i++;
      } else if (c === quote) quote = null;
      else if (quote === '"' && (c === '$' || c === '`')) dynamic = true;
      else value += c;
      continue;
    }
    if (/\s/.test(c)) {
      end();
      continue;
    }
    started = true;
    raw += c;
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      raw += text[i + 1];
      i++;
    } else {
      if ('$`*?[]{}~!'.includes(c)) dynamic = true;
      value += c;
    }
  }
  end();
  return out;
}

/** A word that stands as itself in an allow pattern. */
const PLAIN_RE = /^[\w@%+=:,./-]{1,120}$/;

/** user:password@ userinfo, as in a URL, or a key=value word whose key names a credential. */
const SECRET_WORD_RE = /:\/\/[^/@:]*:[^@]*@|[^/@:]*:[^/@]+@|(?:key|secret|token|passw(?:or)?d|pwd)=/i;
/** A JSON Web Token: base64url JSON, which starts with `eyJ`. */
const JWT_RE = /^eyJ[\w-]{8,}/;
/** The options whose value is a credential, by their whole name. */
const SECRET_FLAGS = new Set(['--token', '--password', '--passwd', '--pass', '--secret', '--api-key', '--apikey', '--auth-token', '--access-key', '--secret-key', '--secret-access-key', '--client-secret']);
/** The `aws configure set` names whose value is a credential. */
const AWS_SECRET_RE = /(?:^|\.)aws_(?:secret_access_key|session_token|access_key_id)$/;
/** Options whose value is a database name. */
const DATABASE_FLAGS = new Set(['-d', '--dbname', '--database']);

/**
 * A word shaped like a generated credential: long, letters and digits mixed, and neither a path, a host
 * name, a hex commit id nor a name of several `-` or `_` separated parts.
 */
function credentialShaped(w: string): boolean {
  if (w.length < 20 || !/[a-z]/i.test(w) || !/\d/.test(w) || /[/.]/.test(w)) return false;
  return !/^[0-9a-f]+$/i.test(w) && w.split(/[-_]/).length < 3;
}

/** A word that holds a credential (userinfo, a credential option or key=value, the value after one, or a token by its shape): never kept as written. */
function secretAt(values: readonly string[], i: number): boolean {
  const w = values[i] as string;
  const program = path.posix.basename(values[0] as string);
  const prev = i > 1 ? (values[i - 1] as string) : '';
  if (SECRET_WORD_RE.test(w) || JWT_RE.test(w)) return true;
  if (SECRET_FLAGS.has(prev.toLowerCase())) return true;
  if ((prev === '-H' || prev === '--header') && /key|token|secret|auth/i.test(w.split(':')[0] as string)) return true;
  if (program === 'curl' && (prev === '-u' || prev === '--user') && w.includes(':')) return true;
  if ((program === 'redis-cli' && prev === '-a') || (program === 'sshpass' && prev === '-p')) return true;
  if (program === 'aws' && values[1] === 'configure' && values[2] === 'set' && i === 4) return AWS_SECRET_RE.test(values[3] as string);
  if (/^(?:mysql|mysqldump|mysqladmin|mariadb)/.test(program) && /^-p.+/.test(w)) return true;
  return i > 1 && program !== 'git' && !DATABASE_FLAGS.has(prev) && credentialShaped(w);
}

export interface Candidate {
  /** The pattern's words; null is a `*`, one argument of any content. */
  words: (string | null)[];
  /** The command as written, with any variable assignment in front taken off, for matching ask rules. */
  text: string;
}

/**
 * A simple command as an allow pattern: the program stays as written, and every argument that expands
 * a variable, needed quoting (free text such as a query), is not a plain word or holds a credential becomes `*`.
 */
export function toCandidate(command: string): Candidate | null {
  const toks = tokenize(command);
  while (toks.length && !toks[0]?.raw.startsWith('=') && /^[A-Za-z_]\w*=/.test(toks[0]?.raw ?? '')) toks.shift();
  const first = toks[0];
  if (!first || first.dynamic || !PLAIN_RE.test(first.value) || first.value.startsWith('-')) return null;
  const values = toks.map((t) => t.value);
  const words = toks.map((t, i) => (!t.dynamic && PLAIN_RE.test(t.value) && (i === 0 || !secretAt(values, i)) ? t.value : null));
  return { words, text: toks.map((t) => t.raw).join(' ') };
}

/** The command lines a file of the repository holds, by what kind of file it is. */
export function commandLines(file: string, text: string): string[] {
  const base = path.posix.basename(file);
  if (base === 'package.json') {
    try {
      const pkg = JSON.parse(text) as { scripts?: unknown };
      const scripts = pkg.scripts;
      if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return [];
      return Object.values(scripts as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }
  const joined = text.replace(/\\\r?\n\s*/g, ' ');
  if (/^(?:GNUmakefile|makefile|Makefile)$/.test(base)) {
    return joined
      .split('\n')
      .filter((l) => l.startsWith('\t'))
      .map((l) => l.trim().replace(/^[@+-]+/, ''))
      .filter((l) => l !== '' && !l.includes('$(') && !l.includes('${'));
  }
  if (file.endsWith('.md')) {
    const out: string[] = [];
    let inShell = false;
    let inFence = false;
    for (const l of joined.split('\n')) {
      const fence = /^\s*(```|~~~)\s*([\w-]*)/.exec(l);
      if (fence) {
        inShell = !inFence && ['', 'sh', 'bash', 'shell', 'console', 'zsh'].includes((fence[2] ?? '').toLowerCase());
        inFence = !inFence;
        continue;
      }
      if (inFence && inShell) out.push(l.trim().replace(/^\$\s+/, ''));
    }
    return out.filter((l) => l !== '' && !l.startsWith('#'));
  }
  if (COMPOSE_FILES.has(file)) return ['docker compose up -d', 'docker compose ps', 'docker compose logs', 'docker compose down'];
  return joined
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// --- the report --------------------------------------------------------------------------------

export interface AskRule {
  rule: string;
  origin: 'organization' | 'repository';
}

export type Source = { kind: 'repo'; file: string } | { kind: 'history'; session: string };

export interface Suggestion {
  /** The allow pattern, as `--allow` takes it. */
  pattern: string;
  /** The likely prompt, as the session reads it: each `*` shows as <arg>. */
  prompt: string;
  program: string;
  asks: AskRule[];
  sources: Source[];
  /** The instruction names the program. */
  mentioned: boolean;
  status: 'suggested' | 'covered' | 'refused';
  /** Why kharos does not suggest it, for status refused. */
  refusal: string | null;
}

export interface AskEntry extends AskRule {
  /** What answers it: a suggestion of this report, the hook as it is now, nothing, or nothing possible. */
  state: 'suggested' | 'hook' | 'mirror' | 'open' | 'not-bash' | 'every-command';
  mentioned: boolean;
}

export interface PreflightReport {
  label: string;
  repo: string | null;
  suggestions: Suggestion[];
  asks: AskEntry[];
  /** Tools other than Bash that prompted in earlier sessions, with how many times. */
  otherTools: { tool: string; count: number }[];
  /** Earlier prompts for a chained command that no ask rule explains. */
  chained: number;
  /** Earlier sessions on this repository whose logs were read. */
  sessionsRead: number;
  notes: string[];
  /** The hook's rules on this branch now, when they are usable. */
  current: HookRules | null;
  /** Why the organization's ask rules cannot be mirrored, or null when they can. */
  mirrorRefusal: string | null;
  confirmation: ConfirmationState;
}

export interface PreflightInput {
  snapshot: RepoSnapshot;
  repo: string | null;
  policy: ManagedPolicy;
  /** The earlier Bash and other prompts on the same repository. */
  history: HistoryPrompt[];
  sessionsRead: number;
  instruction: string;
  /** The person's remembered confirmation to mirror the organization's ask rules. */
  confirmation?: ConfirmationState;
  /** Automatic preflight is on: it mirrors at launch while that confirmation holds. */
  autoMirror?: boolean;
}

export interface HistoryPrompt {
  session: string;
  tool: string;
  /** The Bash command, or null for another tool or a line too cut to read. */
  command: string | null;
}

/** The permission prompts kharos recorded in the stored logs of earlier sessions on a repository. */
export function readHistory(paths: Paths, repo: string, exclude: string | null = null): { prompts: HistoryPrompt[]; sessions: number } {
  const want = normalizeRepo(repo);
  const prompts: HistoryPrompt[] = [];
  let sessions = 0;
  for (const s of Object.values(loadRegistry(paths).sessions)) {
    if (s.id === exclude || normalizeRepo(s.repo) !== want) continue;
    const events = readStoredEvents(logPath(paths, s.id));
    if (events.length === 0) continue;
    sessions++;
    for (const e of events) {
      if (!isPermissionPrompt(e)) continue;
      const tool = e.tool ?? 'unknown tool';
      prompts.push({ session: s.id, tool, command: tool === 'Bash' ? promptCommand(e.text) : null });
    }
  }
  return { prompts, sessions };
}

function bashAsk(rule: string): boolean {
  return rule === 'Bash' || /^Bash\(.+\)$/s.test(rule);
}

function programOf(rule: string): string | null {
  const m = /^Bash\(\s*([^\s:*()]+)/.exec(rule);
  return m ? (m[1] as string) : null;
}

function mentions(instruction: string, program: string): boolean {
  const name = path.posix.basename(program);
  if (name.length < 2) return false;
  return new RegExp(`(?:^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(instruction);
}

const sample = (words: readonly (string | null)[]) => words.map((w) => (w === null ? 'x' : w)).join(' ');

function groupKey(words: readonly (string | null)[]): string {
  return [words[0], words[1] ?? '*', words.length].join('\u0000');
}

/** Two candidates of one group as one pattern: the words that differ become `*`. */
function merge(a: (string | null)[], b: readonly (string | null)[]): (string | null)[] {
  return a.map((w, i) => (w !== null && w === b[i] ? w : null));
}

export function buildPreflight(input: PreflightInput): PreflightReport {
  const { snapshot, policy, instruction } = input;
  const notes: string[] = [];
  let settings: Record<string, unknown> = {};
  let repoRules = { ask: [] as string[], deny: [] as string[] };
  try {
    settings = parseSettings(snapshot.files.get(SETTINGS_PATH) ?? null);
    repoRules = readRules(settings);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    notes.push(`${SETTINGS_PATH}: ${err.message}; its ask and deny rules are not read`);
  }
  if (snapshot.unreadable.has(SETTINGS_PATH)) notes.push(`${SETTINGS_PATH} could not be read as text; its ask and deny rules are not read`);
  let current: HookRules | null = null;
  try {
    const st = hookState(hookFilesOf(snapshot));
    if (st.installed && st.rules && !('error' in st.rules)) current = st.rules;
    else if (st.installed && st.rules && 'error' in st.rules) notes.push(`${HOOK_RULES_PATH}: ${st.rules.error}`);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
  }

  const asks: AskRule[] = [
    ...(policy.status === 'found' ? policy.ask.map((rule) => ({ rule, origin: 'organization' as const })) : []),
    ...repoRules.ask.map((rule) => ({ rule, origin: 'repository' as const })),
  ];
  // A rule for every command would make every line of every script a likely prompt: those count only from earlier sessions.
  const narrowAsks = asks.filter((a) => bashAsk(a.rule) && broadRuleWhy(a.rule) === null);
  const asksOf = (text: string) => narrowAsks.filter((a) => bashRuleMatches(a.rule, text));

  interface Group {
    words: (string | null)[];
    texts: Set<string>;
    sources: Source[];
  }
  const groups = new Map<string, Group>();
  const add = (c: Candidate, source: Source) => {
    const key = groupKey(c.words);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { words: [...c.words], texts: new Set([c.text]), sources: [source] });
      return;
    }
    g.words = merge(g.words, c.words);
    g.texts.add(c.text);
    if (!g.sources.some((s) => JSON.stringify(s) === JSON.stringify(source))) g.sources.push(source);
  };

  // 2. Commands the repository runs, when an ask rule covers them.
  for (const [file, text] of snapshot.files) {
    if (file === SETTINGS_PATH || file === HOOK_SCRIPT_PATH || file === HOOK_RULES_PATH) continue;
    for (const line of commandLines(file, text)) {
      for (const part of simpleCommands(line)) {
        const c = toCandidate(part);
        if (c && asksOf(c.text).length) add(c, { kind: 'repo', file });
      }
    }
  }

  // 3. What prompted in earlier sessions on this repository.
  const otherTools = new Map<string, number>();
  let chained = 0;
  for (const h of input.history) {
    if (h.tool !== 'Bash') {
      otherTools.set(h.tool, (otherTools.get(h.tool) ?? 0) + 1);
      continue;
    }
    if (h.command === null) continue;
    const parts = simpleCommands(h.command).map(toCandidate).filter((c): c is Candidate => c !== null);
    const asked = parts.filter((c) => asksOf(c.text).length);
    const chosen = asked.length ? asked : parts.length === 1 && simpleCommands(h.command).length === 1 ? parts : [];
    if (chosen.length === 0) chained++;
    for (const c of chosen) add(c, { kind: 'history', session: h.session });
  }

  const repoDeny = repoRules.deny;
  const suggestions: Suggestion[] = [];
  for (const g of groups.values()) {
    const pattern = g.words.map((w) => (w === null ? '*' : w)).join(' ');
    const program = g.words[0] as string;
    const matched = narrowAsks.filter((a) => [...g.texts, sample(g.words)].some((t) => bashRuleMatches(a.rule, t)));
    const refusal = allowRefusal(pattern, false, policy, repoDeny);
    const covered = current !== null && decide({ tool_name: 'Bash', tool_input: { command: sample(g.words) } }, current).behavior === 'allow';
    const p = parsePattern(pattern, true);
    suggestions.push({
      pattern,
      prompt: p.ok ? showPattern(p.words) : pattern,
      program,
      asks: matched,
      sources: g.sources,
      mentioned: mentions(instruction, program),
      status: refusal ? 'refused' : covered ? 'covered' : 'suggested',
      refusal,
    });
  }
  suggestions.sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.sources.length - a.sources.length || a.pattern.localeCompare(b.pattern));

  const confirmation = input.confirmation ?? { state: 'none' };
  const autoMirrors = input.autoMirror && confirmation.state === 'valid' && mirrorRefusal(policy) === null && policy.status === 'found' ? planMirror(policy.ask).converted : [];
  // 1. Every ask rule, and what answers it.
  const entries: AskEntry[] = asks.map((a) => {
    const program = programOf(a.rule);
    const mentioned = program !== null && mentions(instruction, program);
    if (!bashAsk(a.rule)) return { ...a, state: 'not-bash', mentioned };
    if (broadRuleWhy(a.rule) !== null) return { ...a, state: 'every-command', mentioned };
    if (suggestions.some((s) => s.status === 'suggested' && s.asks.some((x) => x.rule === a.rule && x.origin === a.origin))) return { ...a, state: 'suggested', mentioned };
    const byHook =
      current !== null &&
      (current.mirror.includes(a.rule) || current.allow.some((p) => {
        const w = parsePattern(p, true);
        return w.ok && bashRuleMatches(a.rule, sample(w.words));
      }));
    if (byHook) return { ...a, state: 'hook', mentioned };
    return { ...a, state: a.origin === 'organization' && autoMirrors.includes(a.rule) ? 'mirror' : 'open', mentioned };
  });
  entries.sort((a, b) => Number(b.mentioned) - Number(a.mentioned));

  const blocked = hooksBlocked(policy);
  if (blocked) notes.push(`${blocked}; suggestions below would not take effect`);
  if (policy.status === 'absent') notes.push(`no copy of the organization's managed settings at ${policy.file}: its ask rules, if any, are not known here`);
  if (policy.status === 'unreadable') notes.push(`${policy.file} cannot be read (${policy.error}): the organization's ask rules are not known here`);

  return {
    label: snapshot.label,
    repo: input.repo,
    suggestions,
    asks: entries,
    otherTools: [...otherTools].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
    chained,
    sessionsRead: input.sessionsRead,
    notes,
    current,
    mirrorRefusal: mirrorRefusal(policy),
    confirmation,
  };
}

/** The patterns automatic preflight may apply: suggested ones only, which are narrow and pass every filter. */
export function applicable(r: PreflightReport): string[] {
  return r.suggestions.filter((s) => s.status === 'suggested').map((s) => s.pattern);
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function some(xs: readonly string[], n = 3): string {
  return xs.slice(0, n).join(', ') + (xs.length > n ? `, and ${xs.length - n} more` : '');
}

function why(s: Suggestion): string {
  const out: string[] = [];
  for (const a of s.asks) out.push(a.origin === 'organization' ? `the organization's ask rule ${a.rule} prompts in every cloud session` : `the repository's ask rule ${a.rule} prompts`);
  const files = [...new Set(s.sources.flatMap((x) => (x.kind === 'repo' ? [x.file] : [])))];
  const sessions = [...new Set(s.sources.flatMap((x) => (x.kind === 'history' ? [x.session] : [])))];
  if (files.length) out.push(`the repository runs it (${some(files)})`);
  if (sessions.length) out.push(`earlier sessions on this repository waited on it (${some(sessions)})`);
  if (s.mentioned) out.push(`the instruction mentions ${s.program}`);
  return out.join('; ');
}

export interface FormatOptions {
  /** The command that adds the suggested patterns, without its --allow flags; null when none can. */
  addCommand: string | null;
  /** Lines that say where the change goes and what follows it. */
  after: string[];
  hookOn: boolean;
  auto: boolean;
}

export function formatPreflight(r: PreflightReport, o: FormatOptions): string {
  const lines = [`permission preflight for ${r.label}:`];
  for (const n of r.notes) lines.push(`note: ${n}`);
  const suggested = r.suggestions.filter((s) => s.status === 'suggested');
  const open = r.asks.filter((a) => a.state === 'open');
  if (suggested.length === 0 && open.length === 0) lines.push('no likely prompt found that a narrow allow pattern of the kharos permission hook would answer');
  let n = 0;
  if (suggested.length) {
    lines.push('likely prompt -> suggested narrow rule -> why:');
    for (const s of suggested) {
      lines.push(`  ${++n}. ${s.prompt}`, `     -> --allow ${shellQuote(s.pattern)}`, `     -> ${why(s)}`);
    }
  }
  for (const a of open) {
    const program = programOf(a.rule) ?? 'it';
    lines.push(
      `  ${++n}. ${a.rule} (${a.origin === 'organization' ? "the organization's" : "the repository's"} ask rule${a.mentioned ? `; the instruction mentions ${program}` : ''})`,
      `     -> no narrow rule to suggest: nothing in the repository or in earlier sessions runs ${program}`,
      `     -> if the task needs it, add its exact form with --allow '<${program} and its words, * for one argument>'${a.origin === 'organization' && r.mirrorRefusal === null ? ", or mirror the organization's ask rules (kharos permissions hook diff --mirror) after its administrator agrees" : ''}`,
    );
  }
  const mirrored = r.asks.filter((a) => a.state === 'mirror');
  if (mirrored.length && r.confirmation.state === 'valid') {
    lines.push(`mirrored at each launch by automatic preflight, with your confirmation of ${r.confirmation.at.slice(0, 10)} (it holds while the organization's managed settings do not change): ${some(mirrored.map((a) => a.rule), 8)}`);
  }
  const remembered = describeConfirmation(r.confirmation);
  if (remembered && r.mirrorRefusal === null && (open.some((a) => a.origin === 'organization') || r.confirmation.state === 'changed')) lines.push(`mirroring: ${remembered}`);
  const covered = r.suggestions.filter((s) => s.status === 'covered');
  const byHook = r.asks.filter((a) => a.state === 'hook');
  if (covered.length || byHook.length) lines.push(`already answered by the kharos permission hook on this branch: ${some([...covered.map((s) => s.pattern), ...byHook.map((a) => a.rule)], 6)}`);
  for (const s of r.suggestions.filter((x) => x.status === 'refused')) lines.push(`not suggested: ${s.refusal}`);
  const every = r.asks.filter((a) => a.state === 'every-command');
  if (every.length) lines.push(`${some(every.map((a) => a.rule))}: an ask rule for every command makes every Bash call prompt; only commands found above are suggested`);
  const notBash = r.asks.filter((a) => a.state === 'not-bash');
  if (notBash.length) lines.push(`ask rules for other tools stay prompts, since the hook answers only Bash calls: ${some(notBash.map((a) => a.rule), 6)}`);
  if (r.otherTools.length) lines.push(`other tools that prompted in earlier sessions (the hook answers only Bash calls): ${r.otherTools.map((t) => `${t.tool} (${t.count})`).join(', ')}`);
  if (r.chained) lines.push(`${r.chained} earlier prompt(s) were for chained or piped commands that no ask rule explains; the hook allows only single simple commands`);
  if (r.repo) lines.push(`earlier sessions on this repository read: ${r.sessionsRead} (kharos keeps a session's log for 14 days after it is closed)`);

  const flags = suggested.map((s) => `--allow ${shellQuote(s.pattern)}`);
  if (flags.length) {
    lines.push('to add them:');
    if (o.addCommand) {
      if (!o.hookOn) lines.push('  kharos permissions hook enable   (the hook is opt-in and off)');
      lines.push(`  ${o.addCommand.replace('{flags}', flags.join(' '))}`);
    }
    for (const a of o.after) lines.push(`  ${a}`);
  }
  lines.push(`preflight: ${suggested.length} rule(s) to suggest, ${open.length} ask rule(s) with none; automatic preflight ${o.auto ? (o.hookOn ? 'on' : 'on, but inactive while permission_hook is off') : 'off'}`);
  return lines.join('\n');
}

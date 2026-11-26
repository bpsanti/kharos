// The permission preflight: before a launch, the permission prompts its cloud session is likely to
// hit, each with the narrow rule of the kharos permission hook that answers it, and why.
// Three sources, each simple enough to explain in one line:
//   1. the ask rules of the organization's managed settings (the local copy the doctor reads) and of the
//      repository's .claude/settings.json: each one prompts in every cloud session;
//   2. commands the repository itself runs that such an ask rule covers: package.json scripts, Makefile
//      recipes, shell scripts, the docker compose commands of a compose file, and shell blocks of its docs;
//   3. the Bash permission prompts kharos recorded in earlier sessions on the same repository, each
//      reduced to a prefix rule of its program and subcommands, so none of its values reaches a rule.
// A suggestion goes through the same safety filter as `kharos permissions hook diff`: never a broad
// pattern, and never one a deny rule covers. Mirroring the organization's ask rules is separate: only
// automatic preflight does it, while a remembered mirror confirmation matches the managed settings.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { bashRuleMatches, broadRuleWhy, commandHead, decide, MAX_ALLOWED_LENGTH, parsePattern, prefixMatches, prefixOf, showPattern, splitCommand, type HookRules } from '../cloud/kharos-permission.mjs';
import { promptCommand } from './approvals.ts';
import { isPermissionPrompt } from './classify.ts';
import { normalizeRepo } from './config.ts';
import type { RepoSnapshot } from './forge.ts';
import { readStoredEvents } from './logparse.ts';
import { hooksBlocked, mirrorRefusal, planMirror, type ManagedPolicy } from './managed-policy.ts';
import { describeConfirmation, type ConfirmationState } from './org-confirmations.ts';
import { allowRefusal, HOOK_RULES_PATH, HOOK_SCRIPT_PATH, hookState, prefixRefusal, type HookFiles } from './permission-hook.ts';
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

export interface Candidate {
  /** The pattern's words; null is a `*`, one argument of any content. */
  words: (string | null)[];
  /** The command as written, with any variable assignment in front taken off, for matching ask rules. */
  text: string;
}

/**
 * A simple command as an allow pattern: the program stays as written, and every argument that expands
 * a variable, needed quoting (free text such as a query) or is not a plain word becomes `*`.
 */
export function toCandidate(command: string): Candidate | null {
  const toks = tokenize(command);
  while (toks.length && !toks[0]?.raw.startsWith('=') && /^[A-Za-z_]\w*=/.test(toks[0]?.raw ?? '')) toks.shift();
  const first = toks[0];
  if (!first || first.dynamic || !PLAIN_RE.test(first.value) || first.value.startsWith('-')) return null;
  const words = toks.map((t) => (!t.dynamic && PLAIN_RE.test(t.value) ? t.value : null));
  return { words, text: toks.map((t) => t.raw).join(' ') };
}

/**
 * A command recorded in an earlier session as a prefix rule: its program and the subcommand words that
 * name the action (`Bash(git push:*)`, `Bash(docker compose exec:*)`, `Bash(kubectl get pods:*)`), found
 * by the hook's own parser, and nothing else of it, so no value, flag or path it was run with reaches a
 * rule. `review` is set when a program built on subcommands shows none that can be told apart from its
 * options: the rule is then the bare program, for a person to review, never applied on its own.
 */
export function prefixRule(c: Candidate): { rule: string; review: boolean } {
  const head = commandHead(c.words);
  return { rule: `Bash(${head.words.join(' ')}:*)`, review: !head.complete };
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
  /** An allow pattern, word by word, from the repository's files; or a prefix rule, from earlier sessions. */
  kind: 'pattern' | 'prefix';
  /** The allow pattern, as `--allow` takes it, or the prefix rule, as `--allow-prefix` takes it. */
  pattern: string;
  /** The likely prompt, as the session reads it: each `*` shows as <arg>. */
  prompt: string;
  program: string;
  asks: AskRule[];
  sources: Source[];
  /** The instruction names the program. */
  mentioned: boolean;
  /** review: a prefix rule whose subcommand could not be told apart from its options, shown for a person to review and never added on its own. */
  status: 'suggested' | 'covered' | 'refused' | 'review';
  /** For status covered: the suggested prefix rule that covers it; null when the hook on the branch does. */
  coveredBy: string | null;
  /** Why kharos does not suggest it, for status refused, or why a person should review it first, for status review. */
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

/**
 * Whether a prefix rule allows the commands it was learned from, by the hook's own decision on it alone.
 * A command the hook could never allow by any rule (not a single simple command, or too long) is not counted.
 */
function allowsSources(rule: string, texts: Iterable<string>): boolean {
  return [...texts].every((t) => !splitCommand(t).ok || t.length > MAX_ALLOWED_LENGTH || decide({ tool_name: 'Bash', tool_input: { command: t } }, { allow: [], mirror: [], prefix: [rule] }).behavior === 'allow');
}

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
    /** The pattern's words, or null for a prefix rule. */
    words: (string | null)[] | null;
    /** The prefix rule, or null for a pattern. */
    rule: string | null;
    /** A prefix rule to review only: see prefixRule. */
    review: boolean;
    texts: Set<string>;
    sources: Source[];
  }
  const groups = new Map<string, Group>();
  const join = (key: string, fresh: Group, text: string, source: Source) => {
    const g = groups.get(key);
    if (!g) {
      groups.set(key, fresh);
      return null;
    }
    g.texts.add(text);
    if (!g.sources.some((s) => JSON.stringify(s) === JSON.stringify(source))) g.sources.push(source);
    return g;
  };
  const add = (c: Candidate, source: Source) => {
    const g = join(groupKey(c.words), { words: [...c.words], rule: null, review: false, texts: new Set([c.text]), sources: [source] }, c.text, source);
    if (g?.words) g.words = merge(g.words, c.words);
  };
  const addPrefix = (c: Candidate, source: Source) => {
    const { rule, review } = prefixRule(c);
    join(`prefix\u0000${rule}`, { words: null, rule, review, texts: new Set([c.text]), sources: [source] }, c.text, source);
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
    for (const c of chosen) addPrefix(c, { kind: 'history', session: h.session });
  }

  const repoDeny = repoRules.deny;
  const suggestions: Suggestion[] = [];
  /** A rule covers a prefix when it allows the prefix alone and with one more argument. */
  const coversHead = (r: string, head: string, prefix: boolean) =>
    prefix ? prefixMatches(r, head.split(' ')) && prefixMatches(r, [...head.split(' '), 'x']) : bashRuleMatches(r, head) && bashRuleMatches(r, `${head} x`);
  for (const g of groups.values()) {
    const head = g.rule === null ? null : prefixOf(g.rule);
    const pattern = g.rule ?? (g.words as (string | null)[]).map((w) => (w === null ? '*' : w)).join(' ');
    const shown = head ?? sample(g.words as (string | null)[]);
    const program = shown.split(' ')[0] as string;
    const matched = narrowAsks.filter((a) => [...g.texts, shown].some((t) => bashRuleMatches(a.rule, t)));
    const refusal = g.rule ? prefixRefusal(g.rule, false, policy, repoDeny) : allowRefusal(pattern, false, policy, repoDeny);
    const covered = g.rule
      ? current !== null && ((current.prefix ?? []).some((r) => coversHead(r, shown, true)) || current.mirror.some((r) => coversHead(r, shown, false)))
      : current !== null && decide({ tool_name: 'Bash', tool_input: { command: shown } }, current).behavior === 'allow';
    const p = g.words ? parsePattern(pattern, true) : null;
    const review = refusal || covered || g.rule === null
      ? null
      : g.review
        ? `the subcommand of ${program} could not be told apart from its options; it would allow ${program} with any arguments`
        : allowsSources(g.rule, g.texts)
          ? null
          : 'by the hook\'s own decision, it does not allow a command it was learned from';
    suggestions.push({
      kind: g.rule ? 'prefix' : 'pattern',
      pattern,
      prompt: head ? `${head} <any arguments>` : p?.ok ? showPattern(p.words) : pattern,
      program,
      asks: matched,
      sources: g.sources,
      mentioned: mentions(instruction, program),
      status: refusal ? 'refused' : covered ? 'covered' : review ? 'review' : 'suggested',
      coveredBy: null,
      refusal: refusal ?? review,
    });
  }
  // A pattern of the repository that a suggested prefix rule allows anyway is not suggested twice.
  const prefixes = suggestions.filter((s) => s.kind === 'prefix' && s.status === 'suggested');
  for (const s of suggestions) {
    if (s.kind !== 'pattern' || s.status !== 'suggested') continue;
    const p = parsePattern(s.pattern, true);
    const by = p.ok ? prefixes.find((x) => prefixMatches(x.pattern, sample(p.words).split(' '))) : undefined;
    if (by) {
      s.status = 'covered';
      s.coveredBy = by.pattern;
    }
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
      (current.mirror.includes(a.rule) ||
        (current.prefix ?? []).some((r) => {
          const head = programOf(a.rule) === null ? null : a.rule.replace(/^Bash\(/, '').replace(/(?::\*| \*)?\)$/, '');
          return head !== null && !head.includes('*') && coversHead(r, head, true);
        }) ||
        current.allow.some((p) => {
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

/** The rules automatic preflight may apply: suggested ones only, which are narrow and pass every filter. */
export function applicable(r: PreflightReport): { allow: string[]; prefix: string[] } {
  const suggested = r.suggestions.filter((s) => s.status === 'suggested');
  return { allow: suggested.filter((s) => s.kind === 'pattern').map((s) => s.pattern), prefix: suggested.filter((s) => s.kind === 'prefix').map((s) => s.pattern) };
}

const addFlag = (s: Suggestion) => `${s.kind === 'prefix' ? '--allow-prefix' : '--allow'} ${shellQuote(s.pattern)}`;

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
  if (s.kind === 'prefix') out.push(`it allows ${prefixOf(s.pattern)} with any arguments`);
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
  if (suggested.length === 0 && open.length === 0) lines.push('no likely prompt found that a narrow rule of the kharos permission hook would answer');
  let n = 0;
  if (suggested.length) {
    lines.push('likely prompt -> suggested narrow rule -> why:');
    for (const s of suggested) {
      lines.push(`  ${++n}. ${s.prompt}`, `     -> ${s.kind === 'prefix' ? s.pattern : `--allow ${shellQuote(s.pattern)}`}`, `     -> ${why(s)}`);
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
  const covered = r.suggestions.filter((s) => s.status === 'covered' && s.coveredBy === null);
  for (const s of r.suggestions.filter((x) => x.status === 'covered' && x.coveredBy !== null)) lines.push(`covered by the suggested prefix rule ${s.coveredBy}: ${s.pattern}`);
  const byHook = r.asks.filter((a) => a.state === 'hook');
  if (covered.length || byHook.length) lines.push(`already answered by the kharos permission hook on this branch: ${some([...covered.map((s) => s.pattern), ...byHook.map((a) => a.rule)], 6)}`);
  for (const s of r.suggestions.filter((x) => x.status === 'refused')) lines.push(`not suggested: ${s.refusal}`);
  for (const s of r.suggestions.filter((x) => x.status === 'review')) lines.push(`review before adding: ${s.pattern} (${s.refusal}; so it is not in the command below and never applied on its own)`);
  const every = r.asks.filter((a) => a.state === 'every-command');
  if (every.length) lines.push(`${some(every.map((a) => a.rule))}: an ask rule for every command makes every Bash call prompt; only commands found above are suggested`);
  const notBash = r.asks.filter((a) => a.state === 'not-bash');
  if (notBash.length) lines.push(`ask rules for other tools stay prompts, since the hook answers only Bash calls: ${some(notBash.map((a) => a.rule), 6)}`);
  if (r.otherTools.length) lines.push(`other tools that prompted in earlier sessions (the hook answers only Bash calls): ${r.otherTools.map((t) => `${t.tool} (${t.count})`).join(', ')}`);
  if (r.chained) lines.push(`${r.chained} earlier prompt(s) were for chained or piped commands that no ask rule explains; the hook allows only single simple commands`);
  if (r.repo) lines.push(`earlier sessions on this repository read: ${r.sessionsRead} (kharos keeps a session's log for 14 days after it is closed)`);

  const flags = suggested.map(addFlag);
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

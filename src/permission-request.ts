// Which tool a pending permission prompt is for, and why it asks. The log line is
// `permission prompt <Tool>: {<input>}`; the log does not say why the prompt came, so kharos tells it on
// this machine, from the input and the ask rules it knows, and keeps only a fixed category. An event
// carries the tool name and that category, never the input (the command, the file, the URL, the query).

import { bashRuleMatches } from '../cloud/kharos-permission.mjs';
import { promptCommand } from './approvals.ts';
import type { LogEvent } from './logparse.ts';
import { simpleCommands } from './preflight.ts';

/**
 * Why a prompt waits for a person, as a fixed category. Cloud sessions start in auto mode, where a prompt
 * comes from an ask rule (the organization's managed ones or the repository's), from a check of Claude
 * Code itself that no rule allows, or after the auto mode classifier blocked several calls.
 */
export const PERMISSION_CATEGORIES = ['org_ask_rule', 'repo_ask_rule', 'claude_code_check', 'classifier_block', 'unknown'] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export const CATEGORY_TEXT: Record<PermissionCategory, string> = {
  org_ask_rule: 'an ask rule of the organization',
  repo_ask_rule: 'an ask rule of the repository',
  claude_code_check: 'a check of Claude Code itself that no rule can allow',
  classifier_block: 'the auto mode classifier, after it blocked calls in a row',
  unknown: 'a reason kharos cannot tell',
};

export function categoryText(c: PermissionCategory | undefined): string {
  return CATEGORY_TEXT[c ?? 'unknown'];
}

export interface PermissionRequest {
  tool: string;
  /** Why it asks; absent in records written before kharos told it, which read as unknown. */
  category?: PermissionCategory;
  /** The log event of the prompt, so a new prompt can be told from the one already reported. */
  key: string;
  at: string;
}

/** The ask rules a prompt is compared with: null for a level kharos could not read. */
export interface AskRules {
  org: readonly string[] | null;
  repo: readonly string[] | null;
}

export const NO_RULES: AskRules = { org: null, repo: null };

/** The input of a prompt line; for a line the service cut, only a Bash command it still holds whole, or null. */
export function promptInput(tool: string, text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    const command = tool === 'Bash' ? promptCommand(text) : null;
    return command === null ? null : { command };
  }
}

/** A simple command without the variable assignments in front, which an ask rule looks past. */
function withoutAssignments(command: string): string {
  return command.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]*)\s+)+/, '');
}

/**
 * Whether an ask rule covers the call. A Bash rule matches the whole command or any of its simple
 * commands, past the assignments in front, as Claude Code matches ask rules. A rule of another tool
 * counts when it names the same tool; its specifier (a path, a domain) is not compared.
 */
export function askRuleCovers(rule: string, tool: string, input: Record<string, unknown> | null): boolean {
  if (tool !== 'Bash') return rule === tool || rule.startsWith(`${tool}(`);
  if (rule === 'Bash') return true;
  const command = typeof input?.command === 'string' ? input.command : null;
  if (command === null || !rule.startsWith('Bash(')) return false;
  const parts = [command, ...simpleCommands(command)].map(withoutAssignments);
  return parts.some((p) => p.trim() !== '' && bashRuleMatches(rule, p));
}

/** A call the auto mode classifier blocked: an error result that names auto mode or its classifier. */
const CLASSIFIER_RE = /\bauto[ -]mode\b|\bclassifier\b/i;
const BLOCKED_RE = /\b(?:denied|blocked|refused|not allowed|rejected)\b/i;

function classifierBlocked(e: LogEvent): boolean {
  return e.kind === 'tool_result' && CLASSIFIER_RE.test(e.text) && BLOCKED_RE.test(e.text);
}

/**
 * The auto mode classifier asks a person after it blocked 3 calls in a row or 20 in the session: the
 * prompt follows blocked calls right before it (two at least, since the prompt may stand for the third),
 * or 19 in the session.
 */
function afterClassifierBlocks(events: readonly LogEvent[], index: number): boolean {
  const before = events.slice(0, index).filter((e) => e.kind === 'tool_result');
  let row = 0;
  for (let i = before.length - 1; i >= 0 && classifierBlocked(before[i] as LogEvent); i--) row++;
  return row >= 2 || before.filter(classifierBlocked).length >= 19;
}

// Text in a Bash call that Claude Code's own checks refuse to settle by a rule: substitutions and
// expansions, ANSI-C quoting, quotes inside a flag name, escaped blanks, more than one line, and
// characters that look like blanks.
const BASH_CHECK_RES: readonly RegExp[] = [
  /\$\(|`|<\(|>\(/,
  /\$\{/,
  /\$'/,
  /(?:^|\s)-{1,2}[\w-]*["']/,
  /\\[ \t;&|<>]/,
  /[\r\n]/,
  new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u00a0\\u1680\\u2000-\\u200f\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'),
];

// Files Claude Code protects in every mode: its own settings, the repository's metadata and shell
// start-up files; and paths with shell expansion syntax, which it cannot check.
const PROTECTED_PATH_RE = /(?:^|\/)(?:\.git\/|\.claude\/settings[^/]*\.json$|\.(?:bashrc|bash_profile|zshrc|zprofile|profile|gitconfig|gitmodules)$)/;
const EXPANSION_PATH_RE = /\$|%|^~[^/]|[`*?[\]{}]/;
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function claudeCodeCheck(tool: string, input: Record<string, unknown> | null): boolean {
  if (input === null) return false;
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : null;
    return command !== null && BASH_CHECK_RES.some((re) => re.test(command));
  }
  if (FILE_TOOLS.has(tool)) {
    const file = [input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === 'string');
    return file !== undefined && (PROTECTED_PATH_RE.test(file) || EXPANSION_PATH_RE.test(file));
  }
  return false;
}

/**
 * Why the prompt at `index` asks. Ask rules resolve first, the organization's above the repository's;
 * then the classifier's fallback, seen in the blocked calls before the prompt; then Claude Code's own
 * checks, seen in the call. A cut line, or a call none of these explain, is unknown.
 */
export function categorize(events: readonly LogEvent[], index: number, rules: AskRules): PermissionCategory {
  const e = events[index] as LogEvent;
  const tool = e.tool ?? 'unknown tool';
  const input = promptInput(tool, e.text);
  if (rules.org?.some((r) => askRuleCovers(r, tool, input))) return 'org_ask_rule';
  if (rules.repo?.some((r) => askRuleCovers(r, tool, input))) return 'repo_ask_rule';
  if (afterClassifierBlocks(events, index)) return 'classifier_block';
  if (claudeCodeCheck(tool, input)) return 'claude_code_check';
  return 'unknown';
}

export function describePermission(events: readonly LogEvent[], index: number, rules: AskRules = NO_RULES): PermissionRequest {
  const e = events[index] as LogEvent;
  return { tool: e.tool ?? 'unknown tool', category: categorize(events, index, rules), key: e.key, at: e.ts };
}

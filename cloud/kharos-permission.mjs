#!/usr/bin/env node
// kharos permission hook, version 3. `kharos permissions hook` copies this file into a repository as
// .claude/hooks/kharos-permission.mjs and rewrites it on every change: edit the rules in
// .claude/kharos-permissions.json instead.
//
// Claude Code runs it as a PermissionRequest hook, that is, only when a tool call is about to wait for a
// person's approval. It decides only in cloud sessions (CLAUDE_CODE_REMOTE=true), where no person
// watches the prompt; in any other session it says nothing and the prompt shows as usual.
//
// - A Bash call that is one simple command (no chaining, pipe, substitution, redirection, variable or
//   glob) and matches one of the rules file's allow patterns word by word is allowed.
// - The same for a mirrored rule: an ask rule of the organization's managed settings that the person
//   chose to turn into a cloud-only allow.
// - The same for a prefix rule, `Bash(<program> <subcommands>:*)` with literal words: it allows that
//   program, or that subcommand of it, with any arguments.
// - A broad rule (an allow pattern, a mirrored rule or a prefix rule for a shell, an interpreter, a wrapper or any
//   program) counts only when the rules file says `"broad": true`, which
//   kharos writes only when the person asked for broad rules with --broad.
// - Everything else is denied with a message that names the allowed forms, so the session sends the
//   right command or goes on without it instead of waiting.
// - With the unblock preset (`"unblock": true`, which kharos writes only after the person confirmed
//   what it opens), every prompt is allowed instead, of any tool, so no cloud session waits on a person.
// A deny rule is never reached: Claude Code blocks those calls before any prompt.
//
// No dependency, Node.js 18 or newer. The functions are exported so kharos tests them and reads the
// session log with the same matching.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_VERSION = 3;

/** The rules file, next to the hooks folder this script is in. */
export const RULES_FILE = 'kharos-permissions.json';

/** Longest command the hook allows, so the whole command fits in the session log kharos reads. */
export const MAX_ALLOWED_LENGTH = 600;

/** The rule an approval of the unblock preset names when no allow pattern or mirrored rule matched. */
export const UNBLOCK_RULE = 'unblock';

/** The start of every refusal, so a reader of the session log can tell the hook's refusals apart. */
export const REFUSAL_PREFIX = 'Refused by the kharos permission hook';

/**
 * @typedef {{ allow: string[], mirror: string[], prefix?: string[], broad?: boolean, unblock?: boolean }} HookRules
 * @typedef {{ ok: true, words: string[] } | { ok: false, why: string }} Split
 * @typedef {{ ok: true, words: (string | null)[] } | { ok: false, why: string }} Pattern
 * @typedef {{ behavior: 'allow', rule: string, source: 'allow' | 'mirror' | 'prefix' | 'unblock', broad: boolean }} Allow
 * @typedef {{ behavior: 'deny', message: string, program: string | null }} Deny
 * @typedef {Allow | Deny} Decision
 */

const OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')']);
const GLOBS = new Set(['*', '?', '[', ']', '{', '}', '~', '!']);

/**
 * Splits one shell command into its words, the way a POSIX shell would, and refuses anything that is
 * not a single simple command with literal words. With `pattern`, an unquoted `*` that is a whole word
 * is kept as a wildcard (null).
 * @param {string} text
 * @param {boolean} [pattern]
 * @returns {{ ok: true, words: (string | null)[] } | { ok: false, why: string }}
 */
function lex(text, pattern = false) {
  /** @type {(string | null)[]} */
  const words = [];
  let word = '';
  let started = false;
  let quoted = false;
  const end = () => {
    if (!started) return;
    words.push(pattern && !quoted && word === '*' ? null : word);
    word = '';
    started = false;
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = /** @type {string} */ (text[i]);
    if (c === ' ' || c === '\t') {
      end();
      continue;
    }
    if (c === '\n' || c === '\r') return { ok: false, why: 'it has more than one line' };
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return { ok: false, why: 'a quote is not closed' };
      word += text.slice(i + 1, close);
      started = true;
      quoted = true;
      i = close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j];
        if (d === '$' || d === '`') return { ok: false, why: 'it expands a variable or substitutes a command' };
        if (d === '\\') {
          const n = text[j + 1];
          if (n === undefined || n === '\n') return { ok: false, why: 'it has more than one line' };
          if (n === '$' || n === '`' || n === '"' || n === '\\') {
            word += n;
            j++;
            continue;
          }
        }
        word += d;
      }
      if (j >= text.length) return { ok: false, why: 'a quote is not closed' };
      started = true;
      quoted = true;
      i = j;
      continue;
    }
    if (c === '\\') {
      const n = text[i + 1];
      if (n === undefined || n === '\n' || n === '\r') return { ok: false, why: 'it has more than one line' };
      word += n;
      started = true;
      quoted = true;
      i++;
      continue;
    }
    if (OPERATORS.has(c)) return { ok: false, why: 'it is chained, piped, run in the background or redirected' };
    if (c === '$' || c === '`') return { ok: false, why: 'it expands a variable or substitutes a command' };
    if (c === '#' && !started) return { ok: false, why: 'it has a comment' };
    if (GLOBS.has(c)) {
      if (pattern && c === '*') {
        const prev = text[i - 1];
        const next = text[i + 1];
        const alone = !started && (next === undefined || next === ' ' || next === '\t');
        if (!alone || (prev !== undefined && prev !== ' ' && prev !== '\t')) return { ok: false, why: 'a wildcard stands for one whole word' };
        word = '*';
        started = true;
        continue;
      }
      return { ok: false, why: 'it has an unquoted wildcard, brace, tilde or exclamation mark' };
    }
    if (c === '=' && words.length === 0 && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
      return { ok: false, why: 'it sets a variable in front of the command' };
    }
    word += c;
    started = true;
  }
  end();
  if (words.length === 0) return { ok: false, why: 'it is empty' };
  return { ok: true, words };
}

/**
 * The words of a single simple command, or why it is not one.
 * @param {string} command
 * @returns {Split}
 */
export function splitCommand(command) {
  const r = lex(command, false);
  return r.ok ? { ok: true, words: /** @type {string[]} */ (r.words) } : r;
}

const RUNS_OTHERS = /^(?:.*\/)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|env|sudo|doas|su|xargs|eval|exec|command|builtin|nohup|nice|time|timeout|watch|ssh|python[\d.]*|node|deno|bun|ruby|perl|php|npx|pnpx|bunx|uvx)$/;

/** A program that runs other commands or code it is given: a shell, an interpreter or a wrapper.
 * @param {string} program */
export function runsOtherCommands(program) {
  return RUNS_OTHERS.test(program);
}

/**
 * Why an allow pattern would allow any command, or null when it is narrow: its program (first word) is
 * a wildcard, or runs other commands (a shell, an interpreter or a wrapper such as env, sudo or xargs).
 * @param {(string | null)[]} words
 */
export function broadPatternWhy(words) {
  const first = words[0];
  if (first === null || first === undefined) return 'its program is a wildcard';
  if (runsOtherCommands(first)) return `${first} runs other commands`;
  return null;
}

/**
 * An allow pattern: a simple command whose words must match exactly, where a `*` word stands for
 * exactly one word of any content. Unless `broad`, the program must be literal and must not run other
 * commands (see broadPatternWhy).
 * @param {string} text
 * @param {boolean} [broad]
 * @returns {Pattern}
 */
export function parsePattern(text, broad = false) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, why: 'it is empty' };
  if (text.length > 300) return { ok: false, why: 'it is longer than 300 characters' };
  const r = lex(text, true);
  if (!r.ok || broad) return r;
  const first = r.words[0];
  if (first === null || first === undefined) return { ok: false, why: 'the program must be written out, not a wildcard' };
  if (runsOtherCommands(first)) return { ok: false, why: `${first} runs other commands, so a rule for it would allow anything` };
  return r;
}

/**
 * Why a Bash permission rule in Claude Code syntax would allow any command, or null when it names a
 * program that does not run other commands. Null for a rule of another tool.
 * @param {string} rule
 */
export function broadRuleWhy(rule) {
  if (rule === 'Bash') return 'it covers every command';
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return null;
  const body = /** @type {string} */ (m[1]).trim();
  if (body.replace(/[*:\s]/g, '') === '') return 'it covers every command';
  const program = /** @type {string} */ (body.split(/[\s:]/)[0]);
  if (program.includes('*')) return 'it does not name its program';
  if (runsOtherCommands(program)) return `${program} runs other commands, so an allow would cover anything`;
  return null;
}

/**
 * @param {string[]} words
 * @param {(string | null)[]} pattern
 */
export function matchesPattern(words, pattern) {
  return words.length === pattern.length && pattern.every((p, i) => p === null || p === words[i]);
}

/** A pattern as the session reads it in a refusal: each wildcard shows as <arg>.
 * @param {(string | null)[]} pattern */
export function showPattern(pattern) {
  return pattern.map((w) => (w === null ? '<arg>' : /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/**
 * Whether a Bash permission rule in Claude Code syntax, such as `Bash(psql:*)`, `Bash(npm test)` or
 * `Bash(*.example.com*)`, matches the text of a single simple command. `*` matches any characters, and
 * a trailing ` *` or `:*` also matches the command with nothing after it.
 * @param {string} rule
 * @param {string} command
 */
export function bashRuleMatches(rule, command) {
  if (rule === 'Bash') return command.trim() !== '';
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return false;
  let body = /** @type {string} */ (m[1]);
  let tail = '';
  if (body.endsWith(':*')) {
    body = body.slice(0, -2);
    tail = '(?: .*)?';
  } else if (body.endsWith(' *')) {
    body = body.slice(0, -2);
    tail = '(?: .*)?';
  }
  if (body === '') return false;
  const re = body
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}${tail}$`, 's').test(command.trim());
}

/**
 * Why a prefix rule is not valid, or null when it is: it must be `Bash(<words>:*)`, its words literal
 * (no wildcard), and, unless `broad`, its program must not run other commands.
 * @param {string} rule
 * @param {boolean} [broad]
 */
export function prefixRuleWhy(rule, broad = false) {
  const m = /^Bash\((.+):\*\)$/s.exec(rule);
  if (!m) return 'a prefix rule has the form Bash(<program> <subcommands>:*)';
  const words = /** @type {string} */ (m[1]).split(' ');
  if (words.some((w) => !/^[\w@%+=:,./-]+$/.test(w))) return 'its words must be literal: no wildcard, quote or extra space';
  if (broad) return null;
  const why = broadRuleWhy(rule);
  return why ? `it is broad (${why})` : null;
}

/** The literal words a prefix rule starts a command with.
 * @param {string} rule */
export function prefixOf(rule) {
  return rule.replace(/^Bash\(/, '').replace(/:\*\)$/, '');
}

/**
 * The rules file's content, checked. Invalid allow patterns and prefix rules, non-Bash mirrored rules, and broad rules
 * without `"broad": true` are an error: kharos writes the file, and a hand edit that breaks it must
 * show, not half work.
 * @param {unknown} value
 * @returns {HookRules}
 */
export function readHookRules(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the rules file must hold a JSON object');
  const o = /** @type {Record<string, unknown>} */ (value);
  if (o.version !== 1) throw new Error('"version" must be 1');
  /** @param {unknown} v @param {string} where @returns {string[]} */
  const list = (v, where) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`"${where}" must be a list of strings`);
    return /** @type {string[]} */ (v);
  };
  if (o.broad !== undefined && typeof o.broad !== 'boolean') throw new Error('"broad" must be true or false');
  if (o.unblock !== undefined && typeof o.unblock !== 'boolean') throw new Error('"unblock" must be true or false');
  const broad = o.broad === true;
  const allow = list(o.allow, 'allow');
  for (const p of allow) {
    const r = parsePattern(p, broad);
    if (!r.ok) throw new Error(`allow pattern "${p}" is not valid: ${r.why}`);
  }
  const mirror = list(o.mirror, 'mirror');
  for (const r of mirror) {
    if (r !== 'Bash' && !/^Bash\(.+\)$/s.test(r)) throw new Error(`mirrored rule "${r}" is not a Bash rule`);
    const why = broad ? null : broadRuleWhy(r);
    if (why) throw new Error(`mirrored rule "${r}" is broad (${why}), and the rules file does not say "broad": true`);
  }
  const prefix = list(o.prefix, 'prefix');
  for (const r of prefix) {
    const why = prefixRuleWhy(r, broad);
    if (why) throw new Error(`prefix rule "${r}" is not valid: ${why}${why.startsWith('it is broad') ? ', and the rules file does not say "broad": true' : ''}`);
  }
  /** @type {HookRules} */
  const out = broad ? { allow, mirror, broad } : { allow, mirror };
  if (prefix.length) out.prefix = prefix;
  if (o.unblock === true) out.unblock = true;
  return out;
}

/** @param {string} tool */
function generic(tool) {
  return (
    `${REFUSAL_PREFIX}: this ${tool} call needs a person's approval, and nobody answers permission prompts in this cloud session. ` +
    'Go on without it, or stop and say what you need (a session launched by kharos ends with a KHAROS-QUESTION line).'
  );
}

/**
 * The programs that allow patterns name, found anywhere in a command, even one that is not simple.
 * @param {string} command
 * @param {(string | null)[][]} patterns
 */
function namedPrograms(command, patterns) {
  const rough = command.split(/[\s;&|()<>`$"']+/).filter(Boolean);
  const programs = patterns.flatMap((p) => (typeof p[0] === 'string' ? [p[0]] : []));
  return [...new Set(programs)].filter((prog) => rough.includes(prog));
}

/**
 * What the hook answers to one permission request.
 * @param {{ tool_name?: unknown, tool_input?: unknown }} input
 * @param {HookRules | { error: string }} rules
 * @returns {Decision}
 */
export function decide(input, rules) {
  const tool = typeof input.tool_name === 'string' && input.tool_name !== '' ? input.tool_name : 'tool';
  if ('error' in rules) {
    return { behavior: 'deny', program: null, message: `${REFUSAL_PREFIX}: its rules file cannot be used (${rules.error}), so it allows nothing. Go on without this call, or stop and say what you need.` };
  }
  const ti = typeof input.tool_input === 'object' && input.tool_input !== null ? /** @type {Record<string, unknown>} */ (input.tool_input) : {};
  const command = typeof ti.command === 'string' ? ti.command : null;
  if (rules.unblock === true) {
    // Every prompt is allowed; a rule that matches still names itself, so the log shows which.
    const d = tool === 'Bash' && command !== null ? decide(input, { ...rules, unblock: false }) : null;
    return d !== null && d.behavior === 'allow' ? d : { behavior: 'allow', rule: UNBLOCK_RULE, source: 'unblock', broad: true };
  }
  if (tool !== 'Bash' || command === null) return { behavior: 'deny', program: null, message: generic(tool) };

  const broad = rules.broad === true;
  /** @type {{ text: string, words: (string | null)[] }[]} */
  const patterns = rules.allow.flatMap((text) => {
    const r = parsePattern(text, broad);
    return r.ok ? [{ text, words: r.words }] : [];
  });
  const split = splitCommand(command);
  let why = split.ok ? null : split.why;
  if (split.ok && command.length > MAX_ALLOWED_LENGTH) why = `it is longer than ${MAX_ALLOWED_LENGTH} characters`;
  if (split.ok && why === null) {
    const hit = patterns.find((p) => matchesPattern(split.words, p.words));
    if (hit !== undefined) return { behavior: 'allow', rule: hit.text, source: 'allow', broad: broadPatternWhy(hit.words) !== null };
    // Only a broad rule, in a rules file that allows broad rules, covers a program that runs other commands.
    const others = runsOtherCommands(/** @type {string} */ (split.words[0]));
    /** @param {string} r */
    const covers = (r) => bashRuleMatches(r, command) && (!others || (broad && broadRuleWhy(r) !== null));
    const mirrored = rules.mirror.find(covers);
    if (mirrored !== undefined) return { behavior: 'allow', rule: mirrored, source: 'mirror', broad: broadRuleWhy(mirrored) !== null };
    const prefixed = (rules.prefix ?? []).find(covers);
    if (prefixed !== undefined) return { behavior: 'allow', rule: prefixed, source: 'prefix', broad: broadRuleWhy(prefixed) !== null };
  }

  const first = split.ok ? split.words[0] : undefined;
  const programs = namedPrograms(command, patterns.map((p) => p.words)).sort((a, b) => Number(b === first) - Number(a === first));
  if (programs.length === 0) {
    if (why !== null && (rules.mirror.length > 0 || (rules.prefix ?? []).length > 0)) {
      return {
        behavior: 'deny',
        program: null,
        message: `${REFUSAL_PREFIX}: nobody answers permission prompts in this cloud session, and the hook allows only a single simple command (${why}). If this command is one the rules allow, send it again alone in its own call: no cd before it, no variable in front, and nothing chained, piped or redirected.`,
      };
    }
    return { behavior: 'deny', program: null, message: generic(tool) };
  }
  const program = /** @type {string} */ (programs[0]);
  const forms = patterns.filter((p) => p.words[0] === program).map((p) => `\`${showPattern(p.words)}\``);
  const reason = why === null ? '' : ` This call was refused because ${why}.`;
  return {
    behavior: 'deny',
    program,
    message:
      `${REFUSAL_PREFIX}: nobody answers permission prompts in this cloud session, so ${program} runs here only in ${forms.length === 1 ? 'this form' : 'these forms'}: ${forms.join(', ')} (each <arg> is one argument).${reason} ` +
      'Send it again in that form, alone in its own call: no cd before it, no variable in front, and nothing chained, piped or redirected.',
  };
}

/**
 * The hook's JSON answer for a decision.
 * @param {Decision} d
 */
export function hookOutput(d) {
  if (d.behavior === 'allow') {
    return {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      systemMessage:
        d.source === 'unblock'
          ? 'kharos permission hook allowed this call by its unblock preset, which allows every prompt in cloud sessions on this repository'
          : `kharos permission hook allowed this call by ${d.broad ? 'the broad ' : 'the '}${d.source === 'mirror' ? 'mirrored organization rule' : d.source === 'prefix' ? 'prefix rule' : 'rule'} ${d.rule}`,
    };
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: d.message } } };
}

/**
 * The rules next to this script, or why they cannot be used.
 * @param {string} file
 * @returns {HookRules | { error: string }}
 */
export function loadHookRules(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `${path.basename(file)} cannot be read: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'}` };
  }
  try {
    return readHookRules(JSON.parse(text));
  } catch (err) {
    return { error: `${path.basename(file)}: ${/** @type {Error} */ (err).message}` };
  }
}

async function main() {
  if (process.env.CLAUDE_CODE_REMOTE !== 'true') return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  /** @type {unknown} */
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof input !== 'object' || input === null) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const d = decide(/** @type {Record<string, unknown>} */ (input), loadHookRules(path.join(here, '..', RULES_FILE)));
  process.stdout.write(JSON.stringify(hookOutput(d)) + '\n');
}

/** Whether Node.js runs this file itself (not an import); the main module's URL has its links resolved. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();

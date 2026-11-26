// The routine body sent to RemoteTrigger `create`, and the protocol footer appended to the instruction.
// The body shape is not in the public tool reference; it is kept here, in one place, and matches what
// the service accepted in practice (name, enabled and run_once_at at the top level).

import crypto from 'node:crypto';
import type { Profile } from './config.ts';

export const DONE_MARK = 'KHAROS-DONE';
export const QUESTION_MARK = 'KHAROS-QUESTION';

/** Local guard on the instruction size; the service limit is not published. */
export const MAX_INSTRUCTION_CHARS = 50_000;

/**
 * A run date one year ahead: the routine is created disabled, so it never fires by itself, and a date
 * in the near years is one the service accepts.
 */
export function parkedRunAt(now: number): string {
  const d = new Date(now + 365 * 24 * 3600_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

/** The service cuts each message of the log the monitor reads: a long report goes where it stays whole. */
export const LENGTH_LINE =
  '- The monitor reads a log that cuts each message to about 2000 characters: put a long report in the pull request description or in a file on your branch, and keep each message, the last one included, shorter than that.';

/** The footer line a `--no-push` launch leaves out. */
export const PUSH_LINE = '- Commit and push work in progress at least every 30 minutes: an idle cloud machine can be paused and reclaimed.';

/** The protocol footer; `push` false leaves out the line that asks the session to push work in progress. */
export function footer(extraLines: readonly string[] = [], push = true): string {
  return [
    '',
    '---',
    'Protocol of the session monitor that follows this session (it reads your log):',
    `- When the work is truly finished and nothing runs in the background, send one last message that contains only this line, with no other text:`,
    `${DONE_MARK} {"status":"ok|failed","pr":"<url or null>","branch":"<name or null>","summary":"<up to 200 characters>"}`,
    `- If you need an answer to go on, send one last message that contains only this line, then stop and wait for the reply:`,
    `${QUESTION_MARK} {"question":"<up to 300 characters>"}`,
    LENGTH_LINE,
    ...(push ? [PUSH_LINE] : []),
    ...extraLines,
  ].join('\n');
}

/**
 * What a session that starts on a per-launch side branch must know: the branch is the base plus one
 * commit that only adds the permission hook, it goes away at close, and nothing pushed may carry it.
 */
export function sideBranchLines(branch: string, base: string, commit: string): string[] {
  return [
    `- This session starts on branch ${branch}: ${base} plus one commit, ${commit}, that only adds the kharos permission hook for this session. kharos deletes ${branch} when the session is closed, so never push to it.`,
    `- Do the work on a branch of your own. Before you open a pull request, take that commit out of your branch: run \`git fetch origin ${base}\` and then \`git rebase --onto FETCH_HEAD ${commit}\`, push the branch again with --force-with-lease, and open the pull request against ${base}.`,
  ];
}

export interface BodyInput {
  id: string;
  title: string;
  instruction: string;
  profile: Profile;
  model: string;
  /** Extra protocol lines, such as the session sheet a dedicated firstmate task needs. */
  footerLines?: readonly string[];
  /** false leaves out the footer line that asks the session to push work in progress (`--no-push`). */
  push?: boolean;
  uuid?: string;
  now: number;
}

export function buildCreateBody(input: BodyInput): Record<string, unknown> {
  const { profile } = input;
  const body: Record<string, unknown> = {
    name: `kharos ${input.id}: ${input.title}`.slice(0, 200),
    enabled: false,
    run_once_at: parkedRunAt(input.now),
    job_config: {
      ccr: {
        environment_id: profile.environment,
        session_context: {
          model: input.model,
          allowed_tools: profile.allowed_tools,
          sources: [{ git_repository: { url: profile.repo, revision: profile.revision } }],
        },
        events: [
          {
            data: {
              uuid: input.uuid ?? crypto.randomUUID(),
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: { role: 'user', content: input.instruction + '\n' + footer(input.footerLines ?? [], input.push ?? true) },
            },
          },
        ],
      },
    },
  };
  if (!profile.connectors) body.clear_mcp_connections = true;
  return body;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Removes control characters and cuts a remote string before it reaches an event or a person. */
export function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Extracts the JSON object that follows a mark in a text, or null when there is none or it is cut. */
export function parseMark(text: string, mark: string): Record<string, unknown> | null {
  const at = text.lastIndexOf(mark + ' {');
  if (at < 0) return null;
  const start = at + mark.length + 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1)) as unknown;
          return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function nullableString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = clean(v, max);
  if (t === '' || t === 'null') return null;
  return t;
}

/** A branch name safe to show inside a git command: a plain ref name, or null. */
export function gitBranch(b: string | null): string | null {
  if (!b || !/^[A-Za-z0-9._/-]{1,200}$/.test(b)) return null;
  if (b.startsWith('-') || b.includes('..') || b.endsWith('.lock') || b.endsWith('/')) return null;
  return b;
}

/** The longest session sheet kept: a longer one is treated as missing, never cut, since firstmate parses it. */
export const SHEET_MAX = 600;

export interface DoneMark {
  status: 'ok' | 'failed';
  pr: string | null;
  branch: string | null;
  summary: string | null;
  /** Only asked of launches reported to a dedicated firstmate task. */
  sheet: string | null;
}

function wholeSheet(sheet: string | null): string | null {
  return sheet !== null && sheet.length <= SHEET_MAX ? sheet : null;
}

export function readDoneMark(text: string): DoneMark | null {
  const m = parseMark(text, DONE_MARK);
  if (!m) return null;
  const status = m.status === 'ok' || m.status === 'failed' ? m.status : null;
  if (!status) return null;
  const pr = nullableString(m.pr, 300);
  return {
    status,
    pr: pr && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr) ? pr : null,
    branch: gitBranch(nullableString(m.branch, 200)),
    summary: nullableString(m.summary, 200),
    sheet: wholeSheet(nullableString(m.sheet, Infinity)),
  };
}

export function readQuestionMark(text: string): string | null {
  const m = parseMark(text, QUESTION_MARK);
  if (!m) return null;
  return nullableString(m.question, 300);
}

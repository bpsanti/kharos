// The log of the kharos permission hook's decisions. The hook runs in the cloud session, where kharos
// state does not exist, so the watcher writes the log here: each `permission prompt` line of a session
// whose branch had the hook at launch goes through the same decision code the hook runs, with the rules
// read from that branch. A line records the time, the session, the tool, the decision and the rule that
// matched; never the command or any other input of the call.

import fs from 'node:fs';
import { decide, type HookRules } from '../cloud/kharos-permission.mjs';
import { appendLine } from './fsutil.ts';
import type { LogEvent } from './logparse.ts';
import type { Paths } from './paths.ts';
import { isPermissionPrompt } from './classify.ts';
import type { Session } from './registry.ts';

export interface HookDecision {
  at: string;
  kharos: string;
  session_id: string | null;
  tool: string;
  decision: 'allow' | 'deny';
  /** The allow pattern, prefix rule or mirrored organization rule that matched, or `unblock` for the unblock preset; null for a denial. */
  rule: string | null;
  source: 'allow' | 'mirror' | 'prefix' | 'unblock' | null;
  /** For an approval: whether the rule that matched is broad (it allows any command it covers). Absent in lines from before kharos marked them. */
  broad?: boolean;
  /** For a denial: the program whose allowed forms the refusal named, if any. */
  program: string | null;
}

/** The command of a Bash permission prompt line, also when the service cut the end of the line. */
export function promptCommand(text: string): string | null {
  try {
    const v = JSON.parse(text) as { command?: unknown };
    return typeof v.command === 'string' ? v.command : null;
  } catch {
    const m = /^\{"command":"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return null;
    }
  }
}

/** The hook's decisions behind new permission prompt lines of a session, appended to the log. */
export function recordHookDecisions(paths: Paths, s: Session, added: readonly LogEvent[]): HookDecision[] {
  const rules: HookRules | null | undefined = s.permission_hook;
  if (!rules) return [];
  const out: HookDecision[] = [];
  for (const e of added) {
    if (!isPermissionPrompt(e)) continue;
    const tool = e.tool ?? 'unknown tool';
    const input = tool === 'Bash' ? { command: promptCommand(e.text) } : {};
    // A Bash line too cut to show its command cannot be attributed to a rule; only the unblock preset allows it.
    if (tool === 'Bash' && input.command === null && rules.unblock !== true) continue;
    const d = decide({ tool_name: tool, tool_input: input }, rules);
    out.push({
      at: e.ts,
      kharos: s.id,
      session_id: s.session_id,
      tool,
      decision: d.behavior,
      rule: d.behavior === 'allow' ? d.rule : null,
      source: d.behavior === 'allow' ? d.source : null,
      broad: d.behavior === 'allow' && d.broad,
      program: d.behavior === 'deny' ? d.program : null,
    });
  }
  for (const d of out) appendLine(paths.approvals, JSON.stringify(d));
  return out;
}

export function readHookDecisions(paths: Paths): HookDecision[] {
  let text: string;
  try {
    text = fs.readFileSync(paths.approvals, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: HookDecision[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as HookDecision);
    } catch {
      // a torn last line from a crash
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface ApprovalQuery {
  /** Also list the denials. */
  all: boolean;
  /** Only this kharos session (k-0001). */
  session: string | null;
  limit: number;
}

export function formatHookDecisions(paths: Paths, q: ApprovalQuery): string {
  const rows = readHookDecisions(paths).filter((d) => (q.all || d.decision === 'allow') && (q.session === null || d.kharos === q.session));
  if (rows.length === 0) {
    return `no ${q.all ? 'decision' : 'approval'} of the kharos permission hook is logged${q.session ? ` for ${q.session}` : ''} (${paths.approvals})`;
  }
  const shown = rows.slice(-q.limit);
  const lines = shown.map((d) => {
    const what =
      d.decision !== 'allow'
        ? `denied${d.program ? ` (refusal named the forms of ${d.program})` : ''}`
        : d.source === 'unblock'
          ? 'allowed by the unblock preset (no rule matched; every prompt is allowed)'
          : `allowed by ${d.broad ? 'broad ' : ''}${d.source === 'mirror' ? 'mirrored organization rule' : d.source === 'prefix' ? 'prefix rule' : 'allow pattern'} ${d.rule}`;
    return `${d.at.slice(0, 19)}Z  ${d.kharos}  ${d.tool}  ${what}`;
  });
  const head = `${rows.length} ${q.all ? 'decision(s)' : 'approval(s)'} of the kharos permission hook, as the watcher read them from the session logs${shown.length < rows.length ? `; the last ${shown.length}` : ''}:`;
  return [head, ...lines].join('\n');
}

// The condensed run log that RemoteTrigger get_run_log returns: one line per event, flattened to a
// single line and cut to about a thousand characters, newest 200 events per page.
//   [2026-11-25T18:57:41.184593Z] tool_use Bash: {"command":"..."}
// The format is not in the public reference, so this parser keeps unknown kinds as they are, and the
// classifier never reads an unknown kind as progress or as an end.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { appendLine } from './fsutil.ts';

export interface LogEvent {
  t: number;
  ts: string;
  kind: string;
  tool: string | null;
  text: string;
  /** The service cut the text: the end of it is missing. */
  truncated: boolean;
  key: string;
  seq: number;
}

export interface LogPage {
  events: LogEvent[];
  /** The page says older events exist: it does not reach the start of the session. */
  partial: boolean;
}

const LINE_RE = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\] ([a-z_]+(?:\[[a-z_]+\])?)(?: ([\w.-]+))?: ?(.*)$/;
const CUT_RE = /… \[\+\d+ chars\]$/;

function eventKey(ts: string, kind: string, tool: string | null, text: string): string {
  return `${ts}|${kind}|${tool ?? ''}|${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
}

export function parseLog(summary: string): LogPage {
  const events: LogEvent[] = [];
  let partial = false;
  for (const line of summary.split('\n')) {
    if (/^\(older events exist/.test(line)) {
      partial = true;
      continue;
    }
    const m = line.match(LINE_RE);
    if (!m) {
      const last = events[events.length - 1];
      if (last && line.trim() !== '' && !line.startsWith('(')) last.text += ' ' + line.trim();
      continue;
    }
    const ts = m[1] as string;
    const kind = m[2] as string;
    const tool = m[3] ?? null;
    const text = m[4] ?? '';
    events.push({ t: Date.parse(ts), ts, kind, tool, text, truncated: CUT_RE.test(text), key: '', seq: events.length });
  }
  for (const e of events) e.key = eventKey(e.ts, e.kind, e.tool, e.text);
  return { events, partial };
}

export function readStoredEvents(file: string): LogEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: LogEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // A torn last line from a crash: the next read stores the event again.
    }
  }
  return sortEvents(out);
}

export function sortEvents(events: LogEvent[]): LogEvent[] {
  return events.sort((a, b) => a.t - b.t || a.seq - b.seq);
}

export interface MergeResult {
  all: LogEvent[];
  added: LogEvent[];
  /** The page is partial and its oldest event is newer than every stored one: events are missing between them. */
  gap: boolean;
}

/** Adds a page to the stored events of a session, appending only the new ones to its file. */
export function mergePage(file: string, page: LogPage): MergeResult {
  const stored = readStoredEvents(file);
  const known = new Set(stored.map((e) => e.key));
  const newestStored = stored.length ? (stored[stored.length - 1] as LogEvent).t : null;
  const oldestPage = page.events.length ? Math.min(...page.events.map((e) => e.t)) : null;
  const gap = page.partial && newestStored !== null && oldestPage !== null && oldestPage > newestStored;
  const base = stored.length ? Math.max(...stored.map((e) => e.seq)) + 1 : 0;
  const added: LogEvent[] = [];
  for (const e of page.events) {
    if (known.has(e.key)) continue;
    known.add(e.key);
    const ev = { ...e, seq: base + e.seq };
    added.push(ev);
    appendLine(file, JSON.stringify(ev));
  }
  return { all: sortEvents([...stored, ...added]), added, gap };
}

/** A short line for a person: the kind, the tool and the start of the text, never the whole event. */
export function condensedLine(e: LogEvent, max = 160): string {
  const head = `${e.ts.slice(11, 19)} ${e.kind}${e.tool ? ' ' + e.tool : ''}`;
  // eslint-disable-next-line no-control-regex
  const text = e.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return `${head}: ${text.length > max ? text.slice(0, max - 1) + '…' : text}`;
}

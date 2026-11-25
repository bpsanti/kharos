// What a pending permission prompt asks for, in a form fit to go out in an event: the tool and a short
// summary of its input with secrets taken out. The log line is `permission prompt <Tool>: {<input>}`,
// cut by the service at about a thousand characters, so the input may be JSON that never closes.
// Only fields known to name the action are read (the command, the file, the URL, the pattern); for any
// other tool the summary lists the input's field names and no value.

import { clean } from './body.ts';
import type { LogEvent } from './logparse.ts';

export const REQUEST_MAX = 120;

export interface PermissionRequest {
  tool: string;
  /** The redacted summary of what the tool would do; empty when the input could not be read. */
  request: string;
  /** The log event of the prompt, so a new prompt can be told from the one already reported. */
  key: string;
  at: string;
}

const FIELDS: Record<string, string[]> = {
  Bash: ['command'],
  PowerShell: ['command'],
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
};

const ELLIPSIS = '…';

/** Takes secrets out of a command line or a value: environment assignments, credentials, tokens. */
export function redact(text: string): string {
  return (
    text
      // NAME=value at the start of a command, after a separator, or after export/env/set
      .replace(/(^|[\s;&|(]|\bexport\s+|\benv\s+)([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s;&|)]+)/g, (_m, pre: string, name: string) => `${pre}${name}=${ELLIPSIS}`)
      // credentials inside a URL
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${ELLIPSIS}@`)
      // the query of a URL, where tokens often travel
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+)\?[^\s#"']*/gi, `$1?${ELLIPSIS}`)
      // authorization and cookie headers
      .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|private-token)(\s*[:=]\s*)("[^"]*"?|'[^']*'?|.*?)(?=["']|$)/gi, `$1$2${ELLIPSIS}`)
      .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${ELLIPSIS}`)
      // flags whose name says they carry a secret
      .replace(/(--?[\w-]*(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|credential)[\w-]*)(=|\s+)("[^"]*"?|'[^']*'?|[^\s;&|)]+)/gi, `$1$2${ELLIPSIS}`)
      // known token shapes, then any long opaque run of characters
      .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|sk_live_|rk_live_|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}/g, ELLIPSIS)
      .replace(/[A-Za-z0-9_+=]{32,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? ELLIPSIS : m))
  );
}

/** The value of one string field of a JSON object that may be cut before its end. */
function field(text: string, name: string): string | null {
  try {
    const o = JSON.parse(text) as unknown;
    if (typeof o === 'object' && o !== null && !Array.isArray(o)) {
      const v = (o as Record<string, unknown>)[name];
      return typeof v === 'string' ? v : null;
    }
  } catch {
    // cut by the service: read the field by hand below
  }
  const m = text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`));
  if (!m) return null;
  const body = m[1] as string;
  let value: string;
  try {
    value = JSON.parse(`"${body}"`) as string;
  } catch {
    value = body.replace(/\\(.)/g, '$1');
  }
  return m[2] ? value : value + ELLIPSIS;
}

/** The field names of the input, for a tool whose values are not read. */
function fieldNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/(?:^\{|,)\s*"([A-Za-z_][\w-]{0,40})"\s*:/g)) {
    if (!names.includes(m[1] as string)) names.push(m[1] as string);
  }
  return names;
}

export function summarizeRequest(tool: string | null, input: string): string {
  const fields = tool ? FIELDS[tool] : undefined;
  if (fields) {
    const values = fields.map((f) => field(input, f)).filter((v): v is string => v !== null && v !== '');
    return clean(redact(values.join(' in ')), REQUEST_MAX);
  }
  const names = fieldNames(input);
  return names.length ? clean(`input fields: ${names.join(', ')}`, REQUEST_MAX) : '';
}

export function describePermission(e: LogEvent): PermissionRequest {
  return { tool: e.tool ?? 'unknown tool', request: summarizeRequest(e.tool, e.text), key: e.key, at: e.ts };
}

// Reading what the RemoteTrigger tool returns. Its answers reach hooks as {status, json, summary}:
// `status` is the HTTP status, `json` the raw API body as a string, and `summary` an extra text (the
// condensed log for get_run_log). None of this shape is in the public tool reference, so it is read
// defensively here and anything unknown is reported as unreadable, never as progress.

export interface ToolResponse {
  status: number | null;
  json: unknown;
  jsonText: string;
  summary: string;
}

export function readToolResponse(raw: unknown): ToolResponse {
  if (typeof raw === 'string') {
    const m = raw.match(/^HTTP (\d{3})\n([\s\S]*)$/);
    if (m) return withJson(Number(m[1]), m[2] ?? '', '');
    return { status: null, json: undefined, jsonText: raw, summary: '' };
  }
  if (typeof raw !== 'object' || raw === null) return { status: null, json: undefined, jsonText: '', summary: '' };
  const o = raw as Record<string, unknown>;
  const status = typeof o.status === 'number' ? o.status : null;
  const summary = typeof o.summary === 'string' ? o.summary : '';
  if (typeof o.json === 'string') return withJson(status, o.json, summary);
  return { status, json: o.json, jsonText: JSON.stringify(o.json ?? null), summary };
}

function withJson(status: number | null, text: string, summary: string): ToolResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status, json, jsonText: text, summary };
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export interface ApiError {
  status: number | null;
  type: string | null;
  reason: string | null;
  message: string | null;
}

/** The error of a non-2xx answer, with the sub-reason the service gives (such as repo_access_denied). */
export function readError(r: ToolResponse): ApiError | null {
  if (r.status !== null && r.status >= 200 && r.status < 300) return null;
  const body = rec(r.json);
  const err = rec(body?.error);
  const reason =
    (typeof err?.sub_reason === 'string' && err.sub_reason) ||
    (typeof err?.reason === 'string' && err.reason) ||
    (r.jsonText.match(/"sub_reason"\s*:\s*"([\w.-]+)"/)?.[1] ?? null);
  return {
    status: r.status,
    type: typeof err?.type === 'string' ? err.type : null,
    reason: reason || null,
    message: typeof err?.message === 'string' ? err.message : null,
  };
}

/** The trigger id of a create answer. */
export function readCreatedTrigger(r: ToolResponse): string | null {
  const body = rec(r.json);
  const trig = rec(body?.trigger);
  const id = trig?.id ?? body?.id;
  return typeof id === 'string' && /^trig_\w+$/.test(id) ? id : (r.jsonText.match(/"id"\s*:\s*"(trig_\w+)"/)?.[1] ?? null);
}

const SESSION_ID_RE = /\b((?:cse|session)_[A-Za-z0-9]{10,})\b/;

/** The session id a `run` answer carries: the service answers with the new session right away. */
export function readRunSession(r: ToolResponse): string | null {
  const body = rec(r.json);
  for (const key of ['session_id', 'id']) {
    const v = body?.[key];
    if (typeof v === 'string' && SESSION_ID_RE.test(v)) return v;
  }
  const nested = rec(body?.session) ?? rec(body?.run) ?? rec(body?.last_run);
  for (const key of ['session_id', 'id']) {
    const v = nested?.[key];
    if (typeof v === 'string' && SESSION_ID_RE.test(v)) return v;
  }
  return (r.jsonText.match(SESSION_ID_RE)?.[1] ?? r.summary.match(SESSION_ID_RE)?.[1]) || null;
}

export interface RunRow {
  id: string;
  status: string | null;
  worker_status: string | null;
  created_at: string | null;
  url: string | null;
}

export function readRuns(r: ToolResponse): RunRow[] | null {
  const body = rec(r.json);
  if (!body || !Array.isArray(body.data)) return null;
  const rows: RunRow[] = [];
  for (const x of body.data) {
    const o = rec(x);
    if (!o || typeof o.id !== 'string') continue;
    rows.push({
      id: o.id,
      status: typeof o.status === 'string' ? o.status : null,
      worker_status: typeof o.worker_status === 'string' ? o.worker_status : null,
      created_at: typeof o.created_at === 'string' ? o.created_at : null,
      url: typeof o.url === 'string' && o.url.startsWith('https://claude.ai/') ? o.url : null,
    });
  }
  return rows;
}

export interface LogHeader {
  session_id: string | null;
  events_fetched: number | null;
  events_shown: number | null;
  next_cursor: string | null;
}

export function readLogHeader(r: ToolResponse): LogHeader | null {
  const body = rec(r.json);
  if (!body) return null;
  return {
    session_id: typeof body.session_id === 'string' ? body.session_id : null,
    events_fetched: typeof body.events_fetched === 'number' ? body.events_fetched : null,
    events_shown: typeof body.events_shown === 'number' ? body.events_shown : null,
    next_cursor: typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : null,
  };
}

export interface EnvironmentUse {
  id: string;
  routines: number;
  last_used: string | null;
}

/** Cloud environments the account's routines use, most recently used first: the tool has no list of environments. */
export function readEnvironments(r: ToolResponse): EnvironmentUse[] | null {
  const body = rec(r.json);
  if (!body || !Array.isArray(body.data)) return null;
  const seen = new Map<string, EnvironmentUse>();
  for (const x of body.data) {
    const o = rec(x);
    const ccr = rec(rec(o?.job_config)?.ccr);
    const env = ccr?.environment_id ?? rec(o?.session_request)?.environment_id;
    if (typeof env !== 'string' || !/^env_\w+$/.test(env)) continue;
    const when = [o?.last_fired_at, o?.updated_at, o?.created_at].find((v): v is string => typeof v === 'string') ?? null;
    const cur = seen.get(env) ?? { id: env, routines: 0, last_used: null };
    cur.routines++;
    if (when && (!cur.last_used || when > cur.last_used)) cur.last_used = when;
    seen.set(env, cur);
  }
  return [...seen.values()].sort((a, b) => (b.last_used ?? '').localeCompare(a.last_used ?? ''));
}

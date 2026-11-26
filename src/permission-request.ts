// Which tool a pending permission prompt is for. The log line is `permission prompt <Tool>: {<input>}`;
// only the tool name goes out in an event, never the input (the command, the file, the URL, the query).

import type { LogEvent } from './logparse.ts';

export interface PermissionRequest {
  tool: string;
  /** The log event of the prompt, so a new prompt can be told from the one already reported. */
  key: string;
  at: string;
}

export function describePermission(e: LogEvent): PermissionRequest {
  return { tool: e.tool ?? 'unknown tool', key: e.key, at: e.ts };
}

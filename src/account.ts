// The account a launch belongs to, read from `claude auth status` of the official binary.
// Only a hash is kept: the binary shows no token, and no field of its output is stored in clear.

import { spawnSync } from 'node:child_process';
import { sha256 } from './body.ts';

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  account: string | null;
}

export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.KHAROS_CLAUDE_BIN || 'claude';
}

/** Parses `claude auth status` JSON output into what kharos needs. */
export function parseAuthStatus(raw: string): AuthStatus {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { loggedIn: false, authMethod: null, subscriptionType: null, account: null };
  }
  const org = typeof v.orgId === 'string' ? v.orgId : '';
  const email = typeof v.email === 'string' ? v.email : '';
  return {
    loggedIn: v.loggedIn === true,
    authMethod: typeof v.authMethod === 'string' ? v.authMethod : null,
    subscriptionType: typeof v.subscriptionType === 'string' ? v.subscriptionType : null,
    // Organization and login together: two people in the same organization see different routines.
    account: org || email ? 'sha256:' + sha256(`${org}\n${email}`).slice(0, 32) : null,
  };
}

export function readAuthStatus(env: NodeJS.ProcessEnv = process.env): AuthStatus | null {
  const r = spawnSync(claudeBin(env), ['auth', 'status'], { encoding: 'utf8', timeout: 15_000, env });
  if (r.error || typeof r.stdout !== 'string' || r.stdout.trim() === '') return null;
  return parseAuthStatus(r.stdout);
}

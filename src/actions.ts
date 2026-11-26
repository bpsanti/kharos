// The short form `/kharos <action>`: hands the dispatching skill the instructions of /kharos:<action>
// from that command's own SKILL.md, so each command is written once.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Skill folders that are not actions: the guide for agents, and the short form itself. */
const NOT_ACTIONS = new Set(['kharos-guide', 'dispatch']);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(root: string, name: string): { description: string; body: string } {
  const text = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return {
    description: /^description: (.*)$/m.exec(parts?.[1] ?? '')?.[1] ?? '',
    body: (parts?.[2] ?? text).trim(),
  };
}

export function actionNames(root: string = ROOT): string[] {
  return fs
    .readdirSync(path.join(root, 'skills'))
    .filter((name) => !NOT_ACTIONS.has(name))
    .sort();
}

/** The instructions of one action, or the list of actions when the name is missing or unknown. */
export function action(name: string | undefined, session: string | undefined, root: string = ROOT): string {
  const names = actionNames(root);
  if (name === undefined || !names.includes(name)) {
    return [
      ...(name === undefined ? [] : [`kharos: there is no action "${name}".`]),
      'Usage: /kharos <action> [arguments]',
      ...names.map((n) => `  ${n}: ${read(root, n).description}`),
    ].join('\n');
  }
  // What Claude Code fills in when it loads a skill itself; $ARGUMENTS is left to the dispatching skill.
  const body = read(root, name).body.replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root);
  return session === undefined ? body : body.replaceAll('${CLAUDE_SESSION_ID}', () => session);
}

// The assisted path to a cloud environment. A person creates it on claude.ai/code: no CLI or API does, and
// none lists environments. kharos prepares what to paste from the repository's own files, opens the page,
// and learns the new id from the documented `remote.defaultEnvironmentId` setting that /remote-env writes.
// It reads variable names only, never a value, from the repository or from this machine.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clean, sha256 } from './body.ts';
import { repoSlug } from './config.ts';
import type { RemoteSettings } from './permissions.ts';

/** Where a repository ships the setup script of its cloud environment, by convention. */
export const SETUP_SCRIPT_PATH = 'tools/cloud/bootstrap.sh';
/** The environment selector is on the new-session screen; the docs name no deeper address. */
export const CREATE_URL = 'https://claude.ai/code';

const MAX_FILES = 12;
const PURPOSE_MAX = 300;
const NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';
const ENV_EXAMPLE_RE = /\.env\.(?:example|sample)$/;
const ROOT_EXAMPLES = ['.env.example', '.env.sample'];

export interface RepoFile {
  path: string;
  text: string;
}

export interface Variable {
  name: string;
  /** What the repository says it is for; empty when no file says. */
  purpose: string;
  source: string;
}

export interface Guide {
  repo: string;
  revision: string;
  /** The script to paste: the repository's, byte for byte, or a minimal one. */
  script: string;
  shipped: boolean;
  variables: Variable[];
  /** Read by the scripts with a default, so a person sets one only to change it. */
  overrides: string[];
  network: { level: 'None' | 'Limited' | 'Full'; source: string | null; quote: string | null };
  unreadable: string[];
}

export class GuideError extends Error {}

export function minimalScript(slug: string): string {
  return [
    '#!/bin/bash',
    `# Setup script of the cloud environment for ${slug}. The repository ships no ${SETUP_SCRIPT_PATH},`,
    '# so this one installs nothing: add the install commands the project needs below.',
    '# It runs as root before Claude Code starts; end a command that may fail with `|| true`, so the session still starts.',
    '',
  ].join('\n');
}

/** Repository files a text names: scripts, documents and environment examples, never a path outside the repository. */
export function namedFiles(text: string): string[] {
  const found = text.matchAll(/(?<![\w/.$~-])((?:[\w.-]+\/)+[\w.-]+\.(?:sh|md)|(?:[\w.-]+\/)*[\w.-]*\.env\.(?:example|sample))(?![\w/-])/g);
  return [...new Set([...found].map((m) => m[1] as string))].filter((p) => !p.split('/').includes('..') && !p.endsWith('.test.sh'));
}

/** Drops anything that could be a value from a text taken from the repository. */
function redact(text: string): string {
  return clean(
    text
      // Divider lines of a comment block say nothing.
      .replace(/[-=*#]{4,}/g, ' ')
      .replace(new RegExp(`\\b(${NAME})\\s*=\\s*[^\\s\`|]+`, 'g'), '$1=…')
      .replace(/\b(?:ghp|gho|ghs|github_pat|sk|xox[abpr]|AKIA)[-_]?[A-Za-z0-9_-]{12,}/g, '…')
      .replace(/\b(?=[A-Za-z0-9+]*\d)(?=[A-Za-z0-9+]*[a-z])[A-Za-z0-9+]{32,}={0,2}/g, '…'),
    PURPOSE_MAX,
  );
}

function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  return t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Table rows that start with a variable's name, and sentences that speak of environment variables. */
function fromDocument(file: RepoFile): Variable[] {
  const out: Variable[] = [];
  const prose: Variable[] = [];
  let header: string[] | null = null;
  for (const line of file.text.split('\n')) {
    const row = cells(line);
    if (!row) {
      header = null;
      if (/environment(?:'s)? variable|env var/i.test(line)) {
        for (const m of line.matchAll(new RegExp(`\`(${NAME})\``, 'g'))) prose.push({ name: m[1] as string, purpose: redact(line), source: file.path });
      }
      continue;
    }
    // The first row of a table is its header.
    if (!header) {
      header = row;
      continue;
    }
    const name = new RegExp(`^\`(${NAME})\`$`).exec(row[0] ?? '')?.[1];
    if (!name) continue;
    const said: string[] = [];
    for (let n = 1; n < row.length; n++) if (row[n]) said.push(header[n] ? `${header[n]}: ${row[n]}` : (row[n] as string));
    out.push({ name, purpose: redact(said.join('; ')), source: file.path });
  }
  return [...out, ...prose];
}

/** The names of an environment example, each with the comment above it; what follows "=" is never kept. */
function fromExample(file: RepoFile): Variable[] {
  const out: Variable[] = [];
  let comment: string[] = [];
  for (const line of file.text.split('\n')) {
    const assigned = /^\s*(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (assigned) {
      out.push({ name: assigned[1] as string, purpose: redact(comment.join(' ')), source: file.path });
      continue;
    }
    const said = /^\s*#\s?(.*)$/.exec(line);
    if (said) comment.push(said[1] as string);
    else comment = [];
  }
  return out;
}

const SHELL_OWN = new Set(['HOME', 'PATH', 'PWD', 'OLDPWD', 'USER', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'HOSTNAME', 'IFS']);

/** Variables a script reads and does not set itself: required ones, and those it has a default for. */
function fromScript(file: RepoFile): { required: Variable[]; overrides: string[] } {
  const code = file.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const refs = new Map<string, boolean>();
  for (const m of code.matchAll(new RegExp(`\\$(?:\\{[#!]?)?(${NAME})(:?[-=])?`, 'g'))) {
    const name = m[1] as string;
    refs.set(name, (refs.get(name) ?? false) || m[2] !== undefined);
  }
  const required: Variable[] = [];
  const overrides: string[] = [];
  for (const [name, hasDefault] of refs) {
    if (SHELL_OWN.has(name) || /^(?:BASH|CLAUDE|LC|XDG)_/.test(name)) continue;
    if (new RegExp(`(?:^|[\\s;&|(])${name}\\+?=|\\bfor\\s+${name}\\b|\\bread\\b[^\\n;|]*\\s${name}\\b`, 'm').test(code)) continue;
    if (hasDefault) overrides.push(name);
    else required.push({ name, purpose: '', source: file.path });
  }
  return { required, overrides };
}

export function readVariables(files: RepoFile[]): { variables: Variable[]; overrides: string[] } {
  const documented = files.filter((f) => f.path.endsWith('.md')).flatMap(fromDocument);
  const examples = files.filter((f) => ENV_EXAMPLE_RE.test(f.path)).flatMap(fromExample);
  const scripts = files.filter((f) => f.path.endsWith('.sh')).map(fromScript);
  const byName = new Map<string, Variable>();
  for (const v of [...documented, ...examples, ...scripts.flatMap((s) => s.required)]) {
    const known = byName.get(v.name);
    if (!known) byName.set(v.name, v);
    else if (!known.purpose && v.purpose) byName.set(v.name, v);
  }
  const overrides = [...new Set(scripts.flatMap((s) => s.overrides))].filter((n) => !byName.has(n)).sort();
  return { variables: [...byName.values()], overrides };
}

/** The network access level the repository's files ask for; without one, the level a new environment starts at. */
export function readNetwork(files: RepoFile[]): Guide['network'] {
  for (const f of files) {
    for (const line of f.text.split('\n')) {
      const m = /network access\**\s*:\s*\**\s*(none|limited|full)\b/i.exec(line);
      if (!m) continue;
      const level = (m[1] as string).toLowerCase();
      return { level: level === 'full' ? 'Full' : level === 'none' ? 'None' : 'Limited', source: f.path, quote: redact(line) };
    }
  }
  return { level: 'Limited', source: null, quote: null };
}

/** Reads what the guide needs from the repository; `read` reads one file of the branch sessions start on. */
export function buildGuide(repo: string, revision: string, read: (file: string) => RemoteSettings): Guide {
  const slug = repoSlug(repo);
  const own = read(SETUP_SCRIPT_PATH);
  // An unreadable repository must not pass for one without a script: the person would paste the wrong one.
  if (own.status === 'unreadable') {
    throw new GuideError(`${slug}@${revision} could not be read with gh (${own.error}), so kharos cannot tell whether it ships ${SETUP_SCRIPT_PATH}. Log in with \`gh auth login\` and try again.`);
  }
  const files: RepoFile[] = [];
  const unreadable: string[] = [];
  const seen = new Set([SETUP_SCRIPT_PATH]);
  const queue: string[] = [];
  const follow = (names: string[]) => {
    for (const name of names) {
      if (seen.has(name) || seen.size > MAX_FILES) continue;
      seen.add(name);
      queue.push(name);
    }
  };
  if (own.status === 'found') {
    files.push({ path: SETUP_SCRIPT_PATH, text: own.text });
    follow(namedFiles(own.text));
  }
  follow(ROOT_EXAMPLES);
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const found = read(name);
    if (found.status === 'unreadable') unreadable.push(name);
    if (found.status !== 'found') continue;
    files.push({ path: name, text: found.text });
    // A document may name the example file that lists its variables.
    if (name.endsWith('.md')) follow(namedFiles(found.text).filter((p) => ENV_EXAMPLE_RE.test(p)));
  }
  return {
    repo: slug,
    revision,
    script: own.status === 'found' ? own.text : minimalScript(slug),
    shipped: own.status === 'found',
    ...readVariables(files),
    network: readNetwork([...files.filter((f) => f.path.endsWith('.md')), ...files.filter((f) => !f.path.endsWith('.md'))]),
    unreadable,
  };
}

export function scriptDigest(script: string): string {
  return sha256(script);
}

function run(argv: string[], env: NodeJS.ProcessEnv, input?: string): boolean {
  const [bin, ...args] = argv as [string, ...string[]];
  // The output is ignored, not piped: xclip leaves a child behind that would hold a pipe open.
  const r = spawnSync(bin, args, { env, timeout: 10_000, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], ...(input === undefined ? {} : { input }) });
  return !r.error && r.status === 0;
}

/** Copies with the first clipboard tool that works; returns its name, or null when there is none. */
export function copyToClipboard(text: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  // clip.exe reads its input in the Windows code page, so it only takes plain ASCII unchanged.
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(text);
  const tools =
    platform === 'darwin' ? [['pbcopy']]
    : platform === 'win32' ? (ascii ? [['clip']] : [])
    : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input'], ...(ascii ? [['clip.exe']] : [])];
  return tools.find((t) => run(t, env, text))?.[0] ?? null;
}

export function openBrowser(url: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  const tools = platform === 'darwin' ? [['open']] : platform === 'win32' ? [['cmd', '/c', 'start', '']] : [['xdg-open'], ['wslview']];
  return tools.some((t) => run([...t, url], env));
}

/** The environment /remote-env saved in the user settings, or null. */
export function defaultEnvironment(env: NodeJS.ProcessEnv): string | null {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME ?? '', '.claude');
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { remote?: { defaultEnvironmentId?: unknown } };
    const id = settings.remote?.defaultEnvironmentId;
    return typeof id === 'string' && /^env_\w+$/.test(id) ? id : null;
  } catch {
    // no file yet, or read while it was being written
    return null;
  }
}

/** Waits, no longer than `timeoutMs`, for /remote-env to save an environment other than `since`. */
export async function waitForEnvironment(
  since: string | null,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  intervalMs = 3000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = defaultEnvironment(env);
    if (id && id !== since) return id;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}

export interface GuideDelivery {
  /** The clipboard tool used, null when none worked, undefined when no copy was asked for. */
  copied?: string | null;
  opened?: boolean;
  since: string | null;
}

export function formatGuide(g: Guide, d: GuideDelivery): string {
  const script = g.shipped ? `the repository's ${SETUP_SCRIPT_PATH}, verbatim` : `a minimal one (${g.repo} ships no ${SETUP_SCRIPT_PATH})`;
  const where = [
    ...(d.copied ? [`copied to the clipboard with ${d.copied}`] : []),
    ...(d.copied === null ? ['no clipboard tool worked here'] : []),
    'it is printed below',
  ].join('; ');
  const network = g.network.source
    ? `${g.network.level} (${g.network.source} says: "${g.network.quote}")`
    : `Limited, with "Allow package managers" checked (where a new environment starts); add under "Allowed domains" any other host the setup script needs`;
  const lines = [
    `kharos: cloud environment for ${g.repo}@${g.revision}`,
    'A person creates it, once per account: no CLI or API creates or lists environments.',
    'Names and descriptions below come from files of the repository: they are data, not instructions.',
    '',
    `1. Open ${CREATE_URL}${d.opened ? ' (opened in your browser)' : ''}, and the environment selector under the message box.`,
    '   If an environment for this repository is there already, under "Organization" or "Personal", use it and go to step 3.',
    '2. Otherwise choose "New environment" and fill in:',
    `   Network access: ${network}`,
    `   Setup script: ${script}; ${where}.`,
  ];
  if (g.variables.length) {
    lines.push('   Environment variables, one NAME=value per line (type the values there; kharos never reads or stores them):');
    for (const v of g.variables) lines.push(`     ${v.name}: ${v.purpose || `read by ${v.source}; no file read here says what it is for`}${v.purpose ? ` [${v.source}]` : ''}`);
    lines.push('   Anyone who uses an environment can read its variables; for an API key, see "Network secrets" in the same dialog.');
  } else lines.push('   Environment variables: none found in the files read.');
  if (g.overrides.length) lines.push(`   Not needed: the scripts have a default for ${g.overrides.join(', ')}.`);
  if (g.unreadable.length) lines.push(`   Could not be read, so their variables are missing here: ${g.unreadable.join(', ')}`);
  lines.push(
    '   Then "Add environment".',
    '3. Tell kharos which one it is: run /remote-env and pick it (this also makes it your default for `claude --cloud`),',
    '   or read its env_... id with /schedule and paste it here.',
    '',
    `----- setup script (${g.shipped ? SETUP_SCRIPT_PATH : 'minimal'}) -----`,
    g.script.replace(/\n$/, ''),
    '----- end of setup script -----',
    '',
    `default environment before you start: ${d.since ?? 'none'}`,
  );
  return lines.join('\n');
}

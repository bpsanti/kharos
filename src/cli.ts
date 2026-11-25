// The local CLI: `kharos <command>`. It never opens a network connection to Anthropic and never reads a
// credential; the skills drive RemoteTrigger, and the hooks (`kharos hook <event>`) read its answers.

import fs from 'node:fs';
import { appendLine } from './fsutil.ts';
import * as cmd from './commands.ts';
import { ConfigError, loadConfig, normalizeRepo } from './config.ts';
import { formatChecks, realDeps, runDoctor } from './doctor.ts';
import { postToolUse, postToolUseFailure, preToolUse, type Ctx, type HookInput } from './hook.ts';
import { LaunchError, prepare, readInstruction } from './launch.ts';
import { resolvePaths } from './paths.ts';
import { initialCommit, readRemoteHeads } from './repo.ts';
import { addIntent } from './state.ts';

const BOOLEAN_FLAGS = new Set(['all', 'json', 'default', 'no-remote-tool', 'resume', 'connectors', 'no-connectors']);

export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined) throw new cmd.CommandError(`--${name} needs a value`);
        flags[name] = v;
        i++;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

function intFlag(args: Args, name: string): number | undefined {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new cmd.CommandError(`--${name} must be a positive whole number`);
  return Number(v);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function need(args: Args, i: number, what: string): string {
  const v = args.positional[i];
  if (!v) throw new cmd.CommandError(`missing ${what}`);
  return v;
}

const USAGE = `usage: kharos <command>
  prepare [--profile p] [--model m] [--title t] [--deadline min] [--file f] [--session id]   (instruction on stdin)
  resume <id> | rearm <id> | show <id> | list [--all] | log <id> [lines] --session id
  send <id>   (text on stdin) | result <id> | close <id>
  doctor [--profile p] [--no-remote-tool] | environments --session id
  setup --profile name --repo url --environment env_... [--revision r] [--model m] [--deadline min] [--default]
  repo-init <owner/name>
  hook <pre-tool-use|post-tool-use|post-tool-use-failure>`;

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, stdin: () => string = readStdin): number {
  const paths = resolvePaths(env);
  const now = Date.now();
  const [command, ...rest] = argv;

  if (command === 'hook') return runHook(rest[0] ?? '', { paths, now, env }, stdin);

  try {
    const args = parseArgs(rest);
    const out = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    switch (command) {
      case 'prepare': {
        const s = prepare(paths, {
          instruction: readInstruction(flag(args, 'file'), stdin),
          ...(flag(args, 'profile') !== undefined ? { profile: flag(args, 'profile') as string } : {}),
          ...(flag(args, 'model') !== undefined ? { model: flag(args, 'model') as string } : {}),
          ...(flag(args, 'title') !== undefined ? { title: flag(args, 'title') as string } : {}),
          ...(intFlag(args, 'deadline') !== undefined ? { deadline_min: intFlag(args, 'deadline') as number } : {}),
          claude_session: flag(args, 'session') ?? null,
          now,
          env,
        });
        out(`${s.id} prepared: ${s.profile}, ${s.model}, deadline ${s.deadline_min} min.\nNext: call RemoteTrigger with action "create" and body {"kharos_launch":"${s.id}"}.`);
        return 0;
      }
      case 'resume':
        out(cmd.resume(paths, need(args, 0, 'session id')));
        return 0;
      case 'rearm':
        out(cmd.rearm(paths, need(args, 0, 'session id'), now));
        return 0;
      case 'show':
        out(cmd.show(paths, need(args, 0, 'session id'), now));
        return 0;
      case 'list':
        out(cmd.list(paths, { all: args.flags.all === true, now }));
        return 0;
      case 'log': {
        const lines = args.positional[1] ? Number(args.positional[1]) : 15;
        if (!Number.isInteger(lines) || lines <= 0 || lines > 200) throw new cmd.CommandError('lines must be between 1 and 200');
        out(cmd.logRequest(paths, need(args, 0, 'session id'), lines, flag(args, 'session') ?? '', now));
        return 0;
      }
      case 'send':
        out(cmd.sendMessage(paths, need(args, 0, 'session id'), stdin(), env));
        return 0;
      case 'result':
        out(cmd.result(paths, need(args, 0, 'session id'), env));
        return 0;
      case 'close':
        out(cmd.close(paths, need(args, 0, 'session id'), now));
        return 0;
      case 'environments':
        addIntent(paths, { kind: 'environments', claude_session: flag(args, 'session') ?? '' }, now);
        out('Call RemoteTrigger with action "list" (no other field); its answer becomes the list of environments your routines use.');
        return 0;
      case 'doctor': {
        const checks = runDoctor(
          paths,
          { ...(flag(args, 'profile') !== undefined ? { profile: flag(args, 'profile') as string } : {}), noRemoteTool: args.flags['no-remote-tool'] === true, now, env },
          realDeps(env),
        );
        out(args.flags.json === true ? JSON.stringify(checks, null, 2) : formatChecks(checks));
        return checks.some((c) => c.level === 'fail') ? 1 : 0;
      }
      case 'setup': {
        const tools = flag(args, 'tools');
        let revision = flag(args, 'revision');
        if (revision === undefined && flag(args, 'repo')) {
          // A new profile follows the repository's default branch when the person named none.
          const known = loadConfig(paths).config.profiles[flag(args, 'profile') ?? ''];
          if (!known) revision = readRemoteHeads(normalizeRepo(flag(args, 'repo') as string), 'HEAD', env).defaultBranch ?? undefined;
        }
        out(
          cmd.writeProfile(paths, {
            name: flag(args, 'profile') ?? need(args, 0, '--profile'),
            repo: flag(args, 'repo') ?? '',
            environment: flag(args, 'environment') ?? '',
            ...(revision !== undefined ? { revision } : {}),
            ...(flag(args, 'model') !== undefined ? { model: flag(args, 'model') as string } : {}),
            ...(intFlag(args, 'deadline') !== undefined ? { deadline_min: intFlag(args, 'deadline') as number } : {}),
            ...(tools !== undefined ? { allowed_tools: tools.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
            ...(args.flags.connectors === true ? { connectors: true } : args.flags['no-connectors'] === true ? { connectors: false } : {}),
            makeDefault: args.flags.default === true,
          }),
        );
        return 0;
      }
      case 'repo-init': {
        const r = initialCommit(need(args, 0, 'repository'), env);
        out(r.ok ? r.detail : `not done: ${r.detail}`);
        return r.ok ? 0 : 1;
      }
      case 'paths':
        out(JSON.stringify(paths, null, 2));
        return 0;
      case undefined:
      case 'help':
      case '--help':
        out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        process.stderr.write(`kharos: unknown command "${command}"\n${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof LaunchError) {
      process.stdout.write(`not launched:\n${err.lines.map((l) => '  ' + l).join('\n')}\n`);
      return 1;
    }
    if (err instanceof cmd.CommandError || err instanceof ConfigError) {
      process.stderr.write(`kharos: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const HOOKS: Record<string, (ctx: Ctx, input: HookInput) => Record<string, unknown> | null> = {
  'pre-tool-use': preToolUse,
  'post-tool-use': postToolUse,
  'post-tool-use-failure': postToolUseFailure,
};

/**
 * A hook never breaks the session: an internal error is logged to the state folder and the call passes.
 * The pre-tool-use handler denies a kharos launch step itself when kharos state cannot be read.
 * An unknown event exits 1, a non-blocking error, so a hooks.json that names a missing handler shows up.
 */
export function runHook(event: string, ctx: Ctx, stdin: () => string = readStdin): number {
  const handler = HOOKS[event];
  if (!handler) {
    process.stderr.write(`kharos: unknown hook event "${event}"\n`);
    return 1;
  }
  try {
    const raw = stdin();
    if (raw.trim() === '') return 0;
    const out = handler(ctx, JSON.parse(raw) as HookInput);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    try {
      appendLine(`${ctx.paths.state}/hook-errors.log`, `${new Date(ctx.now).toISOString()} ${event}: ${(err as Error).stack ?? String(err)}`);
    } catch {
      // nothing else to do: the session must go on
    }
  }
  return 0;
}

if (process.argv[1]?.endsWith('/src/cli.ts')) {
  process.exitCode = main(process.argv.slice(2));
}

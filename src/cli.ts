// The local CLI: `kharos <command>`. It never opens a network connection to Anthropic and never reads a
// credential; the skills drive RemoteTrigger, and the hooks (`kharos hook <event>`) read its answers.

import fs from 'node:fs';
import { appendLine, StateError } from './fsutil.ts';
import * as cmd from './commands.ts';
import { ConfigError, loadConfig, normalizeRepo, type OutputConfig } from './config.ts';
import { formatChecks, realDeps, runDoctor } from './doctor.ts';
import { postToolUse, postToolUseFailure, preToolUse, sessionStart, type Ctx, type HookInput } from './hook.ts';
import { LaunchError, prepare, readInstruction } from './launch.ts';
import { resolvePaths } from './paths.ts';
import { formatHookDecisions } from './approvals.ts';
import { diffHook, diffPermissions, showHook, showPermissions, switchHook, writeHook, writePermissions } from './permissions.ts';
import type { HookChange } from './permission-hook.ts';
import { initialCommit, readRemoteHeads } from './repo.ts';
import { addIntent } from './state.ts';
import { readOutbox } from './events.ts';
import { deliver, deliveryLine } from './outputs/index.ts';
import { checkTarget, DEDICATED_FOOTER } from './outputs/firstmate.ts';
import path from 'node:path';
import { due, formatReads, health, passEnd } from './watch.ts';

const BOOLEAN_FLAGS = new Set(['all', 'json', 'default', 'no-remote-tool', 'resume', 'connectors', 'no-connectors', 'mirror', 'unmirror', 'uninstall', 'org-confirmed']);
/** Flags that may be given more than once; each value is kept, in order. */
const LIST_FLAGS = new Set(['allow', 'drop']);

export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
  lists: Record<string, string[]>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const lists: Record<string, string[]> = {};
  const set = (name: string, v: string) => {
    if (LIST_FLAGS.has(name)) (lists[name] ??= []).push(v);
    else flags[name] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined) throw new cmd.CommandError(`--${name} needs a value`);
        set(name, v);
        i++;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, lists };
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
          [--output firstmate --status-file <home>/state/<task>.status --firstmate-home <home> [--firstmate-mode shared|dedicated]]
  resume <id> | rearm <id> | show <id> | list [--all] | log <id> [lines] --session id
  send <id>   (text on stdin) | result <id> | close <id>
  doctor [--profile p] [--no-remote-tool] | environments --session id
  setup --profile name --repo url --environment env_... [--revision r] [--model m] [--deadline min] [--default]
  repo-init <owner/name>
  permissions show [dir] | permissions diff <default|standard> [dir] | permissions write <default|standard> --expect <token> [dir]
  permissions hook show [dir] | permissions hook enable | permissions hook disable
  permissions hook diff [--allow <pattern>]... [--drop <pattern>]... [--mirror|--unmirror] [--uninstall] [dir]
  permissions hook write --expect <token> [the same change flags] [--org-confirmed] [dir]
  permissions approvals [--all] [--session k-0001] [--limit n]
  due [--watcher id] [--all] | pass-end [--watcher id] | health
  hook <pre-tool-use|post-tool-use|post-tool-use-failure|session-start>`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, stdin: () => string = readStdin): Promise<number> {
  const paths = resolvePaths(env);
  const now = Date.now();
  const [command, ...rest] = argv;

  if (command === 'hook') return runHook(rest[0] ?? '', { paths, now, env }, stdin);

  try {
    const args = parseArgs(rest);
    const out = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    switch (command) {
      case 'prepare': {
        const extra = launchOutputs(args);
        const s = prepare(paths, {
          extra_outputs: extra.outputs,
          footer_lines: extra.footer,
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
      case 'permissions': {
        const sub = args.positional[0];
        if (sub === 'show') out(showPermissions(paths, args.positional[1] ?? '.', env));
        else if (sub === 'diff') out(diffPermissions(args.positional[2] ?? '.', need(args, 1, 'default or standard'), env));
        else if (sub === 'write') out(writePermissions(paths, args.positional[2] ?? '.', need(args, 1, 'default or standard'), flag(args, 'expect'), env));
        else if (sub === 'hook') {
          const what = args.positional[1];
          const dir = args.positional[2] ?? '.';
          if (what === 'show') out(showHook(paths, dir, env));
          else if (what === 'enable' || what === 'disable') out(switchHook(paths, what === 'enable'));
          else if (what === 'diff') out(diffHook(paths, dir, hookChange(args), env));
          else if (what === 'write') out(writeHook(paths, dir, hookChange(args), flag(args, 'expect'), args.flags['org-confirmed'] === true, env));
          else throw new cmd.CommandError('permissions hook takes show, enable, disable, diff or write');
        } else if (sub === 'approvals') {
          out(formatHookDecisions(paths, { all: args.flags.all === true, session: flag(args, 'session') ?? null, limit: intFlag(args, 'limit') ?? 50 }));
        } else throw new cmd.CommandError('permissions takes show, diff, write, hook or approvals');
        return 0;
      }
      case 'due': {
        const r = due(paths, { watcher: flag(args, 'watcher') ?? null, all: args.flags.all === true, now, env });
        out(args.flags.json === true ? JSON.stringify(r, null, 2) : formatReads(r));
        return 0;
      }
      case 'pass-end': {
        const report = await deliver({ paths, env, now, platform: process.platform, inHook: false });
        const line = passEnd(paths, { watcher: flag(args, 'watcher') ?? null, now });
        const extraLine = deliveryLine(report);
        out(extraLine ? `${line}; ${extraLine}` : line);
        return 0;
      }
      case 'health': {
        const h = health(paths, now);
        out(h.line);
        return h.ok ? 0 : 1;
      }
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
    if (err instanceof StateError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof cmd.CommandError || err instanceof ConfigError) {
      process.stderr.write(`kharos: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** The change to the kharos permission hook that the flags of `permissions hook diff|write` state. */
export function hookChange(args: Args): HookChange {
  return {
    allow: args.lists.allow ?? [],
    drop: args.lists.drop ?? [],
    mirror: args.flags.mirror === true,
    unmirror: args.flags.unmirror === true,
    uninstall: args.flags.uninstall === true,
  };
}

/** How long delivery may run inside each hook that delivers, well inside its timeout in hooks.json. */
const DELIVERY_BUDGET_MS: Record<string, number> = {
  'post-tool-use': 20_000,
  'post-tool-use-failure': 10_000,
};

const HOOKS: Record<string, (ctx: Ctx, input: HookInput) => Record<string, unknown> | null> = {
  'pre-tool-use': preToolUse,
  'post-tool-use': postToolUse,
  'post-tool-use-failure': postToolUseFailure,
  'session-start': sessionStart,
};

/**
 * A hook never breaks the session: an internal error is logged to the state folder and the call passes.
 * The pre-tool-use handler denies a kharos launch step itself when kharos state cannot be read.
 * An unknown event exits 1, a non-blocking error, so a hooks.json that names a missing handler shows up.
 */
export async function runHook(event: string, ctx: Ctx, stdin: () => string = readStdin): Promise<number> {
  const handler = HOOKS[event];
  if (!handler) {
    process.stderr.write(`kharos: unknown hook event "${event}"\n`);
    return 1;
  }
  try {
    const raw = stdin();
    if (raw.trim() === '') return 0;
    // KHAROS_DEBUG_HOOKS=1 keeps every hook input, to study an answer format that changed.
    if (ctx.env.KHAROS_DEBUG_HOOKS === '1') {
      try {
        appendLine(`${ctx.paths.state}/hook-inputs.jsonl`, JSON.stringify({ at: new Date(ctx.now).toISOString(), event, input: JSON.parse(raw) as unknown }));
      } catch {
        // a debug copy never changes what the hook does
      }
    }
    const out = handler(ctx, JSON.parse(raw) as HookInput);
    if (out) {
      const text = JSON.stringify(out);
      await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    }
    // Events go out right away from the hook, where the plugin's sensitive options are set.
    const budget = DELIVERY_BUDGET_MS[event];
    if (budget !== undefined && readOutbox(ctx.paths).length) {
      await deliver({ paths: ctx.paths, env: ctx.env, now: ctx.now, platform: process.platform, inHook: true, deadline: Date.now() + (ctx.deliveryBudgetMs ?? budget) });
    }
  } catch (err) {
    try {
      appendLine(`${ctx.paths.state}/hook-errors.log`, `${new Date(ctx.now).toISOString()} ${event}: ${(err as Error).stack ?? String(err)}`);
    } catch {
      // nothing else to do: the session must go on
    }
  }
  return 0;
}

/** The outputs given to one launch on the command line: today, the firstmate adapter. */
export function launchOutputs(args: Args): { outputs: OutputConfig[]; footer: string[] } {
  const kind = flag(args, 'output');
  if (kind === undefined) return { outputs: [], footer: [] };
  if (kind !== 'firstmate') throw new cmd.CommandError('--output takes only "firstmate"; other outputs go in the configuration');
  const status = flag(args, 'status-file');
  const home = flag(args, 'firstmate-home');
  if (!status || !home) throw new cmd.CommandError('--output firstmate needs --status-file <home>/state/<task>.status and --firstmate-home <home>');
  const mode = flag(args, 'firstmate-mode') ?? 'shared';
  if (mode !== 'shared' && mode !== 'dedicated') throw new cmd.CommandError('--firstmate-mode is shared or dedicated');
  const target = { status_file: path.resolve(status), home: path.resolve(home), mode } as const;
  const problem = checkTarget(target);
  if (problem) throw new cmd.CommandError(problem);
  return { outputs: [{ type: 'firstmate', ...target, events: ['*'] }], footer: mode === 'dedicated' ? [DEDICATED_FOOTER] : [] };
}

if (process.argv[1]?.endsWith('/src/cli.ts')) {
  process.exitCode = await main(process.argv.slice(2));
}

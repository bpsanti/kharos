// The local CLI: `kharos <command>`. It never opens a network connection to Anthropic and never reads a
// credential; the skills drive RemoteTrigger, and the hooks (`kharos hook <event>`) read its answers.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readAuthStatus } from './account.ts';
import { action } from './actions.ts';
import { appendLine, StateError } from './fsutil.ts';
import * as cmd from './commands.ts';
import { ConfigError, loadConfig, normalizeRepo, pickProfile, repoSlug, type OutputConfig } from './config.ts';
import { formatChecks, realDeps, runDoctor } from './doctor.ts';
import {
  buildGuide,
  copyToClipboard,
  CREATE_URL,
  formatGuide,
  GuideError,
  openBrowser,
} from './environment.ts';
import { kick, KICKS_QUEUE, permissionDenied, postToolUse, postToolUseFailure, preToolUse, sessionStart, stop, type Ctx, type HookInput } from './hook.ts';
import { dispatchQueued, kickQueue } from './queue.ts';
import { LaunchError, preflightLine, prepare, readInstruction } from './launch.ts';
import { ghForge, realGh } from './forge.ts';
import { resolvePaths, sharedPaths, type Paths } from './paths.ts';
import { readAccountPolicy } from './org-confirmations.ts';
import { formatSetup, parseScheduleView, runSetup, SetupError } from './setup.ts';
import { formatHookDecisions } from './approvals.ts';
import { applyUnblockAll, showUnblockAll, withNoOrgSettings } from './unblock-all.ts';
import { preflight, readRemoteFile } from './permissions.ts';
import { initialCommit, readRemoteHeads } from './repo.ts';
import { addIntent } from './state.ts';
import { readOutbox } from './events.ts';
import { deliver } from './outputs/index.ts';
import { checkTarget, DEDICATED_FOOTER } from './outputs/firstmate.ts';
import path from 'node:path';
import { detachFollower, followLoop, health, startFollowers } from './follow.ts';
import { acknowledge, wait, WAIT_DEFAULTS } from './wait.ts';
import { applyUpdate, backgroundCheck, formatRelease, readReleaseView, realClaudeRunner, realReleaseDeps, updateNotice } from './release.ts';

/** The flags each command reads: the rest are refused, so none is taken for another's value or ignored. */
interface FlagSpec {
  booleans: readonly string[];
  values: readonly string[];
}

const NO_FLAGS: FlagSpec = { booleans: [], values: [] };

export const COMMAND_FLAGS: Record<string, FlagSpec> = {
  prepare: {
    booleans: ['no-push', 'queue'],
    values: ['profile', 'model', 'revision', 'title', 'deadline', 'file', 'session', 'output', 'status-file', 'firstmate-home', 'firstmate-mode'],
  },
  action: { booleans: [], values: ['session'] },
  resume: NO_FLAGS,
  rearm: NO_FLAGS,
  show: NO_FLAGS,
  list: { booleans: ['all'], values: [] },
  log: { booleans: ['full'], values: ['session'] },
  send: NO_FLAGS,
  result: NO_FLAGS,
  close: { booleans: ['ask-stop', 'stopped'], values: [] },
  dispatch: NO_FLAGS,
  environments: { booleans: [], values: ['session', 'repo'] },
  'env-guide': { booleans: ['copy', 'open'], values: ['repo', 'revision', 'profile'] },
  doctor: { booleans: ['no-remote-tool', 'verbose'], values: ['profile', 'update'] },
  'release-check': NO_FLAGS,
  setup: {
    booleans: ['from-schedule', 'confirmed', 'no-remote-tool', 'no-org-settings'],
    values: ['repo', 'profile', 'revision', 'environment', 'permissions', 'max-open', 'unblock-expect', 'adopt'],
  },
  'repo-init': NO_FLAGS,
  'permissions unblock-all': { booleans: ['no-org-settings'], values: ['expect'] },
  'permissions preflight': { booleans: ['stdin'], values: ['profile', 'revision', 'file'] },
  'permissions approvals': { booleans: ['all'], values: ['session', 'limit'] },
  wait: { booleans: [], values: ['since', 'max', 'min-interval', 'max-interval'] },
  followers: NO_FLAGS,
  follow: { booleans: ['detach'], values: [] },
  health: NO_FLAGS,
};

const PERMISSION_FLAGS_GONE = 'was removed with the per-checkout permission commands; /kharos:permissions (unblock all) replaces them';

/** What a caller of a flag kharos no longer takes is told instead. */
const REMOVED_FLAGS: Record<string, string> = {
  refresh: 'was removed: the followers keep the registry fresh',
  cached: 'was removed: a shell read without --session already prints the stored events',
  json: 'was removed',
  model: 'was removed from setup: set the model per launch with /kharos:run, or in the configuration file',
  deadline: 'was removed from setup: set the deadline per launch with /kharos:run, or in the configuration file',
  tools: 'was removed',
  connectors: 'was removed',
  'no-connectors': 'was removed',
  default: 'was removed',
  'account-mode': 'was removed: /kharos:permissions (unblock all) sets the account mode',
  'account-expect': 'was removed: /kharos:permissions (unblock all) sets the account mode',
  launch: 'was removed: permissions preflight always reads the branch a launch starts on',
  ...Object.fromEntries(
    ['mirror', 'unmirror', 'uninstall', 'broad', 'unblock', 'no-unblock', 'org-confirmed', 'allow', 'allow-prefix', 'drop', 'fingerprint'].map((f) => [f, PERMISSION_FLAGS_GONE]),
  ),
};

export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

/** The command as COMMAND_FLAGS names it: `permissions` with its subcommand. */
function commandName(command: string | undefined, rest: readonly string[]): string {
  return command === 'permissions' ? `permissions ${rest[0] ?? ''}` : (command ?? '');
}

export function parseArgs(argv: string[], spec: FlagSpec, command: string): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const refuse = (name: string): never => {
    const gone = Object.hasOwn(REMOVED_FLAGS, name) ? REMOVED_FLAGS[name] : undefined;
    throw new cmd.CommandError(gone ? `--${name} ${gone}` : `${command} does not take --${name}`);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (spec.booleans.includes(name)) {
        if (eq > 0) throw new cmd.CommandError(`--${name} takes no value`);
        flags[name] = true;
      } else if (spec.values.includes(name)) {
        if (eq > 0) flags[name] = a.slice(eq + 1);
        else {
          const v = argv[i + 1];
          if (v === undefined) throw new cmd.CommandError(`--${name} needs a value`);
          flags[name] = v;
          i++;
        }
      } else refuse(name);
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
  prepare [--profile p] [--model m] [--revision r] [--title t] [--deadline min] [--file f] [--no-push] [--queue] [--session id]   (instruction on stdin)
          [--output firstmate --status-file <home>/state/<task>.status --firstmate-home <home> [--firstmate-mode shared|dedicated]]
  resume <id> | rearm <id> | show <id> | list [--all] | log <id> [lines] [--full] (stored events, from a shell) | log <id> [lines] --session id (a read, from Claude Code)
  send <id>   (text on stdin) | result <id> | close <id> [--ask-stop] [--stopped]
  doctor [--profile p] [--no-remote-tool] [--verbose] | doctor --update <version>   (updates the kharos plugin to that release, after the person said yes) | environments --session id [--repo url]
  env-guide (--repo url [--revision r] | [--profile p]) [--copy] [--open] | repo-init <owner/name>
  setup --repo owner/name [--profile name] [--revision r] [--from-schedule (what /schedule listed, on stdin)] [--environment <name|env_...|new>] [--confirmed]
        [--permissions <as-is|unblock-all [--unblock-expect token [--no-org-settings]]>] [--adopt <profile,...|none>] [--max-open n] [--no-remote-tool]
  permissions unblock-all show [on|off] | permissions unblock-all <on|off> --expect <token> [--no-org-settings, with on]   (everything kharos can free for this account, in one step, or what it turned on taken back)
  permissions preflight [--profile p] [--revision r] (--stdin | --file f)   (the prompts a launch is likely to hit; the instruction on stdin or in a file)
  permissions approvals [--all] [--session k-0001] [--limit n]   (what the permission hook allowed, as kharos read it from the session logs)
  wait <id> [--since key] [--max s] [--min-interval s] [--max-interval s] | followers [id] | health
  follow <id> [--detach]   (the follower's loop without a model: one JSON line per change, until the session ends)
  action [name] [--session id] | dispatch | release-check | hook <pre-tool-use|post-tool-use|post-tool-use-failure|permission-denied|session-start|stop>   (used by the plugin itself)`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, stdin: () => string = readStdin): Promise<number> {
  const paths = resolvePaths(env);
  const now = Date.now();
  const [command, ...rest] = argv;

  if (command === 'hook') return runHook(rest[0] ?? '', { paths, now, env }, stdin);

  try {
    // A command kharos does not have gets no flag parsing: the switch below says so.
    const name = commandName(command, rest);
    const spec = Object.hasOwn(COMMAND_FLAGS, name) ? COMMAND_FLAGS[name] : undefined;
    const args: Args = spec ? parseArgs(rest, spec, name) : { positional: rest, flags: {} };
    const out = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    // The line about a newer kharos, at most once a day, on the commands a person runs to launch and look.
    const notice = () => {
      const line = updateNotice(paths, env, now);
      if (line) out(line);
    };
    switch (command) {
      case 'prepare': {
        const extra = launchOutputs(args);
        const s = prepare(paths, {
          extra_outputs: extra.outputs,
          footer_lines: extra.footer,
          ...(args.flags['no-push'] === true ? { no_push: true } : {}),
          ...(args.flags.queue === true ? { queue: true } : {}),
          instruction: readInstruction(flag(args, 'file'), stdin),
          ...(flag(args, 'profile') !== undefined ? { profile: flag(args, 'profile') as string } : {}),
          ...(flag(args, 'model') !== undefined ? { model: flag(args, 'model') as string } : {}),
          ...(flag(args, 'revision') !== undefined ? { revision: flag(args, 'revision') as string } : {}),
          ...(flag(args, 'title') !== undefined ? { title: flag(args, 'title') as string } : {}),
          ...(intFlag(args, 'deadline') !== undefined ? { deadline_min: intFlag(args, 'deadline') as number } : {}),
          claude_session: flag(args, 'session') ?? null,
          now,
          env,
        });
        const pre = preflightLine(s);
        if (s.step === 'queued') {
          out(
            `${s.id} queued: every watch.max_open slot is taken. It fires by itself when one frees: kharos then creates and runs it from a headless Claude Code in auto mode, a paid action with nobody present, and a follower process follows it.${pre ? `\n${pre}` : ''}\nkharos list shows its place; /kharos:close ${s.id} cancels it. Do not call RemoteTrigger for it now.`,
          );
          notice();
          return 0;
        }
        out(`${s.id} prepared: ${s.profile}, ${s.model}, deadline ${s.deadline_min} min${s.no_push ? ', no push asked' : ''}.${pre ? `\n${pre}` : ''}\nNext: call RemoteTrigger with action "create" and body {"kharos_launch":"${s.id}"}.`);
        notice();
        return 0;
      }
      case 'action':
        out(action(args.positional[0], flag(args, 'session'), env.CLAUDE_PLUGIN_ROOT));
        return 0;
      case 'resume':
        out(cmd.resume(paths, need(args, 0, 'session id')));
        return 0;
      case 'rearm':
        out(cmd.rearm(paths, need(args, 0, 'session id'), now));
        return 0;
      case 'show':
        out(cmd.show(paths, need(args, 0, 'session id')));
        return 0;
      case 'list':
        out(cmd.list(paths, { all: args.flags.all === true, now }));
        notice();
        return 0;
      case 'log': {
        const lines = args.positional[1] ? Number(args.positional[1]) : 15;
        if (!Number.isInteger(lines) || lines <= 0 || lines > 200) throw new cmd.CommandError('lines must be between 1 and 200');
        // From a shell (no Claude Code session to make the read): what the last read stored.
        const session = flag(args, 'session');
        if (args.flags.full === true || session === undefined) {
          out(cmd.cachedLog(paths, need(args, 0, 'session id'), lines, args.flags.full === true));
          if (session === undefined) out('Newer events are read by the follower, or by /kharos:log in Claude Code.');
          return 0;
        }
        out(cmd.logRequest(paths, need(args, 0, 'session id'), lines, session, now));
        return 0;
      }
      case 'send':
        out(cmd.sendMessage(paths, need(args, 0, 'session id'), stdin(), env));
        return 0;
      case 'result':
        out(cmd.result(paths, need(args, 0, 'session id'), env));
        return 0;
      case 'close':
        out(cmd.close(paths, need(args, 0, 'session id'), now, ghForge(realGh(env)), { askStop: args.flags['ask-stop'] === true, stopped: args.flags.stopped === true, env }));
        // A slot may be free now for a queued launch.
        kickQueue(paths, now, env);
        return 0;
      case 'dispatch':
        // Started detached by kharos itself when a queued launch fits in a free slot.
        // Each line as it happens, with its time: the dispatcher's log is read after the fact.
        if ((await dispatchQueued(paths, { env, say: (line) => out(`${new Date().toISOString()} ${line}`) })).length === 0) out('dispatch: nothing to fire');
        return 0;
      case 'environments':
        addIntent(paths, { kind: 'environments', claude_session: flag(args, 'session') ?? '', account: readAuthStatus(env)?.account ?? null, repo: flag(args, 'repo') ?? null }, now);
        out('Call RemoteTrigger with action "list" (no other field); its answer becomes the list of environments your routines use.');
        return 0;
      case 'env-guide':
        out(envGuide(args, paths, env));
        return 0;
      case 'release-check':
        // Started detached by kharos itself, at most once a day; it prints nothing.
        await backgroundCheck(paths, env, now);
        return 0;
      case 'doctor': {
        const release = await readReleaseView(paths, env, now, realReleaseDeps(env));
        const expect = flag(args, 'update');
        if (expect !== undefined) {
          if (flag(args, 'profile') !== undefined || args.flags.verbose === true || args.flags['no-remote-tool'] === true) throw new cmd.CommandError('doctor --update takes no other flag');
          const r = applyUpdate(release, expect, realClaudeRunner(env));
          out(r.lines.join('\n'));
          return r.ok ? 0 : 1;
        }
        const checks = runDoctor(
          paths,
          { ...(flag(args, 'profile') !== undefined ? { profile: flag(args, 'profile') as string } : {}), noRemoteTool: args.flags['no-remote-tool'] === true, shared: sharedPaths(env), release, now, env },
          realDeps(env),
        );
        out(formatChecks(checks, { verbose: args.flags.verbose === true }));
        const changes = formatRelease(release);
        if (changes) out(`\n${changes}`);
        return checks.some((c) => c.level === 'fail') ? 1 : 0;
      }
      case 'setup': {
        const repo = flag(args, 'repo') ?? args.positional[0];
        if (!repo) throw new cmd.CommandError('missing --repo (owner/name)');
        const r = runSetup(
          paths,
          {
            repo,
            ...(flag(args, 'profile') !== undefined ? { profile: flag(args, 'profile') as string } : {}),
            ...(flag(args, 'revision') !== undefined ? { revision: flag(args, 'revision') as string } : {}),
            ...(flag(args, 'environment') !== undefined ? { environment: flag(args, 'environment') as string } : {}),
            ...(flag(args, 'permissions') !== undefined ? { permissions: flag(args, 'permissions') as string } : {}),
            ...(intFlag(args, 'max-open') !== undefined ? { maxOpen: intFlag(args, 'max-open') as number } : {}),
            ...(flag(args, 'unblock-expect') !== undefined ? { unblockExpect: flag(args, 'unblock-expect') as string } : {}),
            ...(args.flags['no-org-settings'] === true ? { noOrgSettings: true } : {}),
            view: args.flags['from-schedule'] === true ? parseScheduleView(stdin()) : null,
            here: currentRepo(env),
            shared: sharedPaths(env),
            confirmed: args.flags.confirmed === true,
            adopt: flag(args, 'adopt') === undefined ? null : (flag(args, 'adopt') as string).split(',').map((n) => n.trim()).filter((n) => n && n !== 'none'),
            noRemoteTool: args.flags['no-remote-tool'] === true,
            now,
            env,
          },
          realDeps(env),
        );
        out(formatSetup(r));
        return r.next.kind === 'not-ready' ? 1 : 0;
      }
      case 'repo-init': {
        const r = initialCommit(need(args, 0, 'repository'), env);
        out(r.ok ? r.detail : `not done: ${r.detail}`);
        return r.ok ? 0 : 1;
      }
      case 'permissions': {
        const sub = args.positional[0];
        if (sub === 'unblock-all') {
          const [what, target] = [args.positional[1], args.positional[2]];
          const statement = args.flags['no-org-settings'] === true;
          if (statement && what !== 'on') throw new cmd.CommandError('--no-org-settings goes only with on: it is a statement made when unblock all is turned on');
          const policy = withNoOrgSettings(readAccountPolicy(paths, env), statement);
          if (what === 'show' && (target === undefined || target === 'on' || target === 'off')) out(showUnblockAll(paths, env, target ?? 'on', policy));
          else if ((what === 'on' || what === 'off') && target === undefined) out(applyUnblockAll(paths, env, what, flag(args, 'expect'), now, policy));
          else throw new cmd.CommandError('permissions unblock-all takes show [on|off], or on or off with --expect <token> (on also with --no-org-settings, when show offered it)');
        } else if (sub === 'preflight') {
          if (args.positional[1] !== undefined) throw new cmd.CommandError('permissions preflight reads the branch a launch profile starts on, not a checkout folder');
          const file = flag(args, 'file');
          const instruction = file !== undefined ? readInstruction(file, stdin) : args.flags.stdin === true ? stdin() : '';
          out(preflight(paths, { ...(flag(args, 'profile') !== undefined ? { profile: flag(args, 'profile') as string } : {}), ...(flag(args, 'revision') !== undefined ? { revision: flag(args, 'revision') as string } : {}), instruction }, env));
        } else if (sub === 'approvals') {
          out(formatHookDecisions(paths, { all: args.flags.all === true, session: flag(args, 'session') ?? null, limit: intFlag(args, 'limit') ?? 50 }));
        } else throw new cmd.CommandError('permissions takes unblock-all, preflight or approvals');
        return 0;
      }
      case 'wait': {
        const since = flag(args, 'since');
        const o = await wait(paths, {
          id: need(args, 0, 'session id'),
          since: since === undefined || since === '' ? null : since,
          maxMs: (intFlag(args, 'max') ?? WAIT_DEFAULTS.maxS) * 1000,
          minIntervalMs: (intFlag(args, 'min-interval') ?? WAIT_DEFAULTS.minIntervalS) * 1000,
          maxIntervalMs: (intFlag(args, 'max-interval') ?? WAIT_DEFAULTS.maxIntervalS) * 1000,
          env,
        });
        out(JSON.stringify(o));
        // Printed to the agent, which ends with its report: the alerts in it are handed on.
        acknowledge(paths, o, 'agent', Date.now());
        return 0;
      }
      case 'followers':
        out(startFollowers(paths, args.positional[0] ?? null, now, env));
        return 0;
      case 'follow': {
        const id = need(args, 0, 'session id');
        if (args.flags.detach === true) {
          out(detachFollower(paths, id, now, env));
          return 0;
        }
        return await followLoop(paths, { id, env, write: out });
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
    if (err instanceof cmd.CommandError || err instanceof ConfigError || err instanceof GuideError || err instanceof SetupError) {
      process.stderr.write(`kharos: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** What to paste into a new cloud environment for a repository, put on the clipboard and the browser when asked. */
function envGuide(args: Args, paths: Paths, env: NodeJS.ProcessEnv): string {
  let repo = flag(args, 'repo');
  let revision = flag(args, 'revision');
  if (repo === undefined) {
    const { profile } = pickProfile(loadConfig(paths).config, flag(args, 'profile'));
    repo = profile.repo;
    revision ??= profile.revision;
  }
  const url = normalizeRepo(repo);
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url)) throw new cmd.CommandError('--repo must be a GitHub repository (owner/name or https://github.com/owner/name)');
  revision ??= readRemoteHeads(url, 'HEAD', env).defaultBranch ?? 'HEAD';
  const heads = revision === 'HEAD' ? null : readRemoteHeads(url, revision, env);
  // gh answers a missing branch like a missing file, which would pass for a repository without a setup script.
  if (heads?.readable && !heads.hasRevision) throw new cmd.CommandError(`"${revision}" is not a branch or tag of ${repoSlug(url)}`);
  const guide = buildGuide(url, revision, (file) => readRemoteFile(url, revision, file, env));
  return formatGuide(guide, {
    ...(args.flags.copy === true ? { copied: copyToClipboard(guide.script, env) } : {}),
    ...(args.flags.open === true ? { opened: openBrowser(CREATE_URL, env) } : {}),
  });
}

/** owner/name of the current folder's GitHub origin: the repository the /schedule skill checks Claude's access to. */
function currentRepo(env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) return null;
  const url = normalizeRepo(r.stdout.trim());
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url) ? repoSlug(url) : null;
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
  'permission-denied': permissionDenied,
  'session-start': sessionStart,
  stop,
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
    if (KICKS_QUEUE.has(event)) kick(ctx);
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

// src/cli.ts in a git install, dist/src/cli.js in the npm package.
if (/\/src\/cli\.[jt]s$/.test(process.argv[1] ?? '')) {
  process.exitCode = await main(process.argv.slice(2));
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { decide, readHookRules } from '../cloud/kharos-permission.mjs';
import { hookChange, main, parseArgs } from '../src/cli.ts';
import { close, show } from '../src/commands.ts';
import { parseConfig } from '../src/config.ts';
import { formatChecks, runDoctor, type DoctorDeps } from '../src/doctor.ts';
import { ghForge, type Forge, type Gh, type GhResult, type RepoSnapshot } from '../src/forge.ts';
import { preToolUse, postToolUse, type HookInput } from '../src/hook.ts';
import { prepare } from '../src/launch.ts';
import { parseManagedPolicy, type ManagedPolicy } from '../src/managed-policy.ts';
import { HOOK_RULES_PATH, HOOK_SCRIPT_PATH, planHook, shippedScript } from '../src/permission-hook.ts';
import { changeFlags, EMPTY_CHANGE, switchPreflightAuto, switchUnblockAuto } from '../src/permissions.ts';
import { applicable, buildPreflight, commandLines, formatPreflight, selectFiles, simpleCommands, toCandidate, type HistoryPrompt, type PreflightReport } from '../src/preflight.ts';
import { loadRegistry, logPath, updateRegistry } from '../src/registry.ts';
import { captured, HEADS_OK, response, sandbox, T0, writeConfig, type Sandbox } from './helpers.ts';

/** An organization policy with example rules; never a real one. */
const POLICY_JSON = {
  permissions: {
    ask: ['Bash(psql:*)', 'Bash(pg_dump:*)', 'Bash(redis-cli:*)', 'Bash', 'WebFetch(domain:internal.example)'],
    deny: ['Bash(psql -h prod.example:*)'],
  },
};
const POLICY = parseManagedPolicy(JSON.stringify(POLICY_JSON), '/home/test/.claude/remote-settings.json');
const NO_POLICY: ManagedPolicy = { status: 'absent', file: '/home/test/.claude/remote-settings.json' };

const PACKAGE = JSON.stringify({ scripts: { 'db:count': 'psql -h 127.0.0.1 -U dev -d app -c "select count(*) from orders"', test: 'node --test' } });
const DB_SCRIPT = ['#!/bin/sh', '# restore the dev database', 'PGPASSWORD=dev pg_restore -h 127.0.0.1 -U dev -d app "$1"', 'psql -h prod.example -c "select 1"'].join('\n');

function snapshot(files: Record<string, string>): RepoSnapshot {
  return { label: 'example/demo@main', paths: Object.keys(files), files: new Map(Object.entries(files)), unreadable: new Set(), base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) } };
}

function report(files: Record<string, string>, opts: { history?: HistoryPrompt[]; policy?: ManagedPolicy; instruction?: string } = {}): PreflightReport {
  return buildPreflight({ snapshot: snapshot(files), repo: 'https://github.com/example/demo', policy: opts.policy ?? POLICY, history: opts.history ?? [], sessionsRead: opts.history ? 1 : 0, instruction: opts.instruction ?? '' });
}

test('preflight: a line splits into simple commands, without redirections, comments or chaining', () => {
  assert.deepEqual(simpleCommands(`PGPASSWORD=x psql "$URL" -c 'select 1' > out.txt 2>&1 && echo ok # done`), [`PGPASSWORD=x psql "$URL" -c 'select 1'`, 'echo ok']);
  assert.deepEqual(simpleCommands('pg_dump -h localhost app | gzip > dump.gz'), ['pg_dump -h localhost app', 'gzip']);
  assert.deepEqual(simpleCommands('redis-cli ping; cd /x || true'), ['redis-cli ping', 'cd /x', 'true']);
  assert.deepEqual(simpleCommands(`psql -c "a; b | c"`), [`psql -c "a; b | c"`]);
});

test('preflight: a command becomes a pattern whose free-text and variable words are one argument each', () => {
  assert.deepEqual(toCandidate(`PGPASSWORD=x psql "$URL" -c 'select 1'`), { words: ['psql', null, '-c', null], text: `psql "$URL" -c 'select 1'` });
  assert.deepEqual(toCandidate('psql -h 127.0.0.1 -d app')?.words, ['psql', '-h', '127.0.0.1', '-d', 'app']);
  assert.deepEqual(toCandidate('psql -d "app"')?.words, ['psql', '-d', 'app'], 'a quoted plain word stays itself');
  assert.equal(toCandidate('$PSQL -c x'), null, 'a program that is a variable is not a pattern');
  assert.equal(toCandidate('-x'), null);
});

test('preflight: an escaped quote inside double quotes stays in its word', () => {
  // As the shell splits it: three arguments, the last one quoted free text.
  assert.deepEqual(toCandidate('psql -c "select \\"id\\" from t"')?.words, ['psql', '-c', null]);
  assert.deepEqual(toCandidate('echo "a \\$HOME b"')?.words, ['echo', null]);
});

test('preflight: a prompt of an earlier session becomes a prefix rule of its program and subcommands, with none of its values', () => {
  const bash = (command: string): HistoryPrompt => ({ session: 'k-0001', tool: 'Bash', command });
  const r = report({}, {
    history: [
      bash(`psql postgresql://app:S3cr3t@db.x.rds.amazonaws.com:5432/app -c "select 1"`),
      bash('git push origin main'),
      bash('git push origin feature-x'),
      bash('docker compose exec db psql -U dev'),
      bash('redis-cli -a S3cr3t ping'),
      bash('kubectl get pods -n prod'),
      bash('gh pr view 12'),
      bash('git --no-pager log'),
      bash('git -C dir status'),
      bash('kubectl -n prod get pods'),
      bash('npm --prefix web test'),
      bash('docker compose -f x.yml exec db psql'),
      bash('git --unknown-option status'),
    ],
  });
  assert.deepEqual(r.suggestions.map((s) => [s.kind, s.pattern]).sort(), [
    ['prefix', 'Bash(docker compose exec:*)'],
    ['prefix', 'Bash(gh pr view:*)'],
    ['prefix', 'Bash(git log:*)'],
    ['prefix', 'Bash(git push:*)'],
    ['prefix', 'Bash(git status:*)'],
    ['prefix', 'Bash(git:*)'],
    ['prefix', 'Bash(kubectl get pods:*)'],
    ['prefix', 'Bash(npm test:*)'],
    ['prefix', 'Bash(psql:*)'],
    ['prefix', 'Bash(redis-cli:*)'],
  ]);
  // A program built on subcommands with an option it does not know in front: the bare program, shown for review only.
  const bare = r.suggestions.find((s) => s.pattern === 'Bash(git:*)');
  assert.equal(bare?.status, 'review');
  assert.equal(applicable(r).prefix.includes('Bash(git:*)'), false);
  assert.equal(r.suggestions.filter((s) => s.status === 'review').length, 1);
  assert.deepEqual(r.suggestions.find((s) => s.pattern === 'Bash(git push:*)')?.sources, [{ kind: 'history', session: 'k-0001' }], 'the same prefix from two prompts is one rule');
  assert.deepEqual(applicable(r).allow, []);
  const text = formatPreflight(r, { addCommand: 'kharos permissions hook diff {flags} /work/demo', after: [], hookOn: true, auto: false });
  assert.match(text, /\d\. psql <any arguments>\n {5}-> Bash\(psql:\*\)\n {5}-> the organization's ask rule Bash\(psql:\*\) prompts in every cloud session; earlier sessions on this repository waited on it \(k-0001\); it allows psql with any arguments/);
  assert.match(text, /kharos permissions hook diff .*--allow-prefix 'Bash\(psql:\*\)'.* \/work\/demo/);
  assert.match(text, /review before adding: Bash\(git:\*\) \(the subcommand of git could not be told apart from its options; it would allow git with any arguments; so it is not in the command below/);
  assert.doesNotMatch(text, /--allow-prefix 'Bash\(git:\*\)'/);
  for (const word of ['S3cr3t', 'rds.amazonaws.com', 'origin', 'feature-x', '-n prod', 'view 12', '--no-pager', 'x.yml', '--unknown-option']) assert.equal(text.includes(word), false, word);
});

test('preflight: every rule it suggests allows, by the hook\'s own decision, each command it was learned from', () => {
  const sources = ['git --no-pager log', 'git -C dir status', 'kubectl -n prod get pods', 'npm --prefix web test', 'docker compose -f x.yml exec db psql', 'gh -R org/repo pr view 12', 'psql -h 127.0.0.1 -c x'];
  const long = `git log --grep ${'x'.repeat(700)}`;
  const r = report({}, { history: [...sources, long, 'git -c core.pager=less log'].map((command) => ({ session: 'k-0001', tool: 'Bash', command })) });
  const rules = applicable(r);
  assert.deepEqual([...rules.prefix].sort(), ['Bash(docker compose exec:*)', 'Bash(gh pr view:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(kubectl get pods:*)', 'Bash(npm test:*)', 'Bash(psql:*)']);
  const hook = { allow: [], mirror: [], prefix: rules.prefix };
  for (const command of sources) assert.equal(decide({ tool_name: 'Bash', tool_input: { command } }, hook).behavior, 'allow', command);
  // The hook refuses a command over 600 characters whatever the rules, so a long source does not hold Bash(git log:*) back.
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: long } }, hook).behavior, 'deny');
  // git -c can set a pager or an alias, so it is not skipped: the bare program, for review.
  assert.equal(r.suggestions.find((s) => s.pattern === 'Bash(git:*)')?.status, 'review');
});

test('permission hook: a prefix rule matches with the program\'s known global options skipped, never git -c', () => {
  const rules = { allow: [], mirror: [], prefix: ['Bash(git log:*)', 'Bash(kubectl get pods:*)', 'Bash(docker compose exec:*)', 'Bash(npm test:*)'] };
  const ask = (command: string) => decide({ tool_name: 'Bash', tool_input: { command } }, rules).behavior;
  for (const command of ['git log -1', 'git --no-pager log', 'git -C ../other log', 'kubectl -n prod get pods', 'kubectl get pods -A', 'docker compose -f x.yml exec db psql', 'npm --prefix web test']) assert.equal(ask(command), 'allow', command);
  for (const command of ['git -c core.pager=sh log', 'git --no-pager push', 'kubectl -n prod delete pods', 'npm exec x', 'docker run x']) assert.equal(ask(command), 'deny', command);
  // Options that set what the program runs (git's --exec-path and --config-env, npm's script-shell and
  // node-options, as their manuals describe them) are not global options to skip, so the rule does not match.
  const more = { allow: [], mirror: [], prefix: ['Bash(git status:*)', 'Bash(npm test:*)', 'Bash(kubectl get:*)'] };
  const ask2 = (command: string) => decide({ tool_name: 'Bash', tool_input: { command } }, more).behavior;
  for (const command of ['git --exec-path=./dir status', 'git --config-env=core.fsmonitor=VAR status', 'npm --script-shell=./x test', 'npm --node-options=--require=./x.js test']) assert.equal(ask2(command), 'deny', command);
  // A known option written --option=value is skipped like the spaced form.
  assert.equal(ask2('git --git-dir=../other/.git status'), 'allow');
  // The accepted trade-off: --kubeconfig may name a file whose credential plugin runs, and the rule still matches.
  assert.equal(ask2('kubectl --kubeconfig f get pods'), 'allow');
});

test('preflight: a prefix rule that a deny rule covers, or whose program runs other code, is never suggested', () => {
  const settings = JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } });
  const r = report({ '.claude/settings.json': settings }, { history: [{ session: 'k-0001', tool: 'Bash', command: 'rm -rf build' }, { session: 'k-0001', tool: 'Bash', command: 'python3 manage.py check' }] });
  const rm = r.suggestions.find((s) => s.pattern === 'Bash(rm:*)');
  assert.equal(rm?.status, 'refused');
  assert.match(rm?.refusal ?? '', /the deny rule Bash\(rm:\*\) covers it/);
  assert.equal(r.suggestions.find((s) => s.pattern === 'Bash(python3:*)')?.status, 'refused');
  assert.deepEqual(applicable(r), { allow: [], prefix: [] });
});

test('permission hook: prefix rules are planned with the same deny and broad checks, written to the rules file and read back by the hook', () => {
  const empty = { settings: null, script: null, rules: null };
  const plan = planHook(empty, { ...EMPTY_CHANGE, prefix: ['Bash(psql:*)', 'Bash(git push:*)'] }, POLICY);
  const written = plan.changes.find((c) => c.path === HOOK_RULES_PATH)?.after ?? '';
  assert.deepEqual(JSON.parse(written), { version: 1, allow: [], prefix: ['Bash(psql:*)', 'Bash(git push:*)'], mirror: [] });
  assert.match(plan.lines.join('\n'), /prefix rules, any arguments \(2\): Bash\(psql:\*\), Bash\(git push:\*\)/);
  const rules = readHookRules(JSON.parse(written));
  const ask = (command: string) => decide({ tool_name: 'Bash', tool_input: { command } }, rules);
  assert.deepEqual(ask(`psql -h x -c 'select 1'`), { behavior: 'allow', rule: 'Bash(psql:*)', source: 'prefix', broad: false });
  assert.equal(ask('git push --force origin other').behavior, 'allow');
  assert.equal(ask('git pull').behavior, 'deny');
  assert.equal(ask(`psql -h x -c 'select 1' && rm -rf /tmp/x`).behavior, 'deny', 'a chained command is never allowed');
  assert.equal(ask('PGPASSWORD=x psql -h x').behavior, 'deny', 'nor one with a variable in front');
  // The organization's deny rule Bash(psql -h prod.example:*) covers this prefix; a program that runs other commands is broad.
  assert.throws(() => planHook(empty, { ...EMPTY_CHANGE, prefix: ['Bash(psql -h prod.example:*)'] }, POLICY), /prefix rule "Bash\(psql -h prod\.example:\*\)" is refused: the deny rule Bash\(psql -h prod\.example:\*\) covers it/);
  assert.throws(() => planHook(empty, { ...EMPTY_CHANGE, prefix: ['Bash(bash:*)'] }, POLICY), /is refused: it is broad \(bash runs other commands/);
  assert.throws(() => planHook(empty, { ...EMPTY_CHANGE, prefix: ['Bash(git *:*)'] }, POLICY), /its words must be literal/);
  assert.throws(() => readHookRules({ version: 1, allow: [], prefix: ['Bash(sh:*)'], mirror: [] }), /prefix rule "Bash\(sh:\*\)" is not valid: it is broad/);
  // The flags state the same change, word for word.
  const change = hookChange(parseArgs(['--allow-prefix', 'Bash(git push:*)', '--drop', 'Bash(psql:*)']));
  assert.deepEqual([change.prefix, change.drop], [['Bash(git push:*)'], ['Bash(psql:*)']]);
  assert.deepEqual(changeFlags(change), ['--allow-prefix', `'Bash(git push:*)'`, '--drop', `'Bash(psql:*)'`]);
  const dropped = planHook({ ...empty, rules: written }, { ...EMPTY_CHANGE, drop: ['Bash(psql:*)'] }, POLICY);
  assert.deepEqual(JSON.parse(dropped.changes.find((c) => c.path === HOOK_RULES_PATH)?.after ?? '').prefix, ['Bash(git push:*)']);
});

test('automatic preflight: earlier prompts reach the side branch as prefix rules, and none of their words do', () => {
  const sb = sandbox();
  updateRegistry(sb.paths, (reg) => {
    reg.sessions['k-0090'] = { id: 'k-0090', repo: 'https://github.com/example/demo' } as never;
  });
  const cmds = [`psql postgresql://app:S3cr3t@db.x.rds.amazonaws.com:5432/app -c "select 1"`, 'redis-cli -a S3cr3t ping', 'git push origin main'];
  const prompt = (cmd: string) => JSON.stringify({ t: T0, ts: '2026-11-25T18:57:41.000Z', kind: 'permission prompt', tool: 'Bash', text: JSON.stringify({ command: cmd }), truncated: false, key: cmd, seq: 0 });
  fs.mkdirSync(sb.paths.logs, { recursive: true });
  fs.writeFileSync(logPath(sb.paths, 'k-0090'), cmds.map(prompt).join('\n') + '\n');
  const forge = fakeForge({ 'README.md': 'nothing to run' });
  const s = autoPrepare(sb, forge);
  assert.equal(s.preflight?.status, 'applied');
  assert.deepEqual(s.preflight?.status === 'applied' ? [...s.preflight.applied].sort() : [], ['Bash(git push:*)', 'Bash(psql:*)', 'Bash(redis-cli:*)']);
  const rules = JSON.parse(forge.created[0]?.files.find((f) => f.path === HOOK_RULES_PATH)?.content ?? '{}');
  assert.deepEqual([...rules.prefix].sort(), ['Bash(git push:*)', 'Bash(psql:*)', 'Bash(redis-cli:*)']);
  for (const word of ['S3cr3t', 'rds.amazonaws.com', 'origin main']) {
    for (const f of forge.created[0]?.files ?? []) assert.equal(f.content.includes(word), false, `${word} in ${f.path}`);
    assert.equal(fs.readFileSync(sb.paths.preflight, 'utf8').includes(word), false, `${word} in preflight.jsonl`);
  }
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: `psql -h x -c 'select 1'` } }, s.permission_hook!).behavior, 'allow');
});

test('preflight: the command lines of package.json, a Makefile, shell docs and a compose file', () => {
  assert.deepEqual(commandLines('package.json', PACKAGE), ['psql -h 127.0.0.1 -U dev -d app -c "select count(*) from orders"', 'node --test']);
  assert.deepEqual(commandLines('Makefile', 'db:\n\t@psql -d app \\\n\t  -c "select 1"\n\techo $(VAR)\nall: db\n'), ['psql -d app  -c "select 1"']);
  assert.deepEqual(commandLines('docs/db.md', 'Run:\n\n```sh\n$ redis-cli -h 127.0.0.1 ping\n# comment\n```\n\n```json\n{"psql": 1}\n```\n'), ['redis-cli -h 127.0.0.1 ping']);
  assert.deepEqual(commandLines('compose.yml', 'services: {}'), ['docker compose up -d', 'docker compose ps', 'docker compose logs', 'docker compose down']);
  assert.deepEqual(commandLines('package.json', '{not json'), []);
});

test('preflight: the files it reads put the hook first, skip vendored folders and stop at the cap', () => {
  const many = Array.from({ length: 80 }, (_, i) => `scripts/s${i}.sh`);
  const picked = selectFiles(['src/a.ts', 'node_modules/x/run.sh', 'package.json', HOOK_RULES_PATH, '.claude/settings.json', 'docs/a/b.md', 'docs/a/b/c/d.md', 'bin/tool', 'bin/tool.js', ...many]);
  assert.deepEqual(picked.slice(0, 3), ['.claude/settings.json', HOOK_RULES_PATH, 'package.json']);
  assert.equal(picked.includes('node_modules/x/run.sh'), false);
  assert.equal(picked.includes('bin/tool'), true);
  assert.equal(picked.includes('bin/tool.js'), false);
  assert.equal(picked.includes('src/a.ts'), false);
  assert.equal(picked.length, 2 + 60);
});

test('preflight: a repository command an organization ask rule covers is a likely prompt, with a narrow rule and why', () => {
  const r = report({ 'package.json': PACKAGE, 'scripts/db.sh': DB_SCRIPT });
  const psql = r.suggestions.find((s) => s.program === 'psql' && s.status === 'suggested');
  assert.equal(psql?.pattern, 'psql -h 127.0.0.1 -U dev -d app -c *');
  assert.equal(psql?.prompt, 'psql -h 127.0.0.1 -U dev -d app -c <arg>');
  assert.deepEqual(psql?.asks, [{ rule: 'Bash(psql:*)', origin: 'organization' }]);
  assert.deepEqual(psql?.sources, [{ kind: 'repo', file: 'package.json' }]);
  // The variable assignment in front goes; "$1" becomes one argument.
  assert.equal(r.suggestions.find((s) => s.program === 'pg_restore'), undefined, 'no ask rule covers pg_restore, so it is no likely prompt');
  // A command a deny rule covers is never suggested.
  const prod = r.suggestions.find((s) => s.pattern.includes('prod.example'));
  assert.equal(prod?.status, 'refused');
  assert.match(prod?.refusal ?? '', /deny rule Bash\(psql -h prod\.example:\*\) covers it/);
  assert.equal(r.suggestions.some((s) => s.program === 'node'), false, 'a bare Bash ask rule does not make every script line a likely prompt');
  assert.deepEqual(applicable(r), { allow: ['psql -h 127.0.0.1 -U dev -d app -c *'], prefix: [] });
  const states = Object.fromEntries(r.asks.map((a) => [a.rule, a.state]));
  assert.deepEqual(states, { 'Bash(psql:*)': 'suggested', 'Bash(pg_dump:*)': 'open', 'Bash(redis-cli:*)': 'open', Bash: 'every-command', 'WebFetch(domain:internal.example)': 'not-bash' });
});

test('preflight: earlier prompts on the same repository are prefix suggestions, and a repository pattern one covers is not suggested twice', () => {
  const history: HistoryPrompt[] = [
    { session: 'k-0001', tool: 'Bash', command: `psql -h 127.0.0.1 -U dev -d shop -c 'select 2'` },
    { session: 'k-0002', tool: 'Bash', command: 'redis-cli -h 127.0.0.1 info memory' },
    { session: 'k-0002', tool: 'Bash', command: 'cd app && npm run bench | tee out' },
    { session: 'k-0002', tool: 'Bash', command: 'python3 manage.py check' },
    { session: 'k-0002', tool: 'WebFetch', command: null },
    { session: 'k-0003', tool: 'WebFetch', command: null },
  ];
  const r = report({ 'package.json': PACKAGE }, { history, instruction: 'Profile the slow redis-cli calls.' });
  const psql = r.suggestions.find((s) => s.pattern === 'Bash(psql:*)');
  assert.deepEqual([psql?.status, psql?.sources], ['suggested', [{ kind: 'history', session: 'k-0001' }]]);
  const fromRepo = r.suggestions.find((s) => s.pattern === 'psql -h 127.0.0.1 -U dev -d app -c *');
  assert.deepEqual([fromRepo?.status, fromRepo?.coveredBy], ['covered', 'Bash(psql:*)']);
  assert.match(formatPreflight(r, { addCommand: null, after: [], hookOn: true, auto: false }), /covered by the suggested prefix rule Bash\(psql:\*\): psql -h 127\.0\.0\.1 -U dev -d app -c \*/);
  const redis = r.suggestions[0];
  assert.equal(redis?.pattern, 'Bash(redis-cli:*)', 'what the instruction names comes first');
  assert.equal(redis?.mentioned, true);
  assert.equal(r.suggestions.find((s) => s.program === 'python3')?.status, 'refused', 'a program that runs other code is broad, never suggested');
  assert.deepEqual(applicable(r), { allow: [], prefix: ['Bash(redis-cli:*)', 'Bash(psql:*)'] });
  // Commands of the repository merge word by word, where the words that differ become `*`.
  const scripts = JSON.stringify({ scripts: { a: 'psql -h 127.0.0.1 -U dev -d app -c "select 1"', b: 'psql -h 127.0.0.1 -U dev -d shop -c "select 2"' } });
  assert.deepEqual(applicable(report({ 'package.json': scripts })), { allow: ['psql -h 127.0.0.1 -U dev -d * -c *'], prefix: [] });
  assert.equal(r.chained, 1);
  assert.deepEqual(r.otherTools, [{ tool: 'WebFetch', count: 2 }]);
  assert.equal(r.asks.find((a) => a.rule === 'Bash(redis-cli:*)')?.state, 'suggested');
});

test('preflight: what the hook on the branch allows already is not suggested again', () => {
  const settings = JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'node .claude/hooks/kharos-permission.mjs' }] }] } });
  const rules = JSON.stringify({ version: 1, allow: ['psql -h 127.0.0.1 -U dev -d app -c *'], mirror: ['Bash(pg_dump:*)'] });
  const r = report({ 'package.json': PACKAGE, '.claude/settings.json': settings, [HOOK_SCRIPT_PATH]: shippedScript(), [HOOK_RULES_PATH]: rules });
  assert.equal(r.suggestions.find((s) => s.program === 'psql')?.status, 'covered');
  assert.equal(r.asks.find((a) => a.rule === 'Bash(pg_dump:*)')?.state, 'hook');
  assert.equal(r.asks.find((a) => a.rule === 'Bash(psql:*)')?.state, 'hook');
  assert.deepEqual(applicable(r), { allow: [], prefix: [] });
});

test('preflight: an ask rule counts as answered by a prefix rule on the branch only when the prefix covers it', () => {
  const settings = JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'node .claude/hooks/kharos-permission.mjs' }] }] } });
  const rules = JSON.stringify({ version: 1, allow: [], prefix: ['Bash(docker compose exec:*)', 'Bash(redis-cli:*)'], mirror: [] });
  const policy = parseManagedPolicy(JSON.stringify({ permissions: { ask: ['Bash(docker:*)', 'Bash(redis-cli:*)'] } }), 'f');
  const r = report({ '.claude/settings.json': settings, [HOOK_SCRIPT_PATH]: shippedScript(), [HOOK_RULES_PATH]: rules }, { policy });
  // `docker ps` still prompts and the hook denies it, so Bash(docker:*) stays open.
  assert.equal(r.asks.find((a) => a.rule === 'Bash(docker:*)')?.state, 'open');
  assert.equal(r.asks.find((a) => a.rule === 'Bash(redis-cli:*)')?.state, 'hook');
});

test('preflight: the repository ask rules count too, and with no managed settings nothing is guessed', () => {
  const settings = JSON.stringify({ permissions: { ask: ['Bash(docker compose down:*)'] } });
  const r = report({ 'compose.yml': 'services: {}', '.claude/settings.json': settings }, { policy: NO_POLICY });
  assert.deepEqual(applicable(r), { allow: ['docker compose down'], prefix: [] });
  assert.match(r.notes.join('\n'), /no copy of the organization's managed settings/);
});

test('preflight: the output lists likely prompt, rule and why, and the exact command that adds them', () => {
  const r = report({ 'package.json': PACKAGE }, { history: [{ session: 'k-0001', tool: 'WebFetch', command: null }] });
  const text = formatPreflight(r, { addCommand: 'kharos permissions hook diff {flags} /work/demo', after: ['then commit it'], hookOn: false, auto: false });
  assert.match(text, /^permission preflight for example\/demo@main:/);
  assert.match(text, /likely prompt -> suggested narrow rule -> why:\n  1\. psql -h 127\.0\.0\.1 -U dev -d app -c <arg>\n     -> --allow 'psql -h 127\.0\.0\.1 -U dev -d app -c \*'\n     -> the organization's ask rule Bash\(psql:\*\) prompts in every cloud session; the repository runs it \(package\.json\)/);
  assert.match(text, /Bash\(redis-cli:\*\) \(the organization's ask rule\)\n     -> no narrow rule to suggest: nothing in the repository or in earlier sessions runs redis-cli\n     -> if the task needs it, add its exact form .*, or mirror the organization's ask rules/);
  assert.match(text, /to add them:\n  kharos permissions hook enable {3}\(the hook is opt-in and off\)\n  kharos permissions hook diff --allow 'psql -h 127\.0\.0\.1 -U dev -d app -c \*' \/work\/demo\n  then commit it/);
  assert.match(text, /other tools that prompted in earlier sessions \(the hook answers only Bash calls\): WebFetch \(1\)/);
  assert.match(text, /preflight: 1 rule\(s\) to suggest, 2 ask rule\(s\) with none; automatic preflight off$/);
  const bypassOff = buildPreflight({ snapshot: snapshot({}), repo: null, policy: parseManagedPolicy(JSON.stringify({ permissions: { ask: ['Bash(redis-cli:*)'], disableBypassPermissionsMode: 'disable' } }), 'f'), history: [], sessionsRead: 0, instruction: '' });
  assert.doesNotMatch(formatPreflight(bypassOff, { addCommand: null, after: [], hookOn: true, auto: false }), /mirror/, 'no mirroring offered where kharos refuses it');
});

// --- the CLI on a local checkout -------------------------------------------------------------

function checkoutWith(sb: Sandbox, files: Record<string, string>): string {
  const dir = path.join(sb.dir, 'checkout');
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:example/demo.git');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}

function writePolicy(sb: Sandbox): void {
  fs.mkdirSync(path.join(sb.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.claude', 'remote-settings.json'), JSON.stringify(POLICY_JSON));
}

test('preflight: `kharos permissions preflight <checkout>` reads the checkout, the managed settings and earlier logs', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  writePolicy(sb);
  const dir = checkoutWith(sb, { 'package.json': PACKAGE, 'docs/ops.md': '```bash\nredis-cli -h 127.0.0.1 ping\n```\n' });
  // An earlier session on the same repository waited on a pg_dump prompt.
  updateRegistry(sb.paths, (reg) => {
    reg.sessions['k-0001'] = { id: 'k-0001', repo: 'https://github.com/example/demo' } as never;
    reg.sessions['k-0002'] = { id: 'k-0002', repo: 'https://github.com/example/other' } as never;
  });
  const prompt = (cmd: string) => JSON.stringify({ t: T0, ts: '2026-11-25T18:57:41.000Z', kind: 'permission prompt', tool: 'Bash', text: JSON.stringify({ command: cmd }), truncated: false, key: cmd, seq: 0 });
  fs.mkdirSync(sb.paths.logs, { recursive: true });
  fs.writeFileSync(logPath(sb.paths, 'k-0001'), prompt('pg_dump -h 127.0.0.1 -U dev app') + '\n');
  fs.writeFileSync(logPath(sb.paths, 'k-0002'), prompt('pg_dump -h other') + '\n');
  const r = await captured(() => main(['permissions', 'preflight', dir], sb.env, () => 'Dump the orders table with pg_dump.'));
  assert.equal(r.value, 0, r.stderr);
  assert.match(r.stdout, /1\. pg_dump <any arguments>\n     -> Bash\(pg_dump:\*\)\n     -> the organization's ask rule Bash\(pg_dump:\*\) prompts in every cloud session; earlier sessions on this repository waited on it \(k-0001\); it allows pg_dump with any arguments\n/);
  assert.match(r.stdout, /redis-cli -h 127\.0\.0\.1 ping[\s\S]*the repository runs it \(docs\/ops\.md\)/);
  assert.doesNotMatch(r.stdout, /pg_dump -h/, 'no word of an earlier prompt is shown');
  assert.doesNotMatch(r.stdout, /the instruction mentions/, 'no instruction is read without --stdin or --file');
  assert.match(r.stdout, new RegExp(`kharos permissions hook diff --allow-prefix 'Bash\\(pg_dump:\\*\\)' --allow .* ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  assert.doesNotMatch(r.stdout, /kharos permissions hook enable/, 'the hook is on already');
  const withTask = await captured(() => main(['permissions', 'preflight', dir, '--stdin'], sb.env, () => 'Dump the orders table with pg_dump.'));
  assert.match(withTask.stdout, /the instruction mentions pg_dump/);
});

test('preflight: automatic mode is switched on only while the permission hook is on', async () => {
  const sb = sandbox();
  writeConfig(sb);
  assert.throws(() => switchPreflightAuto(sb.paths, true), /kharos permissions hook enable/);
  writeConfig(sb, { permission_hook: true });
  assert.match(switchPreflightAuto(sb.paths, true), /preflight_auto is on/);
  assert.equal(JSON.parse(fs.readFileSync(sb.paths.config, 'utf8')).preflight_auto, true);
  const r = await captured(() => main(['permissions', 'auto', 'preflight', 'maybe'], sb.env));
  assert.equal(r.value, 1);
  assert.match(switchPreflightAuto(sb.paths, false), /applies nothing/);
  assert.equal((await captured(() => main(['permissions', 'auto', 'preflight', 'on'], sb.env))).value, 0);
  assert.equal(JSON.parse(fs.readFileSync(sb.paths.config, 'utf8')).preflight_auto, true);
  assert.throws(() => parseConfig({ version: 1, preflight_auto: 'yes' }), /preflight_auto must be true or false/);
  assert.equal(parseConfig({ version: 1 }).preflight_auto, false);
});

// --- GitHub through gh -----------------------------------------------------------------------

interface Call {
  args: string[];
  input?: string;
}

function fakeGh(answer: (args: string[], input?: string) => Partial<GhResult>): { gh: Gh; calls: Call[] } {
  const calls: Call[] = [];
  const gh: Gh = (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    return { status: 0, stdout: '', stderr: '', ...answer(args, input) };
  };
  return { gh, calls };
}

const C = 'c'.repeat(40);
const T = 'd'.repeat(40);
const N = 'e'.repeat(40);

test('forge: a branch is read as its file list and one GraphQL call, with each path as a variable', () => {
  const { gh, calls } = fakeGh((args) => {
    if (args[1]?.startsWith('repos/example/demo/commits?sha=team%2Fmain')) return { stdout: `${C} ${T}\n` };
    if (args[1]?.startsWith(`repos/example/demo/git/trees/${T}`)) return { stdout: 'package.json\nsrc/a.ts\nlogo.png\n' };
    if (args[1] === 'graphql') return { stdout: JSON.stringify({ data: { repository: { f0: { text: PACKAGE, isBinary: false } } } }) };
    return { status: 1, stderr: 'unexpected' };
  });
  const r = ghForge(gh).snapshot('https://github.com/example/demo', 'team/main', selectFiles);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([...r.snapshot.files.keys()], ['package.json']);
  assert.deepEqual(r.snapshot.base, { commit: C, tree: T });
  const g = calls[2]?.args ?? [];
  assert.ok(g.includes(`e0=${C}:package.json`));
  assert.doesNotMatch(g.find((a) => a.startsWith('query=')) ?? '', /package\.json/, 'no path goes into the query text');
});

test('forge: a side branch is one commit on top of the base, never over an existing branch, and only a kharos name', () => {
  const answers: Record<string, Partial<GhResult>> = {
    'git/ref/heads/kharos/k-0001': { status: 1, stderr: 'gh: Not Found (HTTP 404)' },
    'git/trees': { stdout: `${T}\n` },
    'git/commits': { stdout: `${N}\n` },
    'git/refs': { stdout: `${N}\n` },
  };
  const { gh, calls } = fakeGh((args) => answers[Object.keys(answers).find((k) => args.some((a) => a.endsWith(k))) ?? ''] ?? { status: 1, stderr: 'unexpected' });
  const forge = ghForge(gh);
  const r = forge.createBranch('https://github.com/example/demo', 'kharos/k-0001', { commit: C, tree: 'f'.repeat(40) }, [{ path: HOOK_RULES_PATH, content: '{}\n' }], 'chore: hook');
  assert.deepEqual(r, { ok: true, commit: N });
  assert.deepEqual(JSON.parse(calls[1]?.input ?? ''), { base_tree: 'f'.repeat(40), tree: [{ path: HOOK_RULES_PATH, mode: '100644', type: 'blob', content: '{}\n' }] });
  assert.deepEqual(JSON.parse(calls[2]?.input ?? ''), { message: 'chore: hook', tree: T, parents: [C] });
  assert.deepEqual(JSON.parse(calls[3]?.input ?? ''), { ref: 'refs/heads/kharos/k-0001', sha: N });

  const exists = ghForge(fakeGh(() => ({ stdout: `${C}\n` })).gh).createBranch('https://github.com/example/demo', 'kharos/k-0001', { commit: C, tree: T }, [], 'm');
  assert.deepEqual(exists, { ok: false, error: 'the branch kharos/k-0001 exists already; kharos never overwrites a branch' });
  const other = fakeGh(() => ({}));
  assert.equal(ghForge(other.gh).createBranch('https://github.com/example/demo', 'main', { commit: C, tree: T }, [], 'm').ok, false);
  assert.equal(ghForge(other.gh).deleteBranch('https://github.com/example/demo', 'main').ok, false);
  assert.equal(other.calls.length, 0, 'nothing is sent for a branch kharos does not own');
  assert.deepEqual(ghForge(fakeGh(() => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' })).gh).branchTip('https://github.com/example/demo', 'kharos/k-0001'), { ok: true, tip: null });
});

// --- automatic preflight at launch --------------------------------------------------------------

interface FakeForge extends Forge {
  created: { name: string; files: { path: string; content: string }[] }[];
  deleted: string[];
  tips: Map<string, string>;
}

function fakeForge(files: Record<string, string>, opts: { failCreate?: string } = {}): FakeForge {
  const f: FakeForge = {
    created: [],
    deleted: [],
    tips: new Map(),
    snapshot: (_repo, _rev, select) => {
      const snap = snapshot(files);
      const picked = new Set(select(Object.keys(files)));
      return { ok: true, snapshot: { ...snap, files: new Map([...snap.files].filter(([p]) => picked.has(p))) } };
    },
    createBranch: (_repo, name, _base, written) => {
      if (opts.failCreate) return { ok: false, error: opts.failCreate };
      f.created.push({ name, files: written });
      f.tips.set(name, N);
      return { ok: true, commit: N };
    },
    branchTip: (_repo, name) => ({ ok: true, tip: f.tips.get(name) ?? null }),
    deleteBranch: (_repo, name) => {
      f.deleted.push(name);
      f.tips.delete(name);
      return { ok: true };
    },
  };
  return f;
}

const CLAUDE = 'claude-session-1';
function hook(ti: Record<string, unknown>, tool_response?: unknown): HookInput {
  return { hook_event_name: tool_response === undefined ? 'PreToolUse' : 'PostToolUse', session_id: CLAUDE, tool_name: 'RemoteTrigger', tool_input: ti, tool_response };
}

function autoPrepare(sb: Sandbox, forge: Forge, config: Record<string, unknown> = { permission_hook: true, preflight_auto: true }) {
  writeConfig(sb, config);
  return prepare(sb.paths, {
    instruction: 'Find why the orders query is slow; use psql.',
    claude_session: CLAUDE,
    now: T0,
    env: sb.env,
    heads: () => HEADS_OK,
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    managedPolicy: () => POLICY,
    forge,
  });
}

test('automatic preflight: the narrow rules go to a side branch kharos/<id>, the session starts there and is told to keep the commit out', () => {
  const sb = sandbox();
  const forge = fakeForge({ 'package.json': PACKAGE, 'scripts/db.sh': DB_SCRIPT, '.claude/settings.json': '{\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}\n' });
  const s = autoPrepare(sb, forge);
  assert.equal(s.revision, 'kharos/k-0001');
  assert.deepEqual(s.preflight, { status: 'applied', branch: 'kharos/k-0001', base: 'main', commit: N, applied: ['psql -h 127.0.0.1 -U dev -d app -c *'], mirrored: [], unblock: false, note: null, deleted_at: null });
  // The three files of the hook, through the same plan as `kharos permissions hook diff`: no broad rule, no mirror.
  const written = Object.fromEntries((forge.created[0]?.files ?? []).map((f) => [f.path, f.content]));
  assert.deepEqual(Object.keys(written).sort(), ['.claude/hooks/kharos-permission.mjs', '.claude/kharos-permissions.json', '.claude/settings.json']);
  assert.deepEqual(JSON.parse(written[HOOK_RULES_PATH] as string), { version: 1, allow: ['psql -h 127.0.0.1 -U dev -d app -c *'], mirror: [] });
  assert.equal(written[HOOK_SCRIPT_PATH], shippedScript());
  assert.deepEqual(JSON.parse(written['.claude/settings.json'] as string).permissions, { deny: ['Bash(rm:*)'] }, 'every other key of the settings stays');
  // The watcher attributes the hook's decisions with the rules of the side branch.
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'psql -h 127.0.0.1 -U dev -d app -c "select 1"' } }, s.permission_hook!).behavior, 'allow');
  // The log of what was applied, per session.
  const logged = JSON.parse(fs.readFileSync(sb.paths.preflight, 'utf8').trim());
  assert.deepEqual({ ...logged, at: undefined }, { at: undefined, kharos: 'k-0001', repo: 'https://github.com/example/demo', base: 'main', branch: 'kharos/k-0001', commit: N, applied: ['psql -h 127.0.0.1 -U dev -d app -c *'], mirrored: [], unblock: false });

  // The routine body that RemoteTrigger create receives.
  const pre = preToolUse(sb.ctx(T0), hook({ action: 'create', body: { kharos_launch: 'k-0001' } }));
  const body = (pre?.hookSpecificOutput as any).updatedInput.body;
  assert.deepEqual(body.job_config.ccr.session_context.sources, [{ git_repository: { url: 'https://github.com/example/demo', revision: 'kharos/k-0001' } }]);
  const content: string = body.job_config.ccr.events[0].data.message.content;
  assert.match(content, new RegExp(`This session starts on branch kharos/k-0001: main plus one commit, ${N}, that only adds the kharos permission hook`));
  assert.match(content, new RegExp(`git fetch origin main\` and then \`git rebase --onto FETCH_HEAD ${N}\`.*open the pull request against main`));
  assert.match(show(sb.paths, 'k-0001'), /permission preflight: 1 allow rule\(s\) on the side branch kharos\/k-0001 \(from main/);

  // Launch it, then close it: the side branch goes, and only once.
  postToolUse(sb.ctx(T0), hook({ action: 'create', body }, response(200, { trigger: { id: 'trig_01TESTROUTINEAAAAAAAAAAA' } })));
  assert.match(close(sb.paths, 'k-0001', T0 + 1000, forge), /Deleted the side branch kharos\/k-0001 of example\/demo/);
  assert.deepEqual(forge.deleted, ['kharos/k-0001']);
  const after = loadRegistry(sb.paths).sessions['k-0001']!.preflight;
  assert.equal(after?.status === 'applied' && after.deleted_at !== null, true);
  close(sb.paths, 'k-0001', T0 + 2000, forge);
  assert.deepEqual(forge.deleted, ['kharos/k-0001']);
});

test('automatic preflight: a side branch with commits kharos did not make is kept at close', () => {
  const sb = sandbox();
  const forge = fakeForge({ 'package.json': PACKAGE });
  autoPrepare(sb, forge);
  forge.tips.set('kharos/k-0001', 'f'.repeat(40));
  assert.match(close(sb.paths, 'k-0001', T0, forge), /was kept: it has commits kharos did not make; delete it yourself .*git push origin --delete kharos\/k-0001/);
  assert.deepEqual(forge.deleted, []);
});

test('automatic preflight: off, inactive without the hook, or failing, the session starts on its own branch', () => {
  const files = { 'package.json': PACKAGE };
  const off = sandbox();
  const f0 = fakeForge(files);
  assert.equal(autoPrepare(off, f0, { permission_hook: true }).revision, 'main');
  assert.equal(loadRegistry(off.paths).sessions['k-0001']!.preflight, null);
  assert.equal(f0.created.length, 0);

  const noHook = sandbox();
  const s1 = autoPrepare(noHook, fakeForge(files), { preflight_auto: true });
  assert.equal(s1.revision, 'main');
  assert.deepEqual(s1.preflight, { status: 'skipped', reason: 'preflight_auto is on, but permission_hook is off, so nothing was applied' });

  const failing = sandbox();
  const s2 = autoPrepare(failing, fakeForge(files, { failCreate: 'HTTP 403' }));
  assert.equal(s2.revision, 'main');
  assert.match(s2.preflight?.status === 'skipped' ? s2.preflight.reason : '', /kharos\/k-0001 could not be created \(HTTP 403\); the session starts on main without the suggested rules/);
  const pre = preToolUse(failing.ctx(T0), hook({ action: 'create', body: { kharos_launch: 'k-0001' } }));
  assert.equal((pre?.hookSpecificOutput as any).updatedInput.body.job_config.ccr.session_context.sources[0].git_repository.revision, 'main');

  const nothing = sandbox();
  const s3 = autoPrepare(nothing, fakeForge({ 'README.md': 'nothing to run' }));
  assert.deepEqual(s3.preflight, { status: 'skipped', reason: 'the preflight found no narrow rule to apply' });
});

test('automatic preflight: the rules file it writes is one the hook reads', () => {
  const sb = sandbox();
  const forge = fakeForge({ 'package.json': PACKAGE });
  autoPrepare(sb, forge);
  const rules = forge.created[0]?.files.find((f) => f.path === HOOK_RULES_PATH)?.content ?? '';
  assert.deepEqual(readHookRules(JSON.parse(rules)), { allow: ['psql -h 127.0.0.1 -U dev -d app -c *'], mirror: [] });
});

test('doctor: says whether automatic preflight is on, and warns when it cannot act', () => {
  const deps: DoctorDeps = {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', account: 'org-test', subscriptionType: 'max' }) as never,
    heads: () => HEADS_OK,
    ownerType: () => null,
    settings: () => ({ status: 'absent' }),
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    setupScript: () => ({ status: 'absent' }),
    managedPolicy: () => NO_POLICY,
  };
  const run = (extra: Record<string, unknown>) => {
    const sb = sandbox();
    writeConfig(sb, extra);
    return formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps));
  };
  assert.match(run({}), /info  permission preflight: automatic preflight is off \(the default\)/);
  assert.match(run({ permission_hook: true, preflight_auto: true }), /info  permission preflight: automatic preflight is on: each launch writes/);
  assert.match(run({ preflight_auto: true }), /warn  permission preflight: preflight_auto is on, but permission_hook is off/);
});

// --- remembered confirmations, and the unblock preset ------------------------------------------------

async function kharos(sb: Sandbox, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await captured(() => main(argv, sb.env, () => ''));
  return { code: r.value, out: r.stdout, err: r.stderr };
}

const tokenOf = (out: string) => /change ([0-9a-f]{12}):/.exec(out)?.[1] ?? '';

function writePolicyJson(sb: Sandbox, policy: unknown): void {
  fs.mkdirSync(path.join(sb.dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.claude', 'remote-settings.json'), JSON.stringify(policy));
}

test('mirror confirmation: asked once, reused while the managed settings match, asked again with what changed', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  const policy = { permissions: { ask: ['Bash(psql:*)'], deny: [] } };
  writePolicyJson(sb, policy);
  const dir = checkoutWith(sb, { 'README.md': '# demo\n' });
  const first = await kharos(sb, 'permissions', 'hook', 'diff', '--mirror', dir);
  assert.match(first.out, /--mirror --org-confirmed/);
  assert.equal((await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(first.out), '--mirror', '--org-confirmed', dir)).code, 0);
  // Take the mirror out and put it back: no second confirmation.
  const off = await kharos(sb, 'permissions', 'hook', 'diff', '--unmirror', dir);
  assert.equal((await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(off.out), '--unmirror', dir)).code, 0);
  const again = await kharos(sb, 'permissions', 'hook', 'diff', '--mirror', dir);
  assert.match(again.out, /you confirmed mirroring the organization's ask rules on \d{4}-\d\d-\d\d, and the organization's managed settings have not changed since: no new confirmation is needed/);
  assert.doesNotMatch(again.out, /--org-confirmed/);
  assert.equal((await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(again.out), '--mirror', dir)).code, 0);
  // Broad mirroring is not covered by a narrow confirmation.
  writePolicyJson(sb, { permissions: { ask: ['Bash(psql:*)', 'Bash(mysql:*)', 'Bash(*.rds.amazonaws.com*)'], deny: [] } });
  const changed = await kharos(sb, 'permissions', 'hook', 'diff', '--mirror', dir);
  assert.match(changed.out, /changed since you confirmed mirroring the organization's ask rules on .* \(ask rules added: Bash\(mysql:\*\), Bash\(\*\.rds\.amazonaws\.com\*\)\): it needs your confirmation again/);
  assert.match(changed.out, /--mirror --org-confirmed/);
  const refused = await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(changed.out), '--mirror', dir);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /written only with --org-confirmed.*ask rules added/);
  assert.equal((await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(changed.out), '--mirror', '--org-confirmed', dir)).code, 0);
  const broad = await kharos(sb, 'permissions', 'hook', 'diff', '--mirror', '--broad', dir);
  assert.match(broad.out, /covered narrow rules only, and this change mirrors broad ones/);
  assert.equal((await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(broad.out), '--mirror', '--broad', '--org-confirmed', dir)).code, 0);
});

test('automatic preflight: the organization ask rules are mirrored with a remembered confirmation that still matches, and never broad ones', async () => {
  const { saveConfirmation } = await import('../src/org-confirmations.ts');
  const sb = sandbox();
  if (POLICY.status !== 'found') throw new Error('test policy');
  saveConfirmation(sb.paths, 'mirror', POLICY, T0);
  const forge = fakeForge({ 'package.json': PACKAGE });
  const s = autoPrepare(sb, forge);
  assert.equal(s.preflight?.status, 'applied');
  if (s.preflight?.status !== 'applied') return;
  assert.deepEqual(s.preflight.mirrored, ['Bash(psql:*)', 'Bash(pg_dump:*)', 'Bash(redis-cli:*)']);
  const rules = JSON.parse(forge.created[0]?.files.find((f) => f.path === HOOK_RULES_PATH)?.content ?? '{}');
  assert.equal(rules.broad, undefined);
  assert.equal(rules.unblock, undefined);

  const changed = sandbox();
  saveConfirmation(changed.paths, 'mirror', { ...POLICY, ask: ['Bash(psql:*)'] }, T0);
  const s2 = autoPrepare(changed, fakeForge({ 'package.json': PACKAGE }));
  assert.equal(s2.preflight?.status === 'applied' && s2.preflight.mirrored?.length, 0);
  assert.match(s2.preflight?.status === 'applied' ? (s2.preflight.note ?? '') : '', /ask rules added: Bash\(pg_dump:\*\), Bash\(redis-cli:\*\), Bash, WebFetch.*were not mirrored/);
});

test('unblock: the hook allows every prompt of any tool, still naming a rule that matched, and never with unusable rules', () => {
  const rules = readHookRules({ version: 1, unblock: true, allow: ['psql -d *'], mirror: [] });
  assert.deepEqual(decide({ tool_name: 'WebFetch', tool_input: { url: 'https://internal.example' } }, rules), { behavior: 'allow', rule: 'unblock', source: 'unblock', broad: true });
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'cd /x && psql "$URL" | head' } }, rules).behavior, 'allow');
  assert.deepEqual(decide({ tool_name: 'Bash', tool_input: { command: 'psql -d app' } }, rules), { behavior: 'allow', rule: 'psql -d *', source: 'allow', broad: false });
  assert.throws(() => readHookRules({ version: 1, unblock: 'yes' }), /"unblock" must be true or false/);
  assert.equal(decide({ tool_name: 'WebFetch' }, { error: 'broken' }).behavior, 'deny');
});

test('unblock: refused when the organization disabled bypass mode, or with no copy of its managed settings', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  const dir = checkoutWith(sb, { 'README.md': '# demo\n' });
  const none = await kharos(sb, 'permissions', 'unblock', dir);
  assert.equal(none.code, 1);
  assert.match(none.err, /the unblock preset: mirroring is unavailable: there is no copy/);
  writePolicyJson(sb, { permissions: { ask: ['Bash(psql:*)'], disableBypassPermissionsMode: 'disable' } });
  const disabled = await kharos(sb, 'permissions', 'unblock', dir);
  assert.match(disabled.err, /the unblock preset: refused: the organization's managed settings set disableBypassPermissionsMode/);
  assert.match((await kharos(sb, 'permissions', 'unblock', 'show')).out, /it is not available: refused/);
});

test('unblock: one confirmation of what it opens, for the managed settings fingerprint, then the diff and the write', async () => {
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  writePolicyJson(sb, POLICY_JSON);
  const dir = checkoutWith(sb, { 'README.md': '# demo\n', '.claude/settings.json': '{"permissions": {"deny": ["Bash(rm:*)"]}}\n' });
  const shown = await kharos(sb, 'permissions', 'unblock', 'show');
  assert.match(shown.out, /every permission prompt in this repository's cloud sessions is allowed, of any tool, with no person asked/);
  assert.match(shown.out, /Amazon RDS, ElastiCache, DocumentDB, or MongoDB Atlas through a connection string/);
  assert.match(shown.out, /what stays: the organization's deny rules \(1\)/);
  const fp = /--fingerprint ([0-9a-f]{16})/.exec(shown.out)?.[1] ?? '';
  const diff = await kharos(sb, 'permissions', 'unblock', dir);
  assert.match(diff.out, /WARNING: this change turns on the unblock preset/);
  assert.equal(diff.out, (await kharos(sb, 'permissions', 'hook', 'diff', '--unblock', dir)).out, 'the alias is the same diff as hook diff --unblock');
  assert.match(diff.out, new RegExp(`first the person confirms what the unblock preset opens .*kharos permissions unblock confirm --fingerprint ${fp}`));
  assert.doesNotMatch(diff.out, /--org-confirmed/, 'the unblock confirmation covers the mirroring');
  const early = await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(diff.out), '--unblock', dir);
  assert.equal(early.code, 1);
  assert.match(early.err, /turns on the unblock preset, and the person has not confirmed what it opens/);
  assert.equal((await kharos(sb, 'permissions', 'unblock', 'confirm', '--fingerprint', '0123456789abcdef')).code, 1);
  assert.match((await kharos(sb, 'permissions', 'unblock', 'confirm', '--fingerprint', fp)).out, /confirmed the unblock preset/);
  const wrote = await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(diff.out), '--unblock', dir);
  assert.equal(wrote.code, 0, wrote.err);
  const rules = JSON.parse(fs.readFileSync(path.join(dir, HOOK_RULES_PATH), 'utf8'));
  assert.equal(rules.unblock, true);
  assert.equal(rules.broad, true);
  assert.deepEqual(rules.mirror, ['Bash(psql:*)', 'Bash(pg_dump:*)', 'Bash(redis-cli:*)', 'Bash'], 'every Bash ask rule, broad ones too');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).permissions, { deny: ['Bash(rm:*)'] }, 'deny rules stay');
  assert.match((await kharos(sb, 'permissions', 'hook', 'show', dir)).out, /any other prompt in a cloud session: allowed, by the unblock preset/);
  const back = await kharos(sb, 'permissions', 'hook', 'diff', '--no-unblock', dir);
  assert.match(back.out, /turns off the unblock preset/);
  assert.equal((await kharos(sb, 'permissions', 'unblock', '--no-unblock', dir)).out, back.out, 'the alias with --no-unblock turns it off too');
  assert.equal((await kharos(sb, 'permissions', 'hook', 'write', '--expect', tokenOf(back.out), '--no-unblock', dir)).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, HOOK_RULES_PATH), 'utf8')).unblock, undefined);
});

test('unblock: the automatic mode puts it on each side branch while the confirmation matches, logs every allow, and the doctor warns', async () => {
  const { saveConfirmation } = await import('../src/org-confirmations.ts');
  const { recordHookDecisions, formatHookDecisions } = await import('../src/approvals.ts');
  const sb = sandbox();
  writeConfig(sb, { permission_hook: true });
  writePolicyJson(sb, POLICY_JSON);
  assert.throws(() => switchUnblockAuto(sb.paths, true, sb.env), /not confirmed/);
  if (POLICY.status !== 'found') throw new Error('test policy');
  saveConfirmation(sb.paths, 'unblock', POLICY, T0);
  assert.match(switchUnblockAuto(sb.paths, true, sb.env), /permission_unblock and preflight_auto are on/);
  const config = JSON.parse(fs.readFileSync(sb.paths.config, 'utf8'));
  assert.equal(config.permission_unblock && config.preflight_auto, true);

  const forge = fakeForge({ 'README.md': 'nothing to run' });
  const s = autoPrepare(sb, forge, config);
  assert.equal(s.preflight?.status === 'applied' && s.preflight.unblock, true);
  assert.equal(JSON.parse(forge.created[0]?.files.find((f) => f.path === HOOK_RULES_PATH)?.content ?? '{}').unblock, true);
  assert.equal(s.permission_hook?.unblock, true);
  // The watcher logs each allow with its tool and the rule that matched.
  const ev = (tool: string, text: string) => ({ t: T0, ts: '2026-11-25T19:00:00.000Z', kind: 'permission prompt', tool, text, truncated: false, key: tool + text, seq: 0 });
  const logged = recordHookDecisions(sb.paths, s, [ev('WebFetch', '{"url":"https://internal.example"}'), ev('Bash', '{"command":"redis-cli -h 127.0.0.1 ping"}')]);
  assert.deepEqual(logged.map((d) => [d.tool, d.decision, d.rule, d.source]), [['WebFetch', 'allow', 'unblock', 'unblock'], ['Bash', 'allow', 'Bash(redis-cli:*)', 'mirror']]);
  assert.match(formatHookDecisions(sb.paths, { all: false, session: null, limit: 10 }), /WebFetch {2}allowed by the unblock preset/);
  // A Bash line cut too short to read its command is still an allow of the preset, and logged.
  const cut = recordHookDecisions(sb.paths, s, [ev('Bash', `{"command":"psql -h 127.0.0.1 -c 'select ${'x'.repeat(700)}`)]);
  assert.deepEqual(cut.map((d) => [d.tool, d.decision, d.rule, d.source]), [['Bash', 'allow', 'unblock', 'unblock']]);

  // A changed policy: no unblock at the next launch, and the note says why.
  const later = parseManagedPolicy(JSON.stringify({ permissions: { ask: ['Bash(psql:*)'], deny: [] } }), 'f');
  writeConfig(sb, config);
  const s2 = prepare(sb.paths, { instruction: 'x', claude_session: CLAUDE, now: T0, env: sb.env, heads: () => HEADS_OK, hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }), managedPolicy: () => later, forge: fakeForge({ 'package.json': PACKAGE }) });
  assert.equal(s2.preflight?.status === 'applied' && s2.preflight.unblock, false);
  assert.match(s2.preflight?.status === 'applied' ? (s2.preflight.note ?? '') : '', /the unblock preset was not applied: the organization's managed settings changed since you confirmed the unblock preset/);

  const deps: DoctorDeps = {
    claudeVersion: () => '2.1.332 (Claude Code)',
    auth: () => ({ loggedIn: true, authMethod: 'claude.ai', account: 'org-test', subscriptionType: 'max' }) as never,
    heads: () => HEADS_OK,
    ownerType: () => null,
    settings: () => ({ status: 'absent' }),
    hookFiles: () => ({ status: 'found', files: { settings: null, script: null, rules: null } }),
    setupScript: () => ({ status: 'absent' }),
    managedPolicy: () => POLICY,
  };
  assert.match(formatChecks(runDoctor(sb.paths, { now: T0, env: sb.env }, deps)), /warn  unblock preset: permission_unblock is on: the side branch of each launch gets the unblock preset/);
});

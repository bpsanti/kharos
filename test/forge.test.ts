import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ghForge, ghSpawnError, realGh } from '../src/forge.ts';
import { sandbox } from './helpers.ts';

/** A fake gh on PATH that runs `body` as a shell script. */
function fakeGh(body: string): NodeJS.ProcessEnv {
  const sb = sandbox();
  const bin = path.join(sb.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ...sb.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
}

test('forge: the file list of a large repository is read whole, past the default output buffer', () => {
  // Two megabytes of paths: twice the one-megabyte default of spawnSync, which a large repository's tree passes.
  const env = fakeGh(
    [
      'case "$*" in',
      `  *commits*) echo "${'a'.repeat(40)} ${'b'.repeat(40)}" ;;`,
      '  *git/trees*) i=0; while [ $i -lt 40000 ]; do printf "src/some/rather/long/folder/name/file-%050d.ts\\n" $i; i=$((i+1)); done ;;',
      'esac',
    ].join('\n'),
  );
  const r = ghForge(realGh(env)).snapshot('https://github.com/example/demo', 'main', () => []);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) assert.equal(r.snapshot.paths.length, 40000);
});

test('forge: only a gh that is not there reads as not installed; other failures say what happened', () => {
  const sb = sandbox();
  const none = realGh({ ...sb.env, PATH: sb.dir })(['api', 'user']);
  assert.equal(none.missing, true);
  assert.equal(none.error, 'gh is not installed');

  const err = (code: string) => Object.assign(new Error(`spawnSync gh ${code}`), { code });
  assert.deepEqual(ghSpawnError(err('ENOBUFS'), 30_000), { missing: false, error: 'gh answered more than 64 MiB' });
  assert.deepEqual(ghSpawnError(err('ETIMEDOUT'), 30_000), { missing: false, error: 'gh did not answer within 30 s' });
  assert.deepEqual(ghSpawnError(err('EACCES'), 30_000), { missing: false, error: 'gh could not run (EACCES)' });

  const slow = realGh(fakeGh('sleep 5'), 300)(['api', 'user']);
  assert.equal(slow.missing, undefined);
  assert.equal(slow.error, 'gh did not answer within 1 s');
  const failed = ghForge(realGh(fakeGh('sleep 5'), 300)).snapshot('https://github.com/example/demo', 'main', () => []);
  assert.deepEqual(failed, { ok: false, error: 'gh did not answer within 1 s' });
});

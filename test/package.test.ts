import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package: the packed tarball installs a working `kharos` command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kharos-pack-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, KHAROS_HOME: path.join(dir, 'kharos'), KHAROS_NODE: process.execPath, npm_config_cache: path.join(dir, 'cache') };
  const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run('npm', ['pack', '--pack-destination', dir]);
    const tarball = fs.readdirSync(dir).find((f) => f.endsWith('.tgz')) as string;
    const prefix = path.join(dir, 'prefix');
    run('npm', ['install', '--global', '--offline', '--no-audit', '--no-fund', '--prefix', prefix, path.join(dir, tarball)]);
    const installed = path.join(prefix, 'lib', 'node_modules', 'kharos');

    // The launcher exits 0 without output when it finds no CLI, so the usage text is what proves it ran.
    assert.match(run(path.join(prefix, 'bin', 'kharos'), ['--help']), /^usage: kharos <command>/);

    // The permission hook is copied into repositories and compared by content: it ships uncompiled.
    const hook = 'cloud/kharos-permission.mjs';
    assert.equal(fs.readFileSync(path.join(installed, 'dist', hook), 'utf8'), fs.readFileSync(path.join(ROOT, hook), 'utf8'));

    assert.ok(!fs.existsSync(path.join(installed, 'src')), 'sources are not shipped');
    assert.ok(!fs.existsSync(path.join(installed, 'test')), 'tests are not shipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

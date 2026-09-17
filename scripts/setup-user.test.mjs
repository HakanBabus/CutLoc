import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runSetup(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'setup-user.mjs'), ...args], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('setup:user writes an isolated command shim and installation record', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-setup-'));
  try {
    const result = await runSetup(['--no-path', '--no-migrate'], { CUTLOC_HOME: home });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.pathUpdated, false);
    const install = JSON.parse(await fsp.readFile(path.join(home, 'install.json'), 'utf8'));
    assert.equal(install.product, 'CutLoc');
    const shim = path.join(home, 'bin', 'cutloc.cmd');
    assert.match(await fsp.readFile(shim, 'utf8'), /apps[\\/]cli[\\/]dist[\\/]index\.js/);
    if (process.platform === 'win32') {
      const invocation = await new Promise((resolve, reject) => {
        const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', shim, '--compact', 'agent', 'guide'], {
          cwd: home,
          env: { ...process.env, CUTLOC_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(invocation.code, 0, invocation.stderr);
      assert.equal(JSON.parse(invocation.stdout).product, 'CutLoc');
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('setup:user migrates legacy data after runtime created empty scaffold folders', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-setup-migrate-'));
  const home = path.join(base, 'home');
  const legacy = path.join(base, 'legacy');
  try {
    await fsp.mkdir(path.join(home, 'data', 'projects'), { recursive: true });
    await fsp.mkdir(path.join(legacy, 'projects', 'legacy-project'), { recursive: true });
    await fsp.writeFile(path.join(legacy, 'projects', 'legacy-project', 'project.json'), '{"id":"legacy-project"}', 'utf8');
    await fsp.writeFile(path.join(legacy, 'settings.json'), '{"language":"tr"}', 'utf8');

    const result = await runSetup(['--no-path'], { CUTLOC_HOME: home, CUTLOC_LEGACY_DATA_DIR: legacy });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.legacyMigration, 'copied');
    assert.deepEqual(output.legacyConflicts, []);
    assert.equal(await fsp.readFile(path.join(home, 'data', 'projects', 'legacy-project', 'project.json'), 'utf8'), '{"id":"legacy-project"}');
    assert.equal(await fsp.readFile(path.join(legacy, 'projects', 'legacy-project', 'project.json'), 'utf8'), '{"id":"legacy-project"}');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('setup:user merges missing legacy projects without overwriting conflicts', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-setup-merge-'));
  const home = path.join(base, 'home');
  const legacy = path.join(base, 'legacy');
  try {
    await fsp.mkdir(path.join(home, 'data', 'projects', 'current'), { recursive: true });
    await fsp.writeFile(path.join(home, 'data', 'projects', 'current', 'project.json'), 'current', 'utf8');
    await fsp.writeFile(path.join(home, 'data', 'settings.json'), 'current-settings', 'utf8');
    await fsp.mkdir(path.join(legacy, 'projects', 'current'), { recursive: true });
    await fsp.mkdir(path.join(legacy, 'projects', 'legacy-only'), { recursive: true });
    await fsp.writeFile(path.join(legacy, 'projects', 'current', 'project.json'), 'legacy-conflict', 'utf8');
    await fsp.writeFile(path.join(legacy, 'projects', 'legacy-only', 'project.json'), 'legacy-only', 'utf8');
    await fsp.writeFile(path.join(legacy, 'settings.json'), 'legacy-settings', 'utf8');

    const result = await runSetup(['--no-path'], { CUTLOC_HOME: home, CUTLOC_LEGACY_DATA_DIR: legacy });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.legacyMigration, 'merged-with-conflicts');
    assert.equal(output.legacyCopied.includes(path.join('projects', 'legacy-only')), true);
    assert.equal(output.legacyConflicts.includes(path.join('projects', 'current')), true);
    assert.equal(output.legacyConflicts.includes('settings.json'), true);
    assert.equal(await fsp.readFile(path.join(home, 'data', 'projects', 'current', 'project.json'), 'utf8'), 'current');
    assert.equal(await fsp.readFile(path.join(home, 'data', 'projects', 'legacy-only', 'project.json'), 'utf8'), 'legacy-only');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('setup:user verifies the PATH update logic without changing the user PATH', { skip: process.platform !== 'win32' }, async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-setup-path-'));
  try {
    const result = await runSetup(['--no-migrate'], {
      CUTLOC_HOME: home,
      CUTLOC_SETUP_TEST_PATH_SCOPE: 'Process',
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.pathUpdated, true);
    assert.equal(output.pathVerified, true);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

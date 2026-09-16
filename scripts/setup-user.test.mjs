import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('setup:user writes an isolated command shim and installation record', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-setup-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts', 'setup-user.mjs'), '--no-path', '--no-migrate'], {
        cwd: root,
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

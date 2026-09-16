#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-release-smoke-'));
const dataDir = path.join(temporaryRoot, 'data');
const cli = path.join(root, 'apps/cli/dist/index.js');
const serverEntry = path.join(root, 'apps/server/dist/start.js');
const ffmpeg = require('ffmpeg-static');

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${signal ?? code}): ${stderr || stdout}`)));
  });
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: { ...process.env, CUTLOC_HOME: path.join(temporaryRoot, 'home'), DATA_DIR: dataDir, PORT: String(port), NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverError = '';
server.stderr.setEncoding('utf8').on('data', (chunk) => { serverError += chunk; });
let projectId;
let trashId;

async function cliJson(...args) {
  return JSON.parse(await run(process.execPath, [cli, '--url', baseUrl, '--compact', ...args]));
}

try {
  let health;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!health?.ok) throw new Error(`Production server did not become ready. ${serverError}`);

  const input = path.join(temporaryRoot, 'input.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  const created = await cliJson('projects', 'create', 'Release smoke');
  projectId = created.id;
  const added = await cliJson('media', 'add', projectId, input, '--wait', '--include-project');
  if (!added.stable) throw new Error('Video import derivatives did not stabilize.');
  const duration = Math.max(0.1, Number(added.asset.duration));
  const plan = JSON.stringify({
    baseRevision: added.project.revision,
    operations: [{ op: 'addClip', trackId: added.project.tracks[0].id, clip: { id: 'clip-smoke', assetId: added.asset.id, type: 'video', name: 'Smoke clip', start: 0, duration, sourceDuration: duration } }],
  });
  await cliJson('projects', 'edit', projectId, '--data', plan);
  const options = JSON.stringify({ format: 'mp4', resolution: '720p', fps: 30, quality: 'draft', fileName: 'release-smoke' });
  const preflight = await cliJson('export', 'preflight', projectId, '--data', options);
  if (!preflight.ok) throw new Error(`Export preflight failed: ${JSON.stringify(preflight)}`);
  const job = await cliJson('export', 'start', projectId, '--data', options);
  const terminal = await cliJson('jobs', 'wait', job.job.id, '--timeout', '90', '--interval', '0.25');
  if (terminal.status !== 'completed') throw new Error(`Export ended in ${terminal.status}.`);
  const output = path.join(temporaryRoot, 'release-smoke.mp4');
  await cliJson('jobs', 'download', job.job.id, '--out', output);
  const exportBytes = (await fsp.stat(output)).size;
  if (exportBytes <= 0) throw new Error('Downloaded export is empty.');
  const deleted = await cliJson('projects', 'delete', projectId);
  projectId = undefined;
  trashId = deleted.trashId;
  if (trashId) await cliJson('trash', 'delete', trashId);
  trashId = undefined;
  process.stdout.write(`${JSON.stringify({ ok: true, health, importedAsset: added.asset.id, exportStatus: terminal.status, exportBytes })}\n`);
} finally {
  if (projectId) {
    try { trashId = (await cliJson('projects', 'delete', projectId)).trashId; } catch { /* best-effort fixture cleanup */ }
  }
  if (trashId) {
    try { await cliJson('trash', 'delete', trashId); } catch { /* best-effort fixture cleanup */ }
  }
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}

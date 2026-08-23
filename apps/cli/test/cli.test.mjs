import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliFile = path.join(repoRoot, 'apps', 'cli', 'dist', 'index.js');
const requests = [];
let baseUrl;

const project = {
  schemaVersion: 1,
  id: 'p1',
  name: 'CLI fixture',
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:00:00.000Z',
  revision: 0,
  canvas: { width: 1920, height: 1080, aspect: '16:9', fitMode: 'fit', fps: 30, background: '#101116' },
  duration: 0,
  assets: [],
  tracks: [],
  markers: [],
};

const server = http.createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, token: request.headers['x-cutloc-access-token'] });
  const json = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === '/api/projects/p1') return json(200, project);
  if (request.method === 'GET' && request.url === '/api/jobs/j1') return json(200, { id: 'j1', projectId: 'p1', kind: 'export', status: 'running' });
  if (request.method === 'DELETE' && request.url === '/api/jobs/j1' && request.headers['x-cutloc-access-token'] === 'test-token') return json(200, { ok: true });
  if (request.method === 'GET' && request.url === '/api/stock/white') {
    response.writeHead(200, { 'content-type': 'image/png' });
    return response.end(Buffer.from([137, 80, 78, 71]));
  }
  if (request.method === 'POST' && request.url === '/api/projects/p1/access') {
    return json(200, {
      lease: { projectId: 'p1', ownerId: 'test-cli', ownerLabel: 'Test CLI', client: 'cli', acquiredAt: '2026-08-23T10:00:00.000Z', expiresAt: '2026-08-23T10:00:15.000Z' },
      token: 'test-token',
    });
  }
  if (request.method === 'PATCH' && request.url === '/api/projects/p1/access') return json(200, { lease: null });
  if (request.method === 'DELETE' && request.url === '/api/projects/p1/access') return json(200, { ok: true });
  return json(404, { error: `Unexpected mock request: ${request.method} ${request.url}` });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function runCli(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, '--url', baseUrl, '--compact', ...args], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI executable returns clean JSON and validates missing arguments', async () => {
  const get = await runCli(['projects', 'get', 'p1']);
  assert.equal(get.code, 0, get.stderr);
  assert.deepEqual(JSON.parse(get.stdout), project);
  assert.equal(get.stdout.trim().startsWith('{'), true);

  const missing = await runCli(['projects', 'get']);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stderr).error, /project ID is required/i);

  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-cli-test-'));
  try {
    const outputFile = path.join(outputDir, 'project.json');
    const written = await runCli(['projects', 'get', 'p1', '--out', outputFile]);
    assert.equal(written.code, 0, written.stderr);
    assert.deepEqual(JSON.parse(await fsp.readFile(outputFile, 'utf8')), project);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('session rejects query-string attempts to reach another project', async () => {
  requests.length = 0;
  const result = await runCli(['session', 'p1'], '{"method":"GET","path":"/api/projects/p2?x=1"}\n');
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(lines[0].ready, true);
  assert.equal(lines[1].ok, false);
  assert.match(lines[1].error, /only access its locked project/i);
  assert.equal(requests.some((entry) => entry.url?.startsWith('/api/projects/p2')), false);
});

test('generic access routes are not wrapped in a second lease and binary output requires --out', async () => {
  requests.length = 0;
  const access = await runCli(['api', 'POST', '/api/projects/p1/access', '--data', '{"ownerId":"manual","ownerLabel":"Manual","client":"cli"}']);
  assert.equal(access.code, 0, access.stderr);
  assert.equal(requests.filter((entry) => entry.url === '/api/projects/p1/access' && entry.method === 'POST').length, 1);

  const binary = await runCli(['api', 'GET', '/api/stock/white']);
  assert.equal(binary.code, 1);
  assert.match(JSON.parse(binary.stderr).error, /binary data.*--out/i);
});

test('job cancellation acquires the owning project lease', async () => {
  requests.length = 0;
  const result = await runCli(['jobs', 'cancel', 'j1']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  const cancelled = requests.find((entry) => entry.url === '/api/jobs/j1' && entry.method === 'DELETE');
  assert.equal(cancelled?.token, 'test-token');
  assert.equal(requests.some((entry) => entry.url === '/api/projects/p1/access' && entry.method === 'POST'), true);
  assert.equal(requests.some((entry) => entry.url === '/api/projects/p1/access' && entry.method === 'DELETE'), true);
});

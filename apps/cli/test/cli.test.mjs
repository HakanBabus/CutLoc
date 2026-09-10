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

const server = http.createServer(async (request, response) => {
  let rawBody = '';
  for await (const chunk of request) rawBody += chunk;
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    body = rawBody;
  }
  requests.push({ method: request.method, url: request.url, token: request.headers['x-cutloc-access-token'], body });
  const json = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === '/api/health') return json(200, { ok: true, ffmpeg: true, ffprobe: true });
  if (request.method === 'GET' && request.url === '/api/settings') return json(200, { language: 'en', proxyQuality: 'balanced' });
  if (request.method === 'GET' && request.url === '/api/projects') return json(200, [{ id: 'p1', name: project.name, revision: project.revision }]);
  if (request.method === 'GET' && request.url === '/api/jobs') return json(200, [{ id: 'j1', projectId: 'p1', status: 'running' }]);
  if (request.method === 'GET' && request.url === '/api/projects/p1/media-health') return json(200, []);
  if (request.method === 'GET' && request.url === '/api/projects/p1/backups') return json(200, []);
  if (request.method === 'POST' && request.url === '/api/projects') return json(200, { ...project, id: 'created', name: body?.name ?? 'Untitled' });
  if (request.method === 'GET' && request.url === '/api/projects/p1') return json(200, project);
  if (request.method === 'PATCH' && request.url === '/api/projects/p1' && request.headers['x-cutloc-access-token'] === 'test-token') return json(200, { ...project, ...body, revision: 1 });
  if (request.method === 'GET' && request.url === '/api/projects/p1/bundle') {
    response.writeHead(200, { 'content-type': 'application/zip' });
    return response.end(Buffer.from([80, 75, 3, 4]));
  }
  if (request.method === 'GET' && request.url === '/api/jobs/j1') return json(200, { id: 'j1', projectId: 'p1', kind: 'export', status: 'running' });
  if (request.method === 'DELETE' && request.url === '/api/jobs/j1' && request.headers['x-cutloc-access-token'] === 'test-token') return json(200, { ok: true });
  if (request.method === 'GET' && request.url === '/api/jobs/j1/download') {
    response.writeHead(200, { 'content-type': 'video/mp4' });
    return response.end(Buffer.from([0, 1, 2, 3]));
  }
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

function runRawCli(cliArgs, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...cliArgs], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runCli(args, input = '') {
  return runRawCli(['--url', baseUrl, '--compact', ...args], input);
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

test('CLI keeps startup validation errors machine-readable', async () => {
  const invalidUrl = await runRawCli(['--url', 'not-a-url', '--compact', 'projects', 'list']);
  assert.equal(invalidUrl.code, 1);
  assert.equal(invalidUrl.stdout, '');
  assert.match(JSON.parse(invalidUrl.stderr).error, /invalid url/i);

  const nonLoopback = await runRawCli(['--url', 'http://192.0.2.1:4173', '--compact', 'projects', 'list']);
  assert.equal(nonLoopback.code, 1);
  assert.equal(nonLoopback.stdout, '');
  assert.match(JSON.parse(nonLoopback.stderr).error, /loopback/i);

  const missingUrl = await runRawCli(['--url', '--compact', 'projects', 'list']);
  assert.equal(missingUrl.code, 1);
  assert.equal(missingUrl.stdout, '');
  assert.match(JSON.parse(missingUrl.stderr).error, /--url requires a value/i);
});

test('agent guide is machine-readable and documents the safe full-project workflow', async () => {
  const result = await runCli(['agent', 'guide']);
  assert.equal(result.code, 0, result.stderr);
  const guide = JSON.parse(result.stdout);
  assert.equal(guide.protocolVersion, 1);
  assert.equal(guide.transport.boundary, 'loopback-only');
  assert.ok(guide.recommendedWorkflow.some((step) => /projects get/i.test(step)));
  assert.ok(guide.recommendedWorkflow.some((step) => /revision conflict/i.test(step)));
  assert.ok(guide.projectEditing.clipCapabilities.includes('keyframes'));
  assert.ok(guide.commands.media.some((command) => /media add/i.test(command)));
});

test('agent inspect returns live context and optional project diagnostics', async () => {
  requests.length = 0;
  const overview = await runCli(['agent', 'inspect']);
  assert.equal(overview.code, 0, overview.stderr);
  const overviewBody = JSON.parse(overview.stdout);
  assert.equal(overviewBody.ok, true);
  assert.equal(overviewBody.live.server.ffmpeg, true);
  assert.equal(overviewBody.live.projects[0].id, 'p1');
  assert.equal(overviewBody.live.selectedProject, undefined);

  const detail = await runCli(['agent', 'inspect', 'p1']);
  assert.equal(detail.code, 0, detail.stderr);
  const detailBody = JSON.parse(detail.stdout);
  assert.equal(detailBody.live.selectedProject.id, 'p1');
  assert.deepEqual(detailBody.live.mediaHealth, []);
  assert.deepEqual(detailBody.live.backups, []);
  assert.ok(detailBody.next.some((command) => /projects apply p1/i.test(command)));
  assert.equal(requests.some((entry) => entry.url === '/api/projects/p1/media-health'), true);
});

test('projects create forwards a positional name and rejects unknown options', async () => {
  requests.length = 0;
  const created = await runCli(['projects', 'create', 'CLI', 'created', 'project']);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).name, 'CLI created project');
  assert.equal(requests.find((entry) => entry.method === 'POST' && entry.url === '/api/projects')?.body?.name, 'CLI created project');

  const requestCount = requests.length;
  const invalid = await runCli(['projects', 'create', 'CLI', '--unexpected']);
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.stderr).error, /unexpected argument: --unexpected/i);
  assert.equal(requests.length, requestCount);
});

test('projects apply and binary download paths use the executable contract', async () => {
  requests.length = 0;
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-cli-test-'));
  try {
    const applied = await runCli(['projects', 'apply', 'p1', '--data', JSON.stringify(project)]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).revision, 1);
    const patchRequest = requests.find((entry) => entry.method === 'PATCH' && entry.url === '/api/projects/p1');
    assert.equal(patchRequest?.token, 'test-token');
    assert.equal(requests.some((entry) => entry.method === 'POST' && entry.url === '/api/projects/p1/access'), true);
    assert.equal(requests.some((entry) => entry.method === 'DELETE' && entry.url === '/api/projects/p1/access'), true);

    const bundleFile = path.join(outputDir, 'project.cutloc');
    const bundle = await runCli(['projects', 'bundle', 'p1', '--out', bundleFile]);
    assert.equal(bundle.code, 0, bundle.stderr);
    assert.deepEqual([...await fsp.readFile(bundleFile)], [80, 75, 3, 4]);

    const jobFile = path.join(outputDir, 'job.mp4');
    const download = await runCli(['jobs', 'download', 'j1', '--out', jobFile]);
    assert.equal(download.code, 0, download.stderr);
    assert.deepEqual([...await fsp.readFile(jobFile)], [0, 1, 2, 3]);
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
  assert.equal(requests.some((entry) => entry.url === '/api/projects/p1/access' && entry.method === 'DELETE'), true);
});

test('generic access routes are not wrapped in a second lease and binary output requires --out', async () => {
  requests.length = 0;
  const access = await runCli(['api', 'POST', '/api/projects/p1/access', '--data', '{"ownerId":"manual","ownerLabel":"Manual","client":"cli"}']);
  assert.equal(access.code, 0, access.stderr);
  assert.equal(requests.filter((entry) => entry.url === '/api/projects/p1/access' && entry.method === 'POST').length, 1);

  const binary = await runCli(['api', 'GET', '/api/stock/white']);
  assert.equal(binary.code, 1);
  assert.match(JSON.parse(binary.stderr).error, /binary data.*--out/i);

  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-cli-test-'));
  try {
    const outputFile = path.join(outputDir, 'white.png');
    const written = await runCli(['api', 'GET', '/api/stock/white', '--out', outputFile]);
    assert.equal(written.code, 0, written.stderr);
    assert.deepEqual([...await fsp.readFile(outputFile)], [137, 80, 78, 71]);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
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

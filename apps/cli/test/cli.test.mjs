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
  if (request.method === 'GET' && request.url === '/api/projects') return json(200, [project]);
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
  if (request.method === 'GET' && request.url === '/api/jobs/j2') return json(200, { id: 'j2', projectId: 'p1', kind: 'export', status: 'completed', progress: 1, phase: 'complete' });
  if (request.method === 'POST' && request.url === '/api/projects/p1/media' && request.headers['x-cutloc-access-token'] === 'test-token') {
    return json(201, {
      asset: { id: 'a1', name: 'image.png', type: 'image', mimeType: 'image/png', path: 'media/a1.png', size: 4, duration: 0, width: 1, height: 1, hasAudio: false, createdAt: '2026-08-23T10:00:00.000Z' },
      project: { ...project, revision: 1, assets: [{ id: 'a1', name: 'image.png', type: 'image', mimeType: 'image/png', path: 'media/a1.png', size: 4, duration: 0, width: 1, height: 1, hasAudio: false, createdAt: '2026-08-23T10:00:00.000Z' }] },
      job: { id: 'j2', projectId: 'p1', kind: 'proxy', status: 'queued', progress: 0, createdAt: '2026-08-23T10:00:00.000Z', updatedAt: '2026-08-23T10:00:00.000Z' },
    });
  }
  if (request.method === 'DELETE' && request.url === '/api/jobs/j1' && request.headers['x-cutloc-access-token'] === 'test-token') return json(200, { ok: true });
  if (request.method === 'GET' && request.url === '/api/jobs/j1/download') {
    response.writeHead(200, { 'content-type': 'video/mp4' });
    return response.end(Buffer.from([0, 1, 2, 3]));
  }
  if (request.method === 'GET' && request.url === '/api/projects/p1/preview-frame?time=0.5') {
    response.writeHead(200, { 'content-type': 'image/png' });
    return response.end(Buffer.from([137, 80, 78, 71]));
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
  assert.equal(overviewBody.live.projects[0].assetCount, 0);
  assert.equal('assets' in overviewBody.live.projects[0], false);
  assert.equal(overviewBody.live.projectPage.total, 1);
  assert.equal(overviewBody.live.selectedProject, undefined);

  const noGuide = await runCli(['agent', 'inspect', '--no-guide', '--limit', '1']);
  assert.equal(noGuide.code, 0, noGuide.stderr);
  assert.equal('guide' in JSON.parse(noGuide.stdout), false);

  const detail = await runCli(['agent', 'inspect', 'p1']);
  assert.equal(detail.code, 0, detail.stderr);
  const detailBody = JSON.parse(detail.stdout);
  assert.equal(detailBody.live.selectedProject.id, 'p1');
  assert.deepEqual(detailBody.live.mediaHealth, []);
  assert.deepEqual(detailBody.live.backups, []);
  assert.ok(detailBody.next.some((command) => /projects apply p1/i.test(command)));
  assert.equal(requests.some((entry) => entry.url === '/api/projects/p1/media-health'), true);
});

test('projects create forwards names and agent-friendly canvas presets', async () => {
  requests.length = 0;
  const created = await runCli(['projects', 'create', 'CLI', 'created', 'project']);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).name, 'CLI created project');
  assert.equal(requests.find((entry) => entry.method === 'POST' && entry.url === '/api/projects')?.body?.name, 'CLI created project');

  const shorts = await runCli(['projects', 'create', 'Short', 'demo', '--preset', 'shorts', '--fps', '30']);
  assert.equal(shorts.code, 0, shorts.stderr);
  const shortsRequest = requests.filter((entry) => entry.method === 'POST' && entry.url === '/api/projects').at(-1);
  assert.deepEqual(shortsRequest?.body, { name: 'Short demo', preset: 'shorts', fps: 30 });

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

test('projects edit validates an atomic plan in dry-run mode and applies it under a lease', async () => {
  requests.length = 0;
  const plan = { baseRevision: 0, operations: [{ op: 'setName', name: 'Planlı kurgu' }, { op: 'setCanvas', canvas: { width: 1080, height: 1920, aspect: '9:16', fitMode: 'fill' } }] };
  const dryRun = await runCli(['projects', 'edit', 'p1', '--data', JSON.stringify(plan), '--dry-run']);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const preview = JSON.parse(dryRun.stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.summary.name, 'Planlı kurgu');
  assert.equal(preview.summary.canvas.aspect, '9:16');
  assert.equal(requests.some((entry) => entry.method === 'PATCH' && entry.url === '/api/projects/p1'), false);

  const applied = await runCli(['projects', 'edit', 'p1', '--data', JSON.stringify(plan)]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).revision, 1);
  assert.equal(requests.some((entry) => entry.method === 'PATCH' && entry.url === '/api/projects/p1'), true);
});

test('media add has a compact default response and can wait for a stable derived revision', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-cli-media-'));
  try {
    const file = path.join(outputDir, 'image.png');
    await fsp.writeFile(file, Buffer.from([137, 80, 78, 71]));
    const result = await runCli(['media', 'add', 'p1', file]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.asset.id, 'a1');
    assert.equal(body.revision, 1);
    assert.equal('project' in body, false);

    const waited = await runCli(['media', 'add', 'p1', file, '--wait']);
    assert.equal(waited.code, 0, waited.stderr);
    const stable = JSON.parse(waited.stdout);
    assert.equal(stable.stable, true);
    assert.equal(stable.job.status, 'completed');
    assert.equal(stable.finalRevision, 0);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('media add-many waits for each derived job before starting the next upload', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-cli-media-many-'));
  try {
    requests.length = 0;
    const first = path.join(outputDir, 'first.png');
    const second = path.join(outputDir, 'second.png');
    await Promise.all([
      fsp.writeFile(first, Buffer.from([137, 80, 78, 71])),
      fsp.writeFile(second, Buffer.from([137, 80, 78, 71])),
    ]);

    const result = await runCli(['media', 'add-many', 'p1', first, second, '--wait']);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.count, 2);
    assert.equal(body.results.every((entry) => entry.stable && entry.job.status === 'completed'), true);

    const workflow = requests
      .filter((entry) => entry.url === '/api/projects/p1/media' || entry.url === '/api/jobs/j2')
      .map((entry) => `${entry.method} ${entry.url}`);
    assert.deepEqual(workflow, [
      'POST /api/projects/p1/media',
      'GET /api/jobs/j2',
      'POST /api/projects/p1/media',
      'GET /api/jobs/j2',
    ]);
  } finally {
    await fsp.rm(outputDir, { recursive: true, force: true });
  }
});

test('jobs wait returns terminal JSON and jobs watch emits JSONL progress', async () => {
  const waited = await runCli(['jobs', 'wait', 'j2', '--timeout', '1', '--interval', '0.01']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).status, 'completed');

  const watched = await runCli(['jobs', 'watch', 'j2', '--timeout', '1', '--interval', '0.01']);
  assert.equal(watched.code, 0, watched.stderr);
  const lines = watched.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(lines[0].event, 'job');
  assert.equal(lines.at(-1).event, 'terminal');
});

test('preview frame writes a binary PNG without leaking it to stdout', async () => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-cli-preview-'));
  try {
    const outputFile = path.join(outputDir, 'frame.png');
    const result = await runCli(['preview', 'frame', 'p1', '--time', '0.5', '--out', outputFile]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).time, 0.5);
    assert.deepEqual([...await fsp.readFile(outputFile)], [137, 80, 78, 71]);
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

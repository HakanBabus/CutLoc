import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ffprobePath = require('ffprobe-static').path;
const ffmpegPath = require('ffmpeg-static');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-server-test-'));
process.env.DATA_DIR = dataDir;
const { createServer, serverTestHooks, setRuntimePort } = await import('../dist/index.js');
const { serverT } = await import('../dist/i18n.js');
const app = await createServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const testAddress = app.server.address();
if (typeof testAddress === 'object' && testAddress) setRuntimePort(testAddress.port);

after(async () => {
  serverTestHooks.beforeSave = undefined;
  serverTestHooks.beforeDerivedWrite = undefined;
  serverTestHooks.beforeRelinkMove = undefined;
  serverTestHooks.beforePreviewRender = undefined;
  await app.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function jsonRequest(method, url, body, extraHeaders = {}) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

function makeWavFixture(durationSeconds = 0.4, sampleRate = 8000) {
  const sampleCount = Math.floor(durationSeconds * sampleRate);
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 8000);
    data.writeInt16LE(sample, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function multipartFile(fieldName, fileName, contentType, content) {
  const boundary = '----cutloc-test-boundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, payload: Buffer.concat([head, content, tail]) };
}

async function waitForJob(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: '/api/jobs' });
    const job = response.json().find((item) => item.id === jobId);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Job ${jobId} zaman aşımına uğradı`);
}

function exportFilePath(projectId, fileName) {
  assert.equal(typeof fileName, 'string');
  return path.join(dataDir, 'projects', projectId, 'exports', fileName);
}

function probeVideoDimensions(filePath) {
  const result = spawnSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,r_frame_rate', '-of', 'json', filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'ffprobe failed');
  const stream = JSON.parse(result.stdout).streams?.[0];
  return { width: stream?.width, height: stream?.height, codec: stream?.codec_name, frameRate: stream?.r_frame_rate };
}

function sampleVideoPixel(filePath, time) {
  const result = spawnSync(ffmpegPath, ['-v', 'error', '-ss', String(time), '-i', filePath, '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(result.status, 0, result.stderr?.toString() || 'pixel sample failed');
  assert.equal(result.stdout.length >= 3, true);
  return (result.stdout[0] + result.stdout[1] + result.stdout[2]) / 3;
}

function wavPeak(bytes) {
  const dataOffset = bytes.indexOf(Buffer.from('data'));
  assert.notEqual(dataOffset, -1);
  const sampleStart = dataOffset + 8;
  const sampleEnd = Math.min(bytes.length, sampleStart + bytes.readUInt32LE(dataOffset + 4));
  let peak = 0;
  for (let offset = sampleStart; offset + 1 < sampleEnd; offset += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
  return peak;
}

function brightPixelBounds(filePath, time, width, height) {
  const result = spawnSync(ffmpegPath, ['-v', 'error', '-ss', String(time), '-i', filePath, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || 'frame extraction failed');
  assert.equal(result.stdout.length, width * height * 3);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const brightness = (result.stdout[offset] + result.stdout[offset + 1] + result.stdout[offset + 2]) / 3;
      if (brightness < 100) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  assert.notEqual(maxX, -1, 'expected bright text pixels');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test('health endpoint reports a local server without leaking the absolute data path', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().ffmpeg, true);
  assert.equal(response.json().textRendering, true);
  assert.equal(response.json().dataDir, path.basename(dataDir));
  assert.equal(response.json().dataDir.includes(dataDir), false);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('translation catalogs localize server messages and interpolation values', () => {
  assert.equal(serverT('tr', 'projectNotFound'), 'Proje bulunamadı');
  assert.equal(serverT('en', 'projectNotFound'), 'Project not found');
  assert.equal(serverT('en', 'preflightFpsConvert', { source: 30, fps: 60 }), 'The timeline is 30 FPS and the output will be 60 FPS; frames will be converted on the timeline clock.');
});

test('active UI and route implementations keep Turkish copy in translation catalogs', async () => {
  const webRoot = path.join(repoRoot, 'apps', 'web', 'src');
  const activeUiFiles = (await fsp.readdir(webRoot, { recursive: true }))
    .filter((fileName) => fileName.endsWith('.tsx') && fileName !== 'i18n.tsx');
  const activeUiSource = (await Promise.all(activeUiFiles.map((fileName) => fsp.readFile(path.join(webRoot, fileName), 'utf8'))))
    .join('\n')
    .replaceAll('Türkçe', '');
  assert.doesNotMatch(activeUiSource, /[ÇĞİÖŞÜçğıöşü]/u);

  const serverSource = await fsp.readFile(path.join(repoRoot, 'apps', 'server', 'src', 'index.ts'), 'utf8');
  assert.doesNotMatch(serverSource, /[ÇĞİÖŞÜçğıöşü]/u);
});

test('Windows media helper processes never create visible console windows', async () => {
  const serverSource = await fsp.readFile(path.join(repoRoot, 'apps', 'server', 'src', 'index.ts'), 'utf8');
  assert.match(serverSource, /spawnSync\(process\.platform === 'win32' \? 'where\.exe' : 'which',[^\n]+windowsHide: true/);
  assert.match(serverSource, /spawnSync\(binary, \['-hide_banner', '-filters'\],[^\n]+windowsHide: true/);
  assert.match(serverSource, /spawn\(ffprobe, \['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file\], \{ windowsHide: true \}\)/);
  assert.match(serverSource, /process\.platform === 'win32'[\s\S]+\['msedge', 'chrome'\][\s\S]+chromium\.launch\(\{ headless: true, channel \}\)/);
});

test('project CRUD and revision conflicts work in an isolated data directory', async () => {
  const createdResponse = await jsonRequest('POST', '/api/projects', { name: 'Test proje' });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();
  assert.equal(created.name, 'Test proje');
  assert.equal(created.revision, 0);

  const listResponse = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().some((item) => item.id === created.id), true);
  const listedProject = listResponse.json().find((item) => item.id === created.id);
  assert.equal(Number.isFinite(listedProject?.sizeBytes), true);
  assert.equal(listedProject.sizeBytes > 0, true);

  const updatedResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'Güncel proje', revision: 0 });
  assert.equal(updatedResponse.statusCode, 200);
  assert.equal(updatedResponse.json().name, 'Güncel proje');
  assert.equal(updatedResponse.json().revision, 1);

  const conflictResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'Eski sürüm', revision: 0 });
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(conflictResponse.json().project.revision, 1);
  const missingRevisionResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'Blind overwrite' });
  assert.equal(missingRevisionResponse.statusCode, 409);
  assert.equal(missingRevisionResponse.json().project.revision, 1);
  const stalePreflightResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export/preflight', { projectRevision: 0 });
  assert.equal(stalePreflightResponse.statusCode, 409);
  const staleExportResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { projectRevision: 0, format: 'mp4' });
  assert.equal(staleExportResponse.statusCode, 409);

  const backupsResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id + '/backups' });
  assert.equal(backupsResponse.statusCode, 200);
  assert.equal(backupsResponse.json().length, 1);
  const traversalRestoreResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/restore', { fileName: '../project-123.json' });
  assert.equal(traversalRestoreResponse.statusCode, 400);
  const restoredResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/restore', { fileName: backupsResponse.json()[0].fileName });
  assert.equal(restoredResponse.statusCode, 200);
  assert.equal(restoredResponse.json().name, 'Test proje');

  const readResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id });
  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.json().name, 'Test proje');

  const deletedResponse = await app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
  assert.equal(deletedResponse.statusCode, 200);
  assert.equal(typeof deletedResponse.json().trashId, 'string');
  const trashListResponse = await app.inject({ method: 'GET', url: '/api/trash' });
  assert.equal(trashListResponse.statusCode, 200);
  const trashEntry = trashListResponse.json().find((item) => item.projectId === created.id);
  assert.equal(typeof trashEntry?.trashId, 'string');
  assert.equal(Number.isFinite(trashEntry?.sizeBytes), true);
  assert.equal(new Date(trashEntry.expiresAt).getTime() > new Date(trashEntry.deletedAt).getTime(), true);
  const restoredFromTrashResponse = await app.inject({ method: 'POST', url: '/api/trash/' + trashEntry.trashId + '/restore' });
  assert.equal(restoredFromTrashResponse.statusCode, 200);
  assert.equal(restoredFromTrashResponse.json().id, created.id);
  const deletedAgainResponse = await app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
  assert.equal(deletedAgainResponse.statusCode, 200);
  const purgedResponse = await app.inject({ method: 'DELETE', url: '/api/trash/' + deletedAgainResponse.json().trashId });
  assert.equal(purgedResponse.statusCode, 200);
});

test('project PATCH and DELETE serialize without recreating the active project', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Patch delete race' })).json();
  let releaseSave;
  let enteredSave;
  const saveEntered = new Promise((resolve) => { enteredSave = resolve; });
  const release = new Promise((resolve) => { releaseSave = resolve; });
  serverTestHooks.beforeSave = async (project) => {
    if (project.id !== created.id || project.name !== 'race-save') return;
    enteredSave();
    await release;
  };
  let trashId;
  try {
    const patchPromise = jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'race-save', revision: 0 });
    await saveEntered;
    const deletePromise = app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
    releaseSave();
    const [saveResponse, deleteResponse] = await Promise.all([patchPromise, deletePromise]);
    assert.equal(saveResponse.statusCode, 200);
    assert.equal(deleteResponse.statusCode, 200);
    trashId = deleteResponse.json().trashId;
    const staleSaveResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'must stay deleted', revision: 0 });
    assert.equal(staleSaveResponse.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects' })).json().some((project) => project.id === created.id), false);
    assert.equal((await fsp.stat(path.join(dataDir, 'trash', trashId, 'project.json'))).isFile(), true);
  } finally {
    releaseSave?.();
    serverTestHooks.beforeSave = undefined;
    if (trashId) await app.inject({ method: 'DELETE', url: '/api/trash/' + trashId });
  }
});
test('unknown projects return a safe not-found response', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/projects/project_does_not_exist' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, serverT('en', 'projectNotFound'));
});

test('server rejects locked-track mutations until the track is explicitly unlocked', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Locked server boundary' })).json();
  const locked = structuredClone(created);
  locked.tracks[0].locked = true;
  const lockResponse = await jsonRequest('PATCH', `/api/projects/${created.id}`, locked);
  assert.equal(lockResponse.statusCode, 200);
  const current = lockResponse.json();
  const changed = structuredClone(current);
  changed.tracks[0].name = 'Must not change';
  const rejected = await jsonRequest('PATCH', `/api/projects/${created.id}`, changed);
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().project.tracks[0].name, current.tracks[0].name);
  const unlocked = structuredClone(current);
  unlocked.tracks[0].locked = false;
  unlocked.tracks[0].name = 'Unlocked change';
  const accepted = await jsonRequest('PATCH', `/api/projects/${created.id}`, unlocked);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().tracks[0].name, 'Unlocked change');
});

test('project updates reject managed asset paths that could target project metadata', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Asset boundary' })).json();
  const addedResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/stock', { stockId: 'white' });
  assert.equal(addedResponse.statusCode, 201);
  const project = addedResponse.json().project;
  const maliciousAsset = { ...project.assets[0], path: 'project.json', thumbnailPath: '../project.json' };
  const updateResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { ...project, assets: [maliciousAsset], revision: project.revision });
  assert.equal(updateResponse.statusCode, 400);

  const readResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id });
  assert.equal(readResponse.statusCode, 200);
  assert.match(readResponse.json().assets[0].path.replaceAll('\\', '/'), /^media\//);
  assert.equal((await fsp.stat(path.join(dataDir, 'projects', created.id, 'project.json'))).isFile(), true);
});

test('managed media symlinks cannot expose or delete project metadata', async (context) => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Symlink boundary' })).json();
  const addedResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/stock', { stockId: 'white' });
  assert.equal(addedResponse.statusCode, 201);
  const added = addedResponse.json();
  if (added.job?.id) await waitForJob(added.job.id);
  const asset = added.project.assets[0];
  const source = path.join(dataDir, 'projects', created.id, ...asset.path.replaceAll('\\', '/').split('/'));
  await fsp.rm(source, { force: true });
  try {
    await fsp.symlink('../project.json', source, 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      context.skip('Creating symlinks requires elevated Windows privileges.');
      return;
    }
    throw error;
  }

  const mediaResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media/${asset.id}` });
  assert.notEqual(mediaResponse.statusCode, 200);
  assert.equal(mediaResponse.body.includes('Symlink boundary'), false);
  const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}/media/${asset.id}` });
  assert.equal(deleteResponse.statusCode, 400);
  const projectResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}` });
  assert.equal(projectResponse.statusCode, 200);
  assert.equal(projectResponse.json().assets.some((item) => item.id === asset.id), true);
  assert.equal((await fsp.stat(path.join(dataDir, 'projects', created.id, 'project.json'))).isFile(), true);
});

test('preview rendering has a route-specific request budget', async () => {
  const remoteAddress = '127.0.0.42';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: '/api/projects/missing/preview-frame?time=0', remoteAddress });
    assert.equal(response.statusCode, 400);
  }
  const limitedResponse = await app.inject({ method: 'GET', url: '/api/projects/missing/preview-frame?time=0', remoteAddress });
  assert.equal(limitedResponse.statusCode, 429);
  assert.match(limitedResponse.json().message, /Too many requests/);
});

test('preview rendering caps concurrent browser compositor work', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Preview concurrency' })).json();
  const addedResponse = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  const project = addedResponse.json().project;
  const asset = project.assets[0];
  const clip = { id: 'preview-clip', assetId: asset.id, type: 'image', name: 'Preview', start: 0, duration: 1, sourceDuration: 1 };
  const updatedResponse = await jsonRequest('PATCH', `/api/projects/${created.id}`, { ...project, tracks: project.tracks.map((track, index) => index === 0 ? { ...track, clips: [clip] } : track), revision: project.revision });
  assert.equal(updatedResponse.statusCode, 200);

  let entered = 0;
  let releasePreview;
  let previewsEntered;
  const release = new Promise((resolve) => { releasePreview = resolve; });
  const enteredPromise = new Promise((resolve) => { previewsEntered = resolve; });
  serverTestHooks.beforePreviewRender = async () => {
    entered += 1;
    if (entered === 2) previewsEntered();
    await release;
    throw new Error('controlled preview stop');
  };
  try {
    const first = app.inject({ method: 'GET', url: `/api/projects/${created.id}/preview-frame?time=0`, remoteAddress: '127.0.0.51' });
    const second = app.inject({ method: 'GET', url: `/api/projects/${created.id}/preview-frame?time=0`, remoteAddress: '127.0.0.52' });
    await Promise.race([enteredPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('preview concurrency hook timeout')), 5000))]);
    const blocked = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/preview-frame?time=0`, remoteAddress: '127.0.0.53' });
    assert.equal(blocked.statusCode, 429);
    releasePreview();
    const completed = await Promise.all([first, second]);
    assert.deepEqual(completed.map((response) => response.statusCode), [400, 400]);
  } finally {
    releasePreview?.();
    serverTestHooks.beforePreviewRender = undefined;
  }
});

test('derived media jobs are cancelled by DELETE before they can recreate a project', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Derived delete race' })).json();
  const added = await jsonRequest('POST', '/api/projects/' + created.id + '/stock', { stockId: 'white' });
  assert.equal(added.statusCode, 201);
  const asset = added.json().asset;
  let releaseDerived;
  let enteredDerived;
  const derivedEntered = new Promise((resolve) => { enteredDerived = resolve; });
  const release = new Promise((resolve) => { releaseDerived = resolve; });
  serverTestHooks.beforeDerivedWrite = async (projectId) => {
    if (projectId !== created.id) return;
    enteredDerived();
    await release;
  };
  let trashId;
  try {
    const rebuildPromise = jsonRequest('POST', '/api/projects/' + created.id + '/media/' + asset.id + '/rebuild-derived', {});
    await Promise.race([derivedEntered, new Promise((_, reject) => setTimeout(() => reject(new Error('derived test hook timeout')), 5000))]);
    const deleteResponse = await app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
    assert.equal(deleteResponse.statusCode, 200);
    trashId = deleteResponse.json().trashId;
    releaseDerived();
    const rebuildResponse = await rebuildPromise;
    assert.equal(rebuildResponse.statusCode, 202);
    const job = await waitForJob(rebuildResponse.json().job.id);
    assert.equal(job.status, 'cancelled');
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects' })).json().some((project) => project.id === created.id), false);
    assert.equal((await fsp.stat(path.join(dataDir, 'trash', trashId, 'project.json'))).isFile(), true);
  } finally {
    releaseDerived?.();
    serverTestHooks.beforeDerivedWrite = undefined;
    if (trashId) await app.inject({ method: 'DELETE', url: '/api/trash/' + trashId });
  }
});

test('unknown project duplication returns a safe not-found response', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/projects/project_does_not_exist/duplicate' });
  assert.equal(response.statusCode, 404);
});

test('cross-origin API mutations are rejected', async () => {
  const response = await jsonRequest('POST', '/api/projects', { name: 'blocked' }, { origin: 'https://example.invalid', host: '127.0.0.1:4173' });
  assert.equal(response.statusCode, 403);
});

test('trash listing permanently removes entries older than the retention window', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Expired trash fixture' })).json();
  const deleted = (await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` })).json();
  const currentPath = path.join(dataDir, 'trash', deleted.trashId);
  const expiredTrashId = `${created.id}-${Date.now() - 31 * 24 * 60 * 60 * 1000}`;
  const expiredPath = path.join(dataDir, 'trash', expiredTrashId);
  await fsp.rename(currentPath, expiredPath);

  const response = await app.inject({ method: 'GET', url: '/api/trash' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().some((item) => item.projectId === created.id), false);
  await assert.rejects(() => fsp.stat(expiredPath), { code: 'ENOENT' });
});

test('project creation supports a validated Shorts canvas preset', async () => {
  const response = await jsonRequest('POST', '/api/projects', { name: 'Shorts fixture', preset: 'shorts', fps: 30, background: '#08111f' });
  assert.equal(response.statusCode, 201);
  const created = response.json();
  assert.equal(created.canvas.aspect, '9:16');
  assert.equal(created.canvas.width, 1080);
  assert.equal(created.canvas.height, 1920);
  assert.equal(created.canvas.fitMode, 'fill');
  assert.equal(created.canvas.background, '#08111f');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` })).statusCode, 200);
});

test('CLI access lease force-locks project mutations and releases cleanly', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'CLI lease test' })).json();
  const accessUrl = `/api/projects/${created.id}/access`;
  const firstResponse = await jsonRequest('POST', accessUrl, {
    ownerId: 'cli-test-one', ownerLabel: 'Test CLI one', client: 'cli', ttlMs: 15_000, force: true,
  });
  assert.equal(firstResponse.statusCode, 200);
  const first = firstResponse.json();
  assert.equal(first.lease.projectId, created.id);
  assert.equal(first.lease.ownerLabel, 'Test CLI one');
  assert.equal(typeof first.token, 'string');
  assert.equal('token' in first.lease, false);

  const publicState = await app.inject({ method: 'GET', url: accessUrl });
  assert.equal(publicState.statusCode, 200);
  assert.equal(publicState.json().lease.ownerId, 'cli-test-one');
  assert.equal(JSON.stringify(publicState.json()).includes(first.token), false);

  const blocked = await jsonRequest('PATCH', `/api/projects/${created.id}`, { name: 'web must wait', revision: 0 });
  assert.equal(blocked.statusCode, 423);
  assert.equal(blocked.json().code, 'PROJECT_LOCKED');
  assert.equal(blocked.json().lease.ownerLabel, 'Test CLI one');

  const allowed = await jsonRequest('PATCH', `/api/projects/${created.id}`, { name: 'CLI edit', revision: 0 }, { 'x-cutloc-access-token': first.token });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().name, 'CLI edit');

  const refusedTakeover = await jsonRequest('POST', accessUrl, {
    ownerId: 'cli-test-two', ownerLabel: 'Test CLI two', client: 'cli', force: false,
  });
  assert.equal(refusedTakeover.statusCode, 423);

  const forcedTakeover = await jsonRequest('POST', accessUrl, {
    ownerId: 'cli-test-two', ownerLabel: 'Test CLI two', client: 'cli', force: true,
  });
  assert.equal(forcedTakeover.statusCode, 423);
  const firstRelease = await app.inject({ method: 'DELETE', url: accessUrl, headers: { 'x-cutloc-access-token': first.token } });
  assert.equal(firstRelease.statusCode, 200);
  const takeover = await jsonRequest('POST', accessUrl, {
    ownerId: 'cli-test-two', ownerLabel: 'Test CLI two', client: 'cli', force: false,
  });
  assert.equal(takeover.statusCode, 200);
  const second = takeover.json();
  assert.notEqual(second.token, first.token);
  const staleOwner = await jsonRequest('PATCH', `/api/projects/${created.id}`, { name: 'stale CLI', revision: 1 }, { 'x-cutloc-access-token': first.token });
  assert.equal(staleOwner.statusCode, 423);

  const heartbeat = await jsonRequest('PATCH', accessUrl, { ttlMs: 30_000 }, { 'x-cutloc-access-token': second.token });
  assert.equal(heartbeat.statusCode, 200);
  assert.equal(Date.parse(heartbeat.json().lease.expiresAt) > Date.now(), true);
  const released = await app.inject({ method: 'DELETE', url: accessUrl, headers: { 'x-cutloc-access-token': second.token } });
  assert.equal(released.statusCode, 200);
  const afterRelease = await jsonRequest('PATCH', `/api/projects/${created.id}`, { name: 'Web edit resumed', revision: 1 });
  assert.equal(afterRelease.statusCode, 200);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` });
});

test('CLI takeover serializes with in-flight saves and rejects web writes queued behind it', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'CLI takeover race' })).json();
  let releaseSave;
  let signalSaveEntered;
  const saveEntered = new Promise((resolve) => { signalSaveEntered = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let token;
  try {
    serverTestHooks.beforeSave = async (project) => {
      if (project.id === created.id && project.name === 'in-flight web save') {
        signalSaveEntered();
        await saveGate;
      }
    };
    const inFlightSave = jsonRequest('PATCH', `/api/projects/${created.id}`, { name: 'in-flight web save', revision: 0 });
    await saveEntered;
    let acquireSettled = false;
    const acquire = jsonRequest('POST', `/api/projects/${created.id}/access`, {
      ownerId: 'race-cli', ownerLabel: 'Race CLI', client: 'cli', ttlMs: 15_000, force: false,
    }).then((response) => { acquireSettled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(acquireSettled, false, 'takeover must wait for the in-flight project mutation');
    const queuedWebSave = jsonRequest('PATCH', `/api/projects/${created.id}`, { name: 'must stay blocked', revision: 1 });
    releaseSave();

    assert.equal((await inFlightSave).statusCode, 200);
    const acquired = await acquire;
    assert.equal(acquired.statusCode, 200);
    token = acquired.json().token;
    const blocked = await queuedWebSave;
    assert.equal(blocked.statusCode, 423);
    const finalProject = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
    assert.equal(finalProject.name, 'in-flight web save');
  } finally {
    serverTestHooks.beforeSave = undefined;
    releaseSave?.();
    if (token) await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}/access`, headers: { 'x-cutloc-access-token': token } });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
    if (deleted.statusCode === 200) await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` });
  }
});

test('concurrent non-force CLI acquisitions yield exactly one owner', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'CLI acquire race' })).json();
  const body = (ownerId) => ({ ownerId, ownerLabel: ownerId, client: 'cli', ttlMs: 15_000, force: false });
  const [left, right] = await Promise.all([
    jsonRequest('POST', `/api/projects/${created.id}/access`, body('left-cli')),
    jsonRequest('POST', `/api/projects/${created.id}/access`, body('right-cli')),
  ]);
  assert.deepEqual([left.statusCode, right.statusCode].sort((a, b) => a - b), [200, 423]);
  const winner = left.statusCode === 200 ? left.json() : right.json();
  await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}/access`, headers: { 'x-cutloc-access-token': winner.token } });
  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` });
});

test('bracketed IPv6 localhost hosts are accepted', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '[::1]:4173', origin: 'http://[::1]:5173' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().product, 'CutLoc');
  assert.equal(response.json().version, '1.1.0');
  assert.equal(response.json().apiVersion, 2);
  assert.equal(response.json().activeJobs, 0);
  assert.equal(response.json().activeLeases, 0);
  assert.equal(response.json().activePreviews, 0);
  assert.equal(response.json().busy, false);
});

test('settings validation returns a client error without leaking a server failure', async () => {
  const validResponse = await jsonRequest('PUT', '/api/settings', { language: 'tr', proxyQuality: 'draft', hardwareAcceleration: 'software', experimentalAi: true, aiProvider: 'openai', aiModel: 'test-model', openAiKey: 'temporary-test-key', shortcuts: { togglePlayback: 'P', undo: 'Ctrl/Cmd+U', redo: 'Ctrl/Cmd+Shift+U', split: 'K', setIn: 'J', setOut: 'L', clearRange: 'C', deleteClip: 'Backspace', duplicate: 'Ctrl/Cmd+M', selectAll: 'Ctrl/Cmd+Shift+A' } });
  assert.equal(validResponse.statusCode, 200);
  assert.equal(validResponse.json().experimentalAi, false);
  assert.equal(validResponse.json().hasOpenAiKey, false);
  assert.equal('openAiKey' in validResponse.json(), false);
  assert.equal(validResponse.json().shortcuts.split, 'B');
  assert.equal(validResponse.json().defaultExport.resolution, '1080p');
  assert.equal(validResponse.json().defaultExport.audioBitrateKbps, 256);
  assert.equal(validResponse.json().workspaceLayout.libraryWidth, 232);
  const persistedResponse = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(persistedResponse.json().shortcuts.togglePlayback, 'Space');
  assert.equal(persistedResponse.json().shortcuts.split, 'B');
  const preserveKeyResponse = await jsonRequest('PUT', '/api/settings', { language: 'tr', openAiKey: '' });
  assert.equal(preserveKeyResponse.statusCode, 200);
  assert.equal(preserveKeyResponse.json().hasOpenAiKey, false);
  const englishLanguageResponse = await jsonRequest('PUT', '/api/settings', { language: 'en' });
  assert.equal(englishLanguageResponse.statusCode, 200);
  const invalidResponse = await jsonRequest('PUT', '/api/settings', { language: 'xx' });
  assert.equal(invalidResponse.statusCode, 400);
  const unsupportedEncoderResponse = await jsonRequest('PUT', '/api/settings', { hardwareAcceleration: 'auto' });
  assert.equal(unsupportedEncoderResponse.statusCode, 400);
  const invalidLayoutResponse = await jsonRequest('PUT', '/api/settings', { workspaceLayout: { libraryWidth: 10 } });
  assert.equal(invalidLayoutResponse.statusCode, 400);
});

test('API errors follow the saved interface language', async () => {
  try {
    const turkishSettings = await jsonRequest('PUT', '/api/settings', { language: 'tr' });
    assert.equal(turkishSettings.statusCode, 200);
    const turkishResponse = await app.inject({ method: 'GET', url: '/api/projects/project_does_not_exist' });
    assert.equal(turkishResponse.statusCode, 404);
    assert.equal(turkishResponse.json().error, 'Proje bulunamadı');

    const englishSettings = await jsonRequest('PUT', '/api/settings', { language: 'en' });
    assert.equal(englishSettings.statusCode, 200);
    const englishResponse = await app.inject({ method: 'GET', url: '/api/projects/project_does_not_exist' });
    assert.equal(englishResponse.statusCode, 404);
    assert.equal(englishResponse.json().error, 'Project not found');
  } finally {
    await jsonRequest('PUT', '/api/settings', { language: 'en' });
  }
});

test('media byte ranges clamp an oversized end and reject malformed requests', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Media range fixture' })).json();
  const added = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  assert.equal(added.statusCode, 201);
  const url = `/api/projects/${created.id}/media/${added.json().asset.id}`;
  const full = await app.inject({ method: 'GET', url });
  const size = full.rawPayload.length;
  const oversized = await app.inject({ method: 'GET', url, headers: { range: 'bytes=5-999999999' } });
  assert.equal(oversized.statusCode, 206);
  assert.equal(oversized.headers['content-range'], `bytes 5-${size - 1}/${size}`);
  assert.deepEqual(oversized.rawPayload, full.rawPayload.subarray(5));
  const suffix = await app.inject({ method: 'GET', url, headers: { range: 'bytes=-5' } });
  assert.equal(suffix.statusCode, 206);
  assert.deepEqual(suffix.rawPayload, full.rawPayload.subarray(-5));
  for (const range of ['bytes=-', 'bytes=0-1,4-5', 'garbage bytes=0-1']) {
    const invalid = await app.inject({ method: 'GET', url, headers: { range } });
    assert.equal(invalid.statusCode, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${size}`);
  }
});

test('stock media is enumerated, copied into a project, and served without path leakage', async () => {
  const catalogResponse = await app.inject({ method: 'GET', url: '/api/stock' });
  assert.equal(catalogResponse.statusCode, 200);
  assert.equal(catalogResponse.json().length, 6);
  const previewResponse = await app.inject({ method: 'GET', url: '/api/stock/white' });
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(previewResponse.headers['content-type'], 'image/png');

  const createdResponse = await jsonRequest('POST', '/api/projects', { name: 'Stock fixture' });
  const created = createdResponse.json();
  const addResponse = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  assert.equal(addResponse.statusCode, 201);
  const asset = addResponse.json().asset;
  assert.equal(asset.type, 'image');
  assert.match(asset.path, /^media[\\/].+\.png$/);
  assert.equal(asset.thumbnailPath, asset.path);
  assert.equal(asset.path.includes(dataDir), false);
  const mediaResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media/${asset.id}` });
  assert.equal(mediaResponse.statusCode, 200);
  assert.equal(mediaResponse.headers['content-type'], 'image/png');
  const healthResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media-health` });
  assert.equal(healthResponse.json().find((item) => item.assetId === asset.id).status, 'ready');
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  project.tracks[0].clips.push({
    id: 'stock-image-clip',
    assetId: asset.id,
    type: 'image',
    name: asset.name,
    start: 0,
    duration: asset.duration,
    sourceStart: 0,
    sourceDuration: asset.duration,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0.4 },
    transitionOut: { type: 'none', duration: 0.4 },
    volume: 1,
    keyframes: [],
  });
  project.duration = asset.duration;
  const saveResponse = await jsonRequest('PATCH', `/api/projects/${created.id}`, project);
  assert.equal(saveResponse.statusCode, 200);
  const unicodeFileName = 'Türkçe-çıktı.mp4';
  const preflightResponse = await jsonRequest('POST', `/api/projects/${created.id}/export/preflight`, { format: 'mp4', fileName: unicodeFileName });
  assert.equal(preflightResponse.statusCode, 200);
  assert.equal(preflightResponse.json().ok, true);
  const fractionalFpsPreflight = await jsonRequest('POST', `/api/projects/${created.id}/export/preflight`, { format: 'mp4', fps: 29.97, range: { start: 0, end: 0.12 } });
  assert.equal(fractionalFpsPreflight.statusCode, 200);
  assert.equal(fractionalFpsPreflight.json().ok, true);
  const invalidRangePreflight = await jsonRequest('POST', `/api/projects/${created.id}/export/preflight`, { format: 'mp4', range: { start: 0, end: project.duration + 1 } });
  assert.equal(invalidRangePreflight.statusCode, 200);
  assert.equal(invalidRangePreflight.json().ok, false);
  assert.equal(invalidRangePreflight.json().errors.some((error) => error.code === 'INVALID_TIMELINE'), true);
  const invalidRangeExport = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', range: { start: project.duration, end: project.duration + 1 } });
  assert.equal(invalidRangeExport.statusCode, 400);
  const exportResponse = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', fileName: unicodeFileName, quality: 'draft', resolution: '720p', range: { start: 0, end: 0.2 } });
  assert.equal(exportResponse.statusCode, 202);
  assert.equal('absoluteOutputPath' in exportResponse.json().job, false);
  assert.equal('outputPath' in exportResponse.json().job, false);
  assert.equal('relativeOutputPath' in exportResponse.json().job, false);
  assert.equal(exportResponse.json().job.downloadUrl, `/api/jobs/${exportResponse.json().job.id}/download`);
  const jobSnapshotResponse = await app.inject({ method: 'GET', url: '/api/jobs/' + exportResponse.json().job.id });
  assert.equal(jobSnapshotResponse.statusCode, 200);
  assert.equal(jobSnapshotResponse.json().id, exportResponse.json().job.id);
  const exportJob = await waitForJob(exportResponse.json().job.id);
  assert.equal(exportJob.status, 'completed');
  assert.equal('absoluteOutputPath' in exportJob, false);
  const exportOutputPath = exportFilePath(created.id, exportJob.fileName);
  assert.equal((await fsp.stat(exportOutputPath)).size > 0, true);
  const downloadResponse = await app.inject({ method: 'GET', url: exportJob.downloadUrl });
  assert.equal(downloadResponse.statusCode, 200);
  assert.match(downloadResponse.headers['content-disposition'], /attachment/);
  assert.match(downloadResponse.headers['content-disposition'], /filename\*=UTF-8''T%C3%BCrk%C3%A7e-%C3%A7%C4%B1kt%C4%B1\.mp4/);
  assert.equal(downloadResponse.headers['content-type'], 'video/mp4');
  const [concurrentA, concurrentB] = await Promise.all([
    jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', quality: 'draft', range: { start: 0, end: 0.12 }, fileName: 'same-name.mp4' }),
    jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', quality: 'draft', range: { start: 0, end: 0.12 }, fileName: 'same-name.mp4' }),
  ]);
  assert.equal(concurrentA.statusCode, 202);
  assert.equal(concurrentB.statusCode, 202);
  const [concurrentJobA, concurrentJobB] = await Promise.all([waitForJob(concurrentA.json().job.id), waitForJob(concurrentB.json().job.id)]);
  assert.equal(concurrentJobA.status, 'completed');
  assert.equal(concurrentJobB.status, 'completed');
  assert.notEqual(concurrentJobA.fileName, concurrentJobB.fileName);
  const export4kResponse = await jsonRequest('POST', `/api/projects/${created.id}/export`, {
    format: 'mp4',
    aspect: '16:9',
    resolution: '4K',
    fps: 24,
    quality: 'draft',
    range: { start: 0, end: 0.12 },
    fileName: 'stock-fixture-4k.mp4',
  });
  assert.equal(export4kResponse.statusCode, 202);
  const export4kJob = await waitForJob(export4kResponse.json().job.id, 30000);
  assert.equal(export4kJob.status, 'completed');
  assert.deepEqual(probeVideoDimensions(exportFilePath(created.id, export4kJob.fileName)), { width: 3840, height: 2160, codec: 'h264', frameRate: '24/1' });
  const deletedResponse = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  const purgedResponse = await app.inject({ method: 'DELETE', url: `/api/trash/${deletedResponse.json().trashId}` });
  assert.equal(purgedResponse.statusCode, 200);
});

test('export stack order follows track.order rather than persisted array order', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Track order fixture' })).json();
  const white = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' })).json().asset;
  const black = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'black' })).json().asset;
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  const imageClip = (id, asset) => ({
    id,
    assetId: asset.id,
    type: 'image',
    name: asset.name,
    start: 0,
    duration: 0.2,
    sourceStart: 0,
    sourceDuration: 0.2,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    volume: 1,
    keyframes: [],
  });
  project.tracks[0].clips.push(imageClip('order-white', white));
  project.tracks[1].clips.push(imageClip('order-black', black));
  project.tracks = [project.tracks[1], project.tracks[0], ...project.tracks.slice(2)];
  project.duration = 0.2;
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, project)).statusCode, 200);
  const response = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', quality: 'draft', resolution: '720p', range: { start: 0, end: 0.12 }, fileName: 'track-order.mp4' });
  assert.equal(response.statusCode, 202);
  const job = await waitForJob(response.json().job.id, 30000);
  assert.equal(job.status, 'completed', job.error ?? 'track-order export failed');
  assert.equal(sampleVideoPixel(exportFilePath(created.id, job.fileName), 0.05) < 10, true);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` })).statusCode, 200);
});

test('media relink restores the original source when metadata commit fails', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Relink rollback fixture' })).json();
  const added = await jsonRequest('POST', '/api/projects/' + created.id + '/stock', { stockId: 'white' });
  assert.equal(added.statusCode, 201);
  const asset = added.json().asset;
  const whiteResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id + '/media/' + asset.id });
  const blackResponse = await app.inject({ method: 'GET', url: '/api/stock/black' });
  assert.equal(whiteResponse.statusCode, 200);
  assert.equal(blackResponse.statusCode, 200);
  const whiteBytes = Buffer.from(whiteResponse.rawPayload);
  const blackBytes = Buffer.from(blackResponse.rawPayload);
  assert.notDeepEqual(whiteBytes, blackBytes);
  serverTestHooks.beforeSave = async (project) => {
    if (project.id === created.id && project.assets.some((item) => item.name === 'black.png')) throw new Error('forced relink metadata failure');
  };
  const failedMultipart = multipartFile('file', 'black.png', 'image/png', blackBytes);
  const failedResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/' + created.id + '/media/' + asset.id + '/relink',
    headers: { 'content-type': 'multipart/form-data; boundary=' + failedMultipart.boundary },
    payload: failedMultipart.payload,
  });
  assert.equal(failedResponse.statusCode, 400);
  const afterFailure = (await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json();
  assert.equal(afterFailure.assets[0].name, asset.name);
  const preservedResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id + '/media/' + asset.id });
  assert.deepEqual(Buffer.from(preservedResponse.rawPayload), whiteBytes);
  const mediaFiles = await fsp.readdir(path.join(dataDir, 'projects', created.id, 'media'));
  assert.equal(mediaFiles.some((file) => file.endsWith('.backup')), false);
  serverTestHooks.beforeSave = undefined;
  serverTestHooks.beforeRelinkMove = async () => { throw new Error('forced relink move failure'); };
  const moveFailureMultipart = multipartFile('file', 'black.png', 'image/png', blackBytes);
  let moveFailureResponse;
  try {
    moveFailureResponse = await app.inject({ method: 'POST', url: '/api/projects/' + created.id + '/media/' + asset.id + '/relink', headers: { 'content-type': 'multipart/form-data; boundary=' + moveFailureMultipart.boundary }, payload: moveFailureMultipart.payload });
  } finally {
    serverTestHooks.beforeRelinkMove = undefined;
  }
  assert.equal(moveFailureResponse.statusCode, 400);
  assert.deepEqual(Buffer.from((await app.inject({ method: 'GET', url: '/api/projects/' + created.id + '/media/' + asset.id })).rawPayload), whiteBytes);
  const successfulMultipart = multipartFile('file', 'black.png', 'image/png', blackBytes);
  const successfulResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/' + created.id + '/media/' + asset.id + '/relink',
    headers: { 'content-type': 'multipart/form-data; boundary=' + successfulMultipart.boundary },
    payload: successfulMultipart.payload,
  });
  assert.equal(successfulResponse.statusCode, 202);
  const relinkJob = await waitForJob(successfulResponse.json().job.id);
  assert.equal(relinkJob.status, 'completed');
  const relinkedProject = (await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json();
  assert.equal(relinkedProject.assets[0].name, 'black.png');
  const replacedResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id + '/media/' + asset.id });
  assert.deepEqual(Buffer.from(replacedResponse.rawPayload), blackBytes);
  const deleted = await app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/trash/' + deleted.json().trashId })).statusCode, 200);
});

test('media relink removes superseded derived files', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Relink derived cleanup fixture' })).json();
  const added = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' })).json();
  const project = added.project;
  const staleRelative = ['proxies/stale.mp4', 'thumbnails/stale.jpg', 'waveforms/stale.png'];
  for (const relative of staleRelative) {
    const file = path.join(dataDir, 'projects', created.id, ...relative.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from('stale'));
  }
  project.assets[0].proxyPath = staleRelative[0];
  project.assets[0].thumbnailPath = staleRelative[1];
  project.assets[0].waveformPath = staleRelative[2];
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, project)).statusCode, 200);
  const black = Buffer.from((await app.inject({ method: 'GET', url: '/api/stock/black' })).rawPayload);
  const multipart = multipartFile('file', 'replacement.png', 'image/png', black);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/media/${added.asset.id}/relink`, headers: { 'content-type': `multipart/form-data; boundary=${multipart.boundary}` }, payload: multipart.payload });
  assert.equal(response.statusCode, 202);
  if (response.json().job?.id) await waitForJob(response.json().job.id);
  for (const relative of staleRelative) {
    await assert.rejects(fsp.stat(path.join(dataDir, 'projects', created.id, ...relative.split('/'))), { code: 'ENOENT' });
  }
});

test('removing an asset through project autosave also cleans its source and derived files', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Asset cleanup fixture' })).json();
  const added = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' })).json();
  const asset = added.asset;
  const sourcePath = path.join(dataDir, 'projects', created.id, asset.path);
  assert.equal((await fsp.stat(sourcePath)).isFile(), true);

  const current = added.project;
  const response = await jsonRequest('PATCH', `/api/projects/${created.id}`, { ...current, assets: [], tracks: current.tracks.map((track) => ({ ...track, clips: [] })), duration: 0, revision: current.revision });
  assert.equal(response.statusCode, 200);
  await assert.rejects(fsp.stat(sourcePath), { code: 'ENOENT' });
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media/${asset.id}` })).statusCode, 404);
});

test('media library changes do not extend duration and explicit delete validates after retaining clips', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Duration and delete fixture' })).json();
  const first = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' })).json();
  assert.equal(first.project.duration, 0);
  const second = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'black' })).json();
  assert.equal(second.project.duration, 0);
  const project = second.project;
  const clip = (asset, id, start, duration) => ({ id, assetId: asset.id, type: 'image', name: asset.name, start, duration, sourceStart: 0, sourceDuration: duration, speed: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false }, filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 }, transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 1, keyframes: [] });
  project.tracks[0].clips.push(clip(first.asset, 'delete-a', 0, 1));
  project.tracks[0].locked = true;
  project.tracks[1].clips.push(clip(second.asset, 'keep-b', 2, 3));
  project.duration = 5;
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, project)).statusCode, 200);
  const sourceA = path.join(dataDir, 'projects', created.id, first.asset.path);
  const sourceB = path.join(dataDir, 'projects', created.id, second.asset.path);
  const lockedDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}/media/${first.asset.id}` });
  assert.equal(lockedDelete.statusCode, 409);
  assert.equal((await fsp.stat(sourceA)).isFile(), true);
  const unlocked = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  unlocked.tracks.find((track) => track.id === project.tracks[0].id).locked = false;
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, unlocked)).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}/media/${first.asset.id}` })).statusCode, 200);
  const after = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  assert.equal(after.duration, 5);
  assert.equal(after.tracks.flatMap((track) => track.clips).some((item) => item.id === 'delete-a'), false);
  assert.equal(after.tracks.flatMap((track) => track.clips).some((item) => item.id === 'keep-b'), true);
  await assert.rejects(fsp.stat(sourceA), { code: 'ENOENT' });
  assert.equal((await fsp.stat(sourceB)).isFile(), true);
});

test('derived generation failure does not roll back a committed media import', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Derived failure fixture' })).json();
  const pngBytes = Buffer.from((await app.inject({ method: 'GET', url: '/api/stock/white' })).rawPayload);
  serverTestHooks.beforeDerivedWrite = async (projectId) => {
    if (projectId === created.id) throw new Error('forced derived failure');
  };
  try {
    const multipart = multipartFile('file', 'committed.png', 'image/png', pngBytes);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/media`, headers: { 'content-type': `multipart/form-data; boundary=${multipart.boundary}` }, payload: multipart.payload });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().project.assets.length, 1);
    assert.equal((await waitForJob(response.json().job.id)).status, 'failed');
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json().assets.length, 1);
  } finally {
    serverTestHooks.beforeDerivedWrite = undefined;
  }
});

test('derived rebuild rejects a source changed in place during the job', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Derived source generation fixture' })).json();
  const added = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' })).json();
  const sourcePath = path.join(dataDir, 'projects', created.id, added.asset.path);
  serverTestHooks.beforeDerivedWrite = async (projectId) => {
    if (projectId !== created.id) return;
    const stat = await fsp.stat(sourcePath);
    await fsp.utimes(sourcePath, stat.atime, new Date(stat.mtimeMs + 2000));
  };
  try {
    const response = await jsonRequest('POST', `/api/projects/${created.id}/media/${added.asset.id}/rebuild-derived`, {});
    assert.equal(response.statusCode, 202);
    const job = await waitForJob(response.json().job.id);
    assert.equal(job.status, 'failed');
    const current = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
    assert.equal(current.assets[0].path.replaceAll('\\', '/'), added.asset.path.replaceAll('\\', '/'));
    assert.equal((await fsp.stat(sourcePath)).size, added.asset.size);
  } finally {
    serverTestHooks.beforeDerivedWrite = undefined;
  }
});

test('relink validates byte format and updates the stored extension atomically', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Relink format fixture' })).json();
  const added = await jsonRequest('POST', '/api/projects/' + created.id + '/stock', { stockId: 'white' });
  const asset = added.json().asset;
  const source = Buffer.from((await app.inject({ method: 'GET', url: '/api/projects/' + created.id + '/media/' + asset.id })).rawPayload);
  const mismatched = multipartFile('file', 'not-really.jpg', 'image/jpeg', source);
  const rejected = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/media/${asset.id}/relink`, headers: { 'content-type': 'multipart/form-data; boundary=' + mismatched.boundary }, payload: mismatched.payload });
  assert.equal(rejected.statusCode, 415);

  const jpgPath = path.join(dataDir, 'relink-format.jpg');
  assert.equal(spawnSync(ffmpegPath, ['-y', '-i', path.join(dataDir, 'projects', created.id, asset.path), '-frames:v', '1', jpgPath], { encoding: 'utf8' }).status, 0);
  const jpeg = await fsp.readFile(jpgPath);
  const reverseMismatch = multipartFile('file', 'not-really.png', 'image/png', jpeg);
  const reverseRejected = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/media/${asset.id}/relink`, headers: { 'content-type': 'multipart/form-data; boundary=' + reverseMismatch.boundary }, payload: reverseMismatch.payload });
  assert.equal(reverseRejected.statusCode, 415);
  const replacement = multipartFile('file', 'replacement.jpg', 'image/jpeg', jpeg);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/media/${asset.id}/relink`, headers: { 'content-type': 'multipart/form-data; boundary=' + replacement.boundary }, payload: replacement.payload });
  assert.equal(response.statusCode, 202);
  if (response.json().job) assert.equal((await waitForJob(response.json().job.id)).status, 'completed');
  const project = (await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json();
  assert.match(project.assets[0].path, /\.jpg$/);
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media/${asset.id}` })).headers['content-type'], 'image/jpeg');
  await fsp.rm(jpgPath, { force: true });
  const deleted = await app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/trash/' + deleted.json().trashId })).statusCode, 200);
});
test('portable project bundles include media and reopen on a clean project directory', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Portable bundle fixture' })).json();
  const added = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  assert.equal(added.statusCode, 201);
  const sourceProject = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  const sourceAsset = sourceProject.assets[0];
  sourceProject.tracks[0].clips.push({
    id: 'portable-clip', assetId: sourceAsset.id, type: 'image', name: sourceAsset.name, start: 0, duration: 0.12,
    sourceStart: 0, sourceDuration: 0.12, speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 1, keyframes: [],
  });
  sourceProject.duration = 0.12;
  const saved = await jsonRequest('PATCH', `/api/projects/${created.id}`, sourceProject);
  assert.equal(saved.statusCode, 200);

  const bundleResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/bundle` });
  assert.equal(bundleResponse.statusCode, 200);
  assert.equal(bundleResponse.headers['content-type'], 'application/zip');
  const bundle = Buffer.from(bundleResponse.rawPayload);
  assert.equal(bundle.subarray(0, 2).toString(), 'PK');

  const importedResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/import',
    headers: { 'content-type': 'application/zip' },
    payload: bundle,
  });
  assert.equal(importedResponse.statusCode, 201, importedResponse.payload);
  const imported = importedResponse.json();
  assert.notEqual(imported.id, sourceProject.id);
  assert.notEqual(imported.assets[0].id, sourceAsset.id);
  assert.match(imported.assets[0].path, /^media[\\/].+\.png$/);
  const importedMedia = await app.inject({ method: 'GET', url: `/api/projects/${imported.id}/media/${imported.assets[0].id}` });
  assert.equal(importedMedia.statusCode, 200);
  assert.equal(importedMedia.headers['content-type'], 'image/png');

  const exportResponse = await jsonRequest('POST', `/api/projects/${imported.id}/export`, { format: 'mp4', range: { start: 0, end: 0.12 }, fileName: 'portable.mp4' });
  assert.equal(exportResponse.statusCode, 202);
  const exportJob = await waitForJob(exportResponse.json().job.id, 30000);
  assert.equal(exportJob.status, 'completed', exportJob.error ?? 'portable export failed');
});

test('image upload creates a real JPEG thumbnail and serves it with the correct content type', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Thumbnail fixture' })).json();
  const jpeg = await fsp.readFile(path.join(repoRoot, 'assets', 'screenshots', 'cutloc-editor.jpg'));
  const multipart = multipartFile('file', 'editor.jpg', 'image/jpeg', jpeg);
  const uploadResponse = await app.inject({
    method: 'POST',
    url: `/api/projects/${created.id}/media`,
    headers: { 'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
    payload: multipart.payload,
  });
  assert.equal(uploadResponse.statusCode, 201);
  const upload = uploadResponse.json();
  const job = await waitForJob(upload.job.id);
  assert.equal(job.status, 'completed', job.error ?? 'thumbnail job failed');
  const processed = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  const asset = processed.assets.find((item) => item.id === upload.asset.id);
  assert.match(asset.thumbnailPath, /^thumbnails[\\/].+\.jpg$/);
  const thumbnailPath = path.join(dataDir, 'projects', created.id, asset.thumbnailPath);
  assert.equal((await fsp.stat(thumbnailPath)).size > 0, true);
  const health = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media-health` })).json();
  assert.equal(health.find((item) => item.assetId === asset.id).status, 'ready');
  const thumbnailResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/media/${asset.id}?thumbnail=1` });
  assert.equal(thumbnailResponse.statusCode, 200);
  assert.equal(thumbnailResponse.headers['content-type'], 'image/jpeg');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` })).statusCode, 200);
});

test('advanced motion, crop, mask, speed curve and adjustment controls render through the shared browser compositor', async () => {
  const createdResponse = await jsonRequest('POST', '/api/projects', { name: 'Advanced render fixture' });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();
  const addResponse = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  assert.equal(addResponse.statusCode, 201);
  const asset = addResponse.json().asset;
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  project.tracks[0].clips.push({
    id: 'advanced-image-clip',
    assetId: asset.id,
    type: 'image',
    name: asset.name,
    start: 0,
    duration: 1.2,
    sourceStart: 0,
    sourceDuration: 1.2,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0.08, contrast: 0.1, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'wipe', duration: 0.25, direction: 'left', easing: 'ease-out', intensity: 1 },
    transitionOut: { type: 'zoom', duration: 0.25, direction: 'center', easing: 'ease-in', intensity: 1 },
    volume: 1,
    mask: { type: 'ellipse', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.08, invert: false },
    crop: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
    speedCurve: [
      { time: 0, speed: 0.5, easing: 'ease-in' },
      { time: 0.6, speed: 1, easing: 'ease-in-out' },
      { time: 1.2, speed: 1.5, easing: 'ease-out' },
    ],
    keyframes: [
      { id: 'x-start', property: 'x', time: 0, value: -80, easing: 'ease-out' },
      { id: 'x-end', property: 'x', time: 1.2, value: 80, easing: 'ease-in' },
      { id: 'scale-start', property: 'scale', time: 0, value: 1, easing: 'linear' },
      { id: 'scale-end', property: 'scale', time: 1.2, value: 1.12, easing: 'ease-out' },
      { id: 'rotation-start', property: 'rotation', time: 0, value: 0, easing: 'linear' },
      { id: 'rotation-end', property: 'rotation', time: 1.2, value: 8, easing: 'ease-in-out' },
      { id: 'opacity-start', property: 'opacity', time: 0, value: 0.8, easing: 'linear' },
      { id: 'opacity-end', property: 'opacity', time: 1.2, value: 1, easing: 'ease-out' },
    ],
  });
  project.tracks[1].clips.push({
    id: 'advanced-adjustment-layer',
    type: 'image',
    name: 'Adjustment layer',
    start: 0,
    duration: 1.2,
    sourceStart: 0,
    sourceDuration: 1.2,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0.04, contrast: 0, saturation: 0.03, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    volume: 1,
    adjustment: true,
    keyframes: [],
  });
  project.tracks[2].clips.push({
    id: 'advanced-text-clip',
    type: 'text',
    name: 'Approximate text',
    start: 0,
    duration: 1.2,
    sourceStart: 0,
    sourceDuration: 1.2,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 4, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    volume: 1,
    adjustment: false,
    keyframes: [],
    textStyle: { text: 'Agent QA', fontFamily: 'Arial', fontSize: 48, fontWeight: 700, fontStyle: 'normal', textDecoration: 'underline', letterSpacing: 2, lineHeight: 1.2, padding: 4, color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  });
  project.duration = 1.2;
  const saveResponse = await jsonRequest('PATCH', `/api/projects/${created.id}`, project);
  assert.equal(saveResponse.statusCode, 200);
  const preflightResponse = await jsonRequest('POST', `/api/projects/${created.id}/export/preflight`, { format: 'mp4', quality: 'draft', fileName: 'advanced-fixture.mp4' });
  assert.equal(preflightResponse.statusCode, 200);
  assert.equal(preflightResponse.json().ok, true);
  assert.equal(preflightResponse.json().warnings.some((warning) => /FALLBACK/.test(warning.code)), false);
  assert.equal(preflightResponse.json().warnings.some((warning) => warning.code === 'TEXT_RENDER_APPROXIMATION'), false);
  const previewResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/preview-frame?time=0.5` });
  assert.equal(previewResponse.statusCode, 200);
  assert.match(previewResponse.headers['content-type'], /image\/png/);
  assert.equal(previewResponse.headers['x-cutloc-preview-cache'], 'MISS');
  assert.equal(previewResponse.rawPayload.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])), true);
  const cachedPreviewResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/preview-frame?time=0.5` });
  assert.equal(cachedPreviewResponse.statusCode, 200);
  assert.equal(cachedPreviewResponse.headers['x-cutloc-preview-cache'], 'HIT');
  assert.equal(cachedPreviewResponse.rawPayload.equals(previewResponse.rawPayload), true);
  const exportResponse = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', quality: 'draft', fileName: 'advanced-fixture.mp4' });
  assert.equal(exportResponse.statusCode, 202);
  const exportJob = await waitForJob(exportResponse.json().job.id, 60000);
  assert.equal(exportJob.status, 'completed', exportJob.error ?? 'advanced export failed');
  const outputPath = exportFilePath(created.id, exportJob.fileName);
  assert.equal((await fsp.stat(outputPath)).size > 0, true);
  assert.equal(probeVideoDimensions(outputPath).codec, 'h264');
  const deletedResponse = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  const purgedResponse = await app.inject({ method: 'DELETE', url: `/api/trash/${deletedResponse.json().trashId}` });
  assert.equal(purgedResponse.statusCode, 200);
});

test('export scales canvas-space clip positions with the requested output resolution', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Transform parity fixture' })).json();
  const stock = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  assert.equal(stock.statusCode, 201);
  const asset = stock.json().asset;
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  project.canvas.background = '#000000';
  project.tracks[0].clips.push({
    id: 'scaled-position-clip', assetId: asset.id, type: 'image', name: asset.name, start: 0, duration: 0.2,
    sourceStart: 0, sourceDuration: 0.2, speed: 1,
    transform: { x: -600, y: 150, scale: 0.25, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 1, keyframes: [],
  });
  project.duration = 0.2;
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, project)).statusCode, 200);

  const response = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', aspect: '9:16', resolution: '720p', quality: 'draft', range: { start: 0, end: 0.2 }, fileName: 'transform-parity.mp4' });
  assert.equal(response.statusCode, 202);
  const job = await waitForJob(response.json().job.id, 30000);
  assert.equal(job.status, 'completed', job.error ?? 'transform parity export failed');
  const output = exportFilePath(created.id, job.fileName);
  const dimensions = probeVideoDimensions(output);
  assert.deepEqual({ width: dimensions.width, height: dimensions.height }, { width: 1280, height: 720 });
  const bounds = brightPixelBounds(output, 0.1, dimensions.width, dimensions.height);
  assert.equal(Math.abs(bounds.x - 80) <= 3, true, `unexpected horizontal position: ${JSON.stringify(bounds)}`);
  assert.equal(Math.abs(bounds.y - 370) <= 3, true, `unexpected vertical position: ${JSON.stringify(bounds)}`);
  assert.equal(Math.abs(bounds.width - 320) <= 3, true, `unexpected width: ${JSON.stringify(bounds)}`);
  assert.equal(Math.abs(bounds.height - 180) <= 3, true, `unexpected height: ${JSON.stringify(bounds)}`);

  const previewResponse = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/preview-frame?time=0.1&resolution=720p&fps=30` });
  assert.equal(previewResponse.statusCode, 200);
  const previewPath = path.join(dataDir, 'transform-parity-preview.png');
  await fsp.writeFile(previewPath, previewResponse.rawPayload);
  const previewBounds = brightPixelBounds(previewPath, 0, dimensions.width, dimensions.height);
  assert.equal(Math.abs(previewBounds.x - bounds.x) <= 3, true, `preview/export x mismatch: ${JSON.stringify({ previewBounds, bounds })}`);
  assert.equal(Math.abs(previewBounds.y - bounds.y) <= 3, true, `preview/export y mismatch: ${JSON.stringify({ previewBounds, bounds })}`);
  assert.equal(Math.abs(previewBounds.width - bounds.width) <= 3, true, `preview/export width mismatch: ${JSON.stringify({ previewBounds, bounds })}`);
  assert.equal(Math.abs(previewBounds.height - bounds.height) <= 3, true, `preview/export height mismatch: ${JSON.stringify({ previewBounds, bounds })}`);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` })).statusCode, 200);
});

test('exported scale keyframes keep changing after the first frame', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Animated scale fixture' })).json();
  const stock = await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' });
  assert.equal(stock.statusCode, 201);
  const asset = stock.json().asset;
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  project.canvas.background = '#000000';
  project.tracks[0].clips.push({
    id: 'animated-scale-clip', assetId: asset.id, type: 'image', name: asset.name, start: 0, duration: 0.8,
    sourceStart: 0, sourceDuration: 0.8, speed: 1,
    transform: { x: 0, y: 0, scale: 0.25, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 1,
    mask: { type: 'ellipse', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.1, invert: false },
    keyframes: [
      { id: 'scale-small', property: 'scale', time: 0, value: 0.25, easing: 'linear' },
      { id: 'scale-large', property: 'scale', time: 0.8, value: 0.5, easing: 'linear' },
    ],
  });
  project.duration = 0.8;
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, project)).statusCode, 200);

  const response = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', aspect: '16:9', resolution: '720p', quality: 'draft', fileName: 'animated-scale.mp4' });
  assert.equal(response.statusCode, 202);
  const job = await waitForJob(response.json().job.id, 30000);
  assert.equal(job.status, 'completed', job.error ?? 'animated scale export failed');
  const output = exportFilePath(created.id, job.fileName);
  const dimensions = probeVideoDimensions(output);
  const early = brightPixelBounds(output, 0.1, dimensions.width, dimensions.height);
  const late = brightPixelBounds(output, 0.7, dimensions.width, dimensions.height);
  assert.equal(early.width >= 284 && early.width <= 294, true, `unexpected feathered mask width: ${JSON.stringify(early)}`);
  assert.equal(early.height >= 160 && early.height <= 168, true, `unexpected feathered mask height: ${JSON.stringify(early)}`);
  assert.equal(late.width > early.width * 1.5, true, `expected animated width growth: ${JSON.stringify({ early, late })}`);
  assert.equal(late.height > early.height * 1.5, true, `expected animated height growth: ${JSON.stringify({ early, late })}`);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` })).statusCode, 200);
});

test('multiline text shorthands render as separate lines in browser-composited exports', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Multiline text fixture' })).json();
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  project.tracks[0].clips.push({
    id: 'multiline-text',
    type: 'text',
    name: 'Multiline text',
    start: 0,
    duration: 0.4,
    sourceStart: 0,
    sourceDuration: 0.4,
    speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 },
    transitionOut: { type: 'none', duration: 0 },
    volume: 1,
    adjustment: false,
    keyframes: [],
    textStyle: { text: 'TEST/nLINE', fontFamily: 'Arial', fontSize: 64, fontWeight: 700, fontStyle: 'normal', textDecoration: 'none', letterSpacing: 0, lineHeight: 1.2, padding: 0, color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'center' },
  });
  project.duration = 0.4;
  const saveResponse = await jsonRequest('PATCH', `/api/projects/${created.id}`, project);
  assert.equal(saveResponse.statusCode, 200);
  const exportResponse = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', quality: 'draft', resolution: '720p', fileName: 'multiline-text.mp4' });
  assert.equal(exportResponse.statusCode, 202);
  const job = await waitForJob(exportResponse.json().job.id, 30000);
  assert.equal(job.status, 'completed', job.error ?? 'multiline export failed');
  const outputPath = exportFilePath(created.id, job.fileName);
  const dimensions = probeVideoDimensions(outputPath);
  const bounds = brightPixelBounds(outputPath, 0.2, dimensions.width, dimensions.height);
  assert.equal(bounds.height > 70, true, `expected two rendered lines, received ${JSON.stringify(bounds)}`);
  const deletedResponse = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  await app.inject({ method: 'DELETE', url: `/api/trash/${deletedResponse.json().trashId}` });
});

test('adjustment layers affect only their own timeline interval during export', async () => {
  const created = (await jsonRequest('POST', '/api/projects', { name: 'Adjustment timing fixture' })).json();
  const asset = (await jsonRequest('POST', `/api/projects/${created.id}/stock`, { stockId: 'white' })).json().asset;
  const project = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  project.tracks[0].clips.push({
    id: 'base-white', assetId: asset.id, type: 'image', name: 'White', start: 0, duration: 1.2, sourceStart: 0, sourceDuration: 1.2, speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'stretch', flipX: false, flipY: false },
    filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 1, keyframes: [],
  });
  project.tracks[1].clips.push({
    id: 'timed-adjustment', type: 'image', name: 'Dark interval', start: 0.4, duration: 0.4, sourceStart: 0, sourceDuration: 0.4, speed: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', flipX: false, flipY: false },
    filters: { brightness: -1, contrast: 0, saturation: 0, blur: 0, grayscale: 0 },
    transitionIn: { type: 'none', duration: 0 }, transitionOut: { type: 'none', duration: 0 }, volume: 1, adjustment: true, keyframes: [],
  });
  project.duration = 1.2;
  assert.equal((await jsonRequest('PATCH', `/api/projects/${created.id}`, project)).statusCode, 200);
  const exportResponse = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', quality: 'draft', resolution: '720p', fileName: 'adjustment-timing.mp4' });
  assert.equal(exportResponse.statusCode, 202);
  const job = await waitForJob(exportResponse.json().job.id, 30000);
  assert.equal(job.status, 'completed', job.error ?? 'adjustment export failed');
  const output = exportFilePath(created.id, job.fileName);
  assert.equal(sampleVideoPixel(output, 0.2) > 180, true);
  assert.equal(sampleVideoPixel(output, 0.6) < 60, true);
  assert.equal(sampleVideoPixel(output, 1.0) > 180, true);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${deleted.json().trashId}` })).statusCode, 200);
});

test('a small WAV fixture imports, creates a waveform job, and exports MP3', async () => {
  const createdResponse = await jsonRequest('POST', '/api/projects', { name: 'Fixture proje' });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();
  const disguisedPngBytes = Buffer.from((await app.inject({ method: 'GET', url: '/api/stock/white' })).rawPayload);
  const disguisedPng = multipartFile('file', 'disguised.jpg', 'image/jpeg', disguisedPngBytes);
  const disguisedPngResponse = await app.inject({ method: 'POST', url: '/api/projects/' + created.id + '/media', headers: { 'content-type': `multipart/form-data; boundary=${disguisedPng.boundary}` }, payload: disguisedPng.payload });
  assert.equal(disguisedPngResponse.statusCode, 415);
  const invalidMultipart = multipartFile('file', 'payload.png', 'image/png', Buffer.from('<!doctype html><script>document.body.innerHTML = "stored"</script>'));
  const invalidUploadResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/' + created.id + '/media',
    headers: { 'content-type': `multipart/form-data; boundary=${invalidMultipart.boundary}` },
    payload: invalidMultipart.payload,
  });
  assert.equal(invalidUploadResponse.statusCode, 415);
  assert.equal(invalidUploadResponse.json().error, serverT('en', 'contentMismatch'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json().assets.length, 0);

  const multipart = multipartFile('file', 'tone.wav', 'application/octet-stream', makeWavFixture());
  const uploadResponse = await app.inject({
    method: 'POST',
    url: '/api/projects/' + created.id + '/media',
    headers: { 'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
    payload: multipart.payload,
  });
  assert.equal(uploadResponse.statusCode, 201);
  const upload = uploadResponse.json();
  assert.equal(upload.asset.type, 'audio');
  assert.equal(upload.asset.mimeType, 'audio/wav');
  assert.equal(upload.asset.hasAudio, true);
  const proxyJob = await waitForJob(upload.job.id);
  assert.equal(proxyJob.status, 'completed');
  const processedProject = (await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json();
  const processedAsset = processedProject.assets.find((item) => item.id === upload.asset.id);
  assert.equal(typeof processedAsset.waveformPath, 'string');
  assert.match(processedAsset.waveformPath, /^waveforms[\\/]/);

  const projectResponse = await app.inject({ method: 'GET', url: '/api/projects/' + created.id });
  const project = projectResponse.json();
  const asset = project.assets.find((item) => item.id === upload.asset.id);
  project.tracks[0].volume = 0.85;
  project.tracks[0].clips.push({
    id: 'fixture-audio-clip',
    assetId: asset.id,
    type: 'audio',
    name: asset.name,
    start: 0,
    duration: asset.duration,
    sourceStart: 0,
    sourceDuration: asset.duration,
    speed: 1,
    volume: 1,
    fadeIn: 0.05,
    fadeOut: 0.05,
    speedCurve: [{ time: 0, speed: 0.8, easing: 'ease-in' }, { time: asset.duration, speed: 1.2, easing: 'ease-out' }],
    keyframes: [{ id: 'audio-volume-start', property: 'volume', time: 0, value: 0.7, easing: 'linear' }, { id: 'audio-volume-end', property: 'volume', time: asset.duration, value: 1, easing: 'ease-out' }],
  });
  project.duration = asset.duration;
  const saveResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, project);
  assert.equal(saveResponse.statusCode, 200);
  const shorter = multipartFile('file', 'short.wav', 'audio/wav', makeWavFixture(0.1));
  const shorterResponse = await app.inject({ method: 'POST', url: `/api/projects/${created.id}/media/${asset.id}/relink`, headers: { 'content-type': `multipart/form-data; boundary=${shorter.boundary}` }, payload: shorter.payload });
  assert.equal(shorterResponse.statusCode, 400);
  const afterShorterReject = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json();
  assert.equal(afterShorterReject.assets.find((item) => item.id === asset.id).duration, asset.duration);
  const invalidRange = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'wav', range: { start: 0.3, end: 0.1 }, fileName: 'invalid.wav' });
  assert.equal(invalidRange.statusCode, 400);
  const exportResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'mp3', fileName: 'fixture.mp3' });
  assert.equal(exportResponse.statusCode, 202);
  const exportJob = await waitForJob(exportResponse.json().job.id);
  assert.equal(exportJob.status, 'completed', exportJob.error ?? 'audio export failed');
  const outputPath = exportFilePath(created.id, exportJob.fileName);
  assert.equal((await fsp.stat(outputPath)).size > 0, true);
  const terminalCancelResponse = await app.inject({ method: 'DELETE', url: `/api/jobs/${exportJob.id}` });
  assert.equal(terminalCancelResponse.statusCode, 409);
  assert.match(terminalCancelResponse.json().error, /cannot be cancelled|iptal edilemez/i);
  assert.equal((await app.inject({ method: 'GET', url: `/api/jobs/${exportJob.id}` })).json().status, 'completed');
  const wavExportResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'wav', fileName: 'fixture.wav' });
  assert.equal(wavExportResponse.statusCode, 202);
  const wavExportJob = await waitForJob(wavExportResponse.json().job.id);
  assert.equal(wavExportJob.status, 'completed');
  const wavHeader = await fsp.readFile(exportFilePath(created.id, wavExportJob.fileName));
  assert.equal(wavHeader.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavHeader.readUInt16LE(22), 2);
  assert.equal(wavHeader.readUInt32LE(24), 48000);
  assert.equal(wavHeader.readUInt16LE(34), 16);
  assert.equal(wavPeak(wavHeader) > 0, true);
  assert.equal(wavPeak(wavHeader) <= Math.ceil(32767 * 0.95), true);
  const latest = (await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json();
  latest.tracks[0].hidden = true;
  assert.equal((await jsonRequest('PATCH', '/api/projects/' + created.id, latest)).statusCode, 200);
  const hiddenResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'wav', fileName: 'hidden.wav' });
  assert.equal(hiddenResponse.statusCode, 202);
  const hiddenJob = await waitForJob(hiddenResponse.json().job.id);
  assert.equal(hiddenJob.status, 'completed');
  assert.equal(wavPeak(await fsp.readFile(exportFilePath(created.id, hiddenJob.fileName))) > 0, true);
  const hiddenProject = (await app.inject({ method: 'GET', url: '/api/projects/' + created.id })).json();
  hiddenProject.tracks[0].hidden = false;
  hiddenProject.tracks[0].muted = true;
  assert.equal((await jsonRequest('PATCH', '/api/projects/' + created.id, hiddenProject)).statusCode, 200);
  const mutedResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'wav', fileName: 'muted.wav' });
  assert.equal(mutedResponse.statusCode, 202);
  const mutedJob = await waitForJob(mutedResponse.json().job.id);
  assert.equal(mutedJob.status, 'completed');
  const mutedBytes = await fsp.readFile(exportFilePath(created.id, mutedJob.fileName));
  assert.equal(wavPeak(mutedBytes), 0);
});

test('job history survives restart and marks interrupted work as failed', async () => {
  const now = new Date().toISOString();
  await fsp.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([{
    id: 'job_restart_fixture',
    projectId: 'restart-project',
    kind: 'export',
    status: 'running',
    progress: 0.4,
    fileName: 'restart.mp4',
    format: 'mp4',
    relativeOutputPath: 'exports/restart.mp4',
    createdAt: now,
    updatedAt: now,
  }]), 'utf8');
  const restarted = await createServer();
  try {
    const response = await restarted.inject({ method: 'GET', url: '/api/jobs/job_restart_fixture' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'failed');
    assert.match(response.json().error, /server restarted|sunucu yeniden başladığı/i);
    const persisted = JSON.parse(await fsp.readFile(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(persisted[0].status, 'failed');
    assert.equal('absoluteOutputPath' in persisted[0], false);
  } finally {
    await restarted.close();
  }
});

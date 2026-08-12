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
const { createServer } = await import('../dist/index.js');
const { serverT } = await import('../dist/i18n.js');
const app = await createServer();

after(async () => {
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

test('health endpoint reports a local server without leaking the absolute data path', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().dataDir, path.basename(dataDir));
  assert.equal(response.json().dataDir.includes(dataDir), false);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('translation catalogs localize server messages and interpolation values', () => {
  assert.equal(serverT('tr', 'projectNotFound'), 'Proje bulunamadı');
  assert.equal(serverT('en', 'projectNotFound'), 'Project not found');
  assert.equal(serverT('en', 'preflightFpsConvert', { fps: 60 }), 'The project will be resampled to 60 FPS.');
});

test('active UI and route implementations keep Turkish copy in translation catalogs', async () => {
  const webSource = await fsp.readFile(path.join(repoRoot, 'apps', 'web', 'src', 'main.tsx'), 'utf8');
  const sourceSection = (start, end) => {
    const startIndex = webSource.indexOf(start);
    const endIndex = webSource.indexOf(end, startIndex + start.length);
    assert.notEqual(startIndex, -1, `Missing source boundary: ${start}`);
    assert.notEqual(endIndex, -1, `Missing source boundary: ${end}`);
    return webSource.slice(startIndex, endIndex);
  };
  const activeUiSource = [
    sourceSection('function App()', 'function AssetPanel('),
    sourceSection('function PanelContent(', 'function InspectorLegacy('),
    sourceSection('function Inspector({', 'function Timeline({'),
    sourceSection('function TimelinePro(', 'function AppWrapper()'),
  ].join('\n').replaceAll('Türkçe', '');
  assert.doesNotMatch(activeUiSource, /[ÇĞİÖŞÜçğıöşü]/u);

  const serverSource = await fsp.readFile(path.join(repoRoot, 'apps', 'server', 'src', 'index.ts'), 'utf8');
  assert.doesNotMatch(serverSource, /[ÇĞİÖŞÜçğıöşü]/u);
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

  const updatedResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'Güncel proje', revision: 0 });
  assert.equal(updatedResponse.statusCode, 200);
  assert.equal(updatedResponse.json().name, 'Güncel proje');
  assert.equal(updatedResponse.json().revision, 1);

  const conflictResponse = await jsonRequest('PATCH', '/api/projects/' + created.id, { name: 'Eski sürüm', revision: 0 });
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(conflictResponse.json().project.revision, 1);
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
  const restoredFromTrashResponse = await app.inject({ method: 'POST', url: '/api/trash/' + trashEntry.trashId + '/restore' });
  assert.equal(restoredFromTrashResponse.statusCode, 200);
  assert.equal(restoredFromTrashResponse.json().id, created.id);
  const deletedAgainResponse = await app.inject({ method: 'DELETE', url: '/api/projects/' + created.id });
  assert.equal(deletedAgainResponse.statusCode, 200);
  const purgedResponse = await app.inject({ method: 'DELETE', url: '/api/trash/' + deletedAgainResponse.json().trashId });
  assert.equal(purgedResponse.statusCode, 200);
});

test('unknown projects return a safe not-found response', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/projects/project_does_not_exist' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, serverT('en', 'projectNotFound'));
});

test('unknown project duplication returns a safe not-found response', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/projects/project_does_not_exist/duplicate' });
  assert.equal(response.statusCode, 404);
});

test('cross-origin API mutations are rejected', async () => {
  const response = await jsonRequest('POST', '/api/projects', { name: 'blocked' }, { origin: 'https://example.invalid', host: '127.0.0.1:4173' });
  assert.equal(response.statusCode, 403);
});

test('settings validation returns a client error without leaking a server failure', async () => {
  const validResponse = await jsonRequest('PUT', '/api/settings', { language: 'tr', proxyQuality: 'draft', hardwareAcceleration: 'software', experimentalAi: true, aiProvider: 'openai', aiModel: 'test-model', openAiKey: 'temporary-test-key', shortcuts: { togglePlayback: 'P', undo: 'Ctrl/Cmd+U', redo: 'Ctrl/Cmd+Shift+U', split: 'K', setIn: 'J', setOut: 'L', clearRange: 'C', deleteClip: 'Backspace', duplicate: 'Ctrl/Cmd+M', selectAll: 'Ctrl/Cmd+Shift+A' } });
  assert.equal(validResponse.statusCode, 200);
  assert.equal(validResponse.json().experimentalAi, false);
  assert.equal(validResponse.json().hasOpenAiKey, false);
  assert.equal('openAiKey' in validResponse.json(), false);
  assert.equal(validResponse.json().shortcuts.split, 'B');
  assert.equal(validResponse.json().defaultExport.resolution, '1080p');
  assert.equal(validResponse.json().workspaceLayout.libraryWidth, 270);
  const persistedResponse = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(persistedResponse.json().shortcuts.togglePlayback, 'Space');
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
  const preflightResponse = await jsonRequest('POST', `/api/projects/${created.id}/export/preflight`, { format: 'mp4', fileName: 'stock-fixture.mp4' });
  assert.equal(preflightResponse.statusCode, 200);
  assert.equal(preflightResponse.json().ok, true);
  const exportResponse = await jsonRequest('POST', `/api/projects/${created.id}/export`, { format: 'mp4', fileName: 'stock-fixture.mp4' });
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
  assert.equal(downloadResponse.headers['content-type'], 'video/mp4');
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

test('advanced motion, crop, mask, speed curve and adjustment controls render through FFmpeg', async () => {
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
  project.duration = 1.2;
  const saveResponse = await jsonRequest('PATCH', `/api/projects/${created.id}`, project);
  assert.equal(saveResponse.statusCode, 200);
  const preflightResponse = await jsonRequest('POST', `/api/projects/${created.id}/export/preflight`, { format: 'mp4', quality: 'draft', fileName: 'advanced-fixture.mp4' });
  assert.equal(preflightResponse.statusCode, 200);
  assert.equal(preflightResponse.json().ok, true);
  assert.equal(preflightResponse.json().warnings.some((warning) => /FALLBACK/.test(warning.code)), false);
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
  const exportResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'mp3', fileName: 'fixture.mp3' });
  assert.equal(exportResponse.statusCode, 202);
  const exportJob = await waitForJob(exportResponse.json().job.id);
  assert.equal(exportJob.status, 'completed', exportJob.error ?? 'audio export failed');
  const outputPath = exportFilePath(created.id, exportJob.fileName);
  assert.equal((await fsp.stat(outputPath)).size > 0, true);
  const wavExportResponse = await jsonRequest('POST', '/api/projects/' + created.id + '/export', { format: 'wav', fileName: 'fixture.wav' });
  assert.equal(wavExportResponse.statusCode, 202);
  const wavExportJob = await waitForJob(wavExportResponse.json().job.id);
  assert.equal(wavExportJob.status, 'completed');
  const wavHeader = await fsp.readFile(exportFilePath(created.id, wavExportJob.fileName));
  assert.equal(wavHeader.subarray(0, 4).toString('ascii'), 'RIFF');
});

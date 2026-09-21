import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { API_PROTOCOL_VERSION, CUTLOC_VERSION, runtimePaths } from '@cutloc/runtime';
import { serverT, type ServerTranslationKey, type ServerTranslationValues } from './i18n.js';
import {
  defaultProject,
  defaultSettings,
  DEFAULT_SHORTCUT_SETTINGS,
  clamp,
  effectiveVisualFit,
  normalizeTextLineBreaks,
  exportDimensions,
  enforceLockedTrackInvariants,
  ExportFpsSchema,
  projectDuration,
  ProjectSchema,
  ExportOptionsSchema,
  ExportResolutionSchema,
  JobSchema,
  SettingsSchema,
  sliceClipForRange,
  sourceTimeAt,
  speedCurveSegments,
  speedAt,
  adjustmentLayersForVisual,
  mergeVisualFilters,
  resolveTextFrameGeometry,
  visualLayerPlan,
  type Asset,
  type ExportOptions,
  type Job,
  type Project,
  type ProjectAccessLease,
  type Settings,
} from '@cutloc/shared';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const userRuntimePaths = runtimePaths();
const configuredDataDir = process.env.DATA_DIR?.trim();
const dataDir = path.resolve(configuredDataDir || userRuntimePaths.data);
const projectsDir = path.join(dataDir, 'projects');
const settingsFile = path.join(dataDir, 'settings.json');
const jobsFile = path.join(dataDir, 'jobs.json');
const stockDir = path.join(rootDir, 'apps', 'server', 'stock');
let runtimePort = Number(process.env.PORT ?? 4173);
const webPort = Number(process.env.WEB_PORT ?? 5173);
const webDist = path.join(rootDir, 'apps/web/dist');
function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const maxUploadBytes = boundedNumber(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 1024, 32 * 1024 * 1024, 20 * 1024 * 1024 * 1024);
const maxFfmpegRuntimeMs = boundedNumber(process.env.FFMPEG_TIMEOUT_MS, 30 * 60 * 1000, 30 * 1000, 6 * 60 * 60 * 1000);
const trashRetentionDays = boundedNumber(process.env.TRASH_RETENTION_DAYS, 30, 1, 365);
const trashRetentionMs = trashRetentionDays * 24 * 60 * 60 * 1000;
const maxJobHistory = 200;
const maxSseClients = 32;
const maxConcurrentJobs = 2;
const maxConcurrentPreviews = 2;
const globalRequestsPerMinute = 3_000;
const previewRequestsPerMinute = 120;
const minAccessLeaseMs = 5_000;
const maxAccessLeaseMs = 60_000;

type SseClient = { reply: FastifyReply };
const clients = new Set<SseClient>();
type InternalJob = Job & { outputPath?: string; absoluteOutputPath?: string; relativeOutputPath?: string };
const jobs = new Map<string, InternalJob>();
const reservedExportPaths = new Set<string>();
const jobProcesses = new Map<string, ReturnType<typeof spawn>>();
type InternalProjectAccessLease = ProjectAccessLease & { token: string };
const projectAccessLeases = new Map<string, InternalProjectAccessLease>();
let settings: Settings = defaultSettings();
let activePreviewRenders = 0;
const previewFrameCache = new Map<string, Buffer>();
const maxPreviewFrameCacheEntries = 12;
const maxPreviewFrameCacheBytes = 64 * 1024 * 1024;
let previewFrameCacheBytes = 0;

function message(key: ServerTranslationKey, values?: ServerTranslationValues) {
  return serverT(settings.language, key, values);
}

function localizedError(error: unknown, fallback: ServerTranslationKey) {
  const issues = typeof error === 'object' && error !== null && 'issues' in error
    ? (error as { issues?: Array<{ message?: string }> }).issues
    : undefined;
  if (issues?.some((issue) => issue.message === 'INVALID_EXPORT_RANGE')) return message('invalidExportRange');
  if (issues?.length) return message(fallback);
  return error instanceof Error ? error.message : message(fallback);
}

function activeJobCount() {
  return Array.from(jobs.values()).filter((job) => job.status === 'queued' || job.status === 'running').length;
}

type TimelineClip = Project['tracks'][number]['clips'][number];
type ExportRequest = Partial<ExportOptions> & { audioOnly?: boolean; frameOnly?: boolean; projectRevision?: number };
type LegacyBundle = { format?: string; version?: number; project?: unknown };
type PortableBundleManifest = {
  format: 'cutloc-project';
  version: 2;
  exportedAt: string;
  projectFile: 'project.json';
  media: Array<{ assetId: string; file: string }>;
};

const STOCK_MEDIA = [
  { id: 'white', fileName: 'white.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'black', fileName: 'black.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sage', fileName: 'sage.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sunset', fileName: 'sunset.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'paper', fileName: 'paper.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'neon-grid', fileName: 'neon-grid.png', mimeType: 'image/png', width: 1600, height: 900 },
] as const;

function localizedStock(item: (typeof STOCK_MEDIA)[number]) {
  return { ...item, name: message(`stock.${item.id}.name` as ServerTranslationKey), description: message(`stock.${item.id}.description` as ServerTranslationKey) };
}

function isLocalHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isAllowedWebOrigin(origin: string | undefined) {
  if (!origin || origin === 'null') return !origin;
  try {
    const parsed = new URL(origin);
    const originPort = parsed.port ? Number(parsed.port) : undefined;
    return isLocalHostname(parsed.hostname.toLowerCase()) && (!parsed.port || originPort === runtimePort || originPort === webPort);
  } catch {
    return false;
  }
}

function isAllowedLocalRequest(request: FastifyRequest) {
  const host = request.headers.host;
  if (host) {
    const closingBracket = host.startsWith('[') ? host.indexOf(']') : -1;
    const hostname = (closingBracket > 0 ? host.slice(1, closingBracket) : host.split(':')[0]).toLowerCase();
    if (!isLocalHostname(hostname)) return false;
  }
  return isAllowedWebOrigin(request.headers.origin);
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

async function ensureDir(dir: string) {
  await fsp.mkdir(safeJoin(dataDir, dir), { recursive: true });
}

async function directorySize(dir: string): Promise<number> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const item = safeJoin(dir, entry.name);
    if (entry.isDirectory()) return directorySize(item);
    if (entry.isFile()) return (await fsp.stat(item)).size;
    return 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

function projectPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw Object.assign(new Error(message('invalidProjectId')), { statusCode: 400 });
  }
  return safeJoin(projectsDir, projectId);
}

function projectFile(projectId: string) {
  return path.join(projectPath(projectId), 'project.json');
}

async function atomicWrite(file: string, content: string) {
  const safeFile = safeJoin(dataDir, file);
  const temp = `${safeFile}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, content, 'utf8');
  await fsp.rename(temp, safeFile);
}

let jobsPersistTimer: NodeJS.Timeout | undefined;
let jobsPersistChain = Promise.resolve();

function persistedJobs() {
  return Array.from(jobs.values()).map((job) => {
    const { absoluteOutputPath: _absolute, outputPath: _legacyOutput, ...persisted } = job;
    return persisted;
  });
}

async function persistJobs() {
  await atomicWrite(jobsFile, JSON.stringify(persistedJobs(), null, 2));
}

function enqueueJobsPersist() {
  jobsPersistChain = jobsPersistChain.then(persistJobs, persistJobs).catch(() => undefined);
}

function scheduleJobsPersist() {
  if (jobsPersistTimer) clearTimeout(jobsPersistTimer);
  jobsPersistTimer = setTimeout(() => {
    jobsPersistTimer = undefined;
    enqueueJobsPersist();
  }, 100);
  jobsPersistTimer.unref?.();
}

async function flushJobsPersist() {
  if (jobsPersistTimer) {
    clearTimeout(jobsPersistTimer);
    jobsPersistTimer = undefined;
    enqueueJobsPersist();
  }
  await jobsPersistChain;
}

async function loadJobs() {
  try {
    const raw = JSON.parse(await fsp.readFile(jobsFile, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error('Invalid jobs history');
    jobs.clear();
    for (const item of raw.slice(-maxJobHistory)) {
      const publicPart = JobSchema.parse(item);
      const relativeOutputPath = typeof item === 'object' && item !== null && 'relativeOutputPath' in item && typeof item.relativeOutputPath === 'string'
        ? item.relativeOutputPath
        : undefined;
      if (relativeOutputPath) safeJoin(projectPath(publicPart.projectId), relativeOutputPath);
      const restored: InternalJob = { ...publicPart, ...(relativeOutputPath ? { relativeOutputPath } : {}) };
      if (restored.status === 'queued' || restored.status === 'running') {
        restored.status = 'failed';
        restored.error = message('jobInterrupted');
        restored.updatedAt = new Date().toISOString();
      }
      jobs.set(restored.id, restored);
    }
    pruneJobs();
    await persistJobs();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') await atomicWrite(jobsFile, '[]').catch(() => undefined);
  }
}

async function readProject(projectId: string): Promise<Project> {
  const validatedProjectId = path.basename(projectPath(projectId));
  const raw = await fsp.readFile(projectFile(validatedProjectId), 'utf8');
  const project = ProjectSchema.parse(JSON.parse(raw));
  if (project.id !== validatedProjectId) throw Object.assign(new Error(message('invalidProjectId')), { statusCode: 400 });
  return project;
}

type ProjectLifecycleState = 'active' | 'deleting' | 'deleted';
type ProjectLifecycle = { state: ProjectLifecycleState; generation: number };
type ServerTestHooks = {
  beforeSave?: (project: Project) => void | Promise<void>;
  beforeDerivedWrite?: (projectId: string) => void | Promise<void>;
  beforeRelinkMove?: (sourcePath: string, targetPath: string) => void | Promise<void>;
  beforePreviewRender?: (projectId: string) => void | Promise<void>;
};

// These hooks are intentionally narrow and are only used by deterministic
// filesystem-race regression tests. They do not alter the HTTP contract.
export const serverTestHooks: ServerTestHooks = {};
const projectLifecycles = new Map<string, ProjectLifecycle>();

function lifecycleFor(projectId: string): ProjectLifecycle {
  return projectLifecycles.get(projectId) ?? { state: 'active', generation: 0 };
}

function assertProjectActive(projectId: string, expectedGeneration?: number) {
  const lifecycle = lifecycleFor(projectId);
  if (lifecycle.state !== 'active' || (expectedGeneration !== undefined && lifecycle.generation !== expectedGeneration)) {
    throw Object.assign(new Error(message('projectNotFound')), { statusCode: 404 });
  }
  return lifecycle;
}

async function saveProject(project: Project) {
  await serverTestHooks.beforeSave?.(project);
  assertProjectActive(project.id);
  const dir = projectPath(project.id);
  await ensureDir(dir);
  const file = projectFile(project.id);
  if (fs.existsSync(file)) {
    await ensureDir(path.join(dir, 'backups'));
    const backup = path.join(dir, 'backups', `project-${Date.now()}.json`);
    await fsp.copyFile(file, backup);
    const backups = (await fsp.readdir(path.join(dir, 'backups'))).sort();
    for (const old of backups.slice(0, -5)) await fsp.rm(path.join(dir, 'backups', old), { force: true });
  }
  await atomicWrite(file, JSON.stringify(project, null, 2));
}

const projectLocks = new Map<string, Promise<void>>();

/** Serialize read/modify/write operations for one project. Proxy generation and
 * editor autosaves can finish at the same time, so the lock must cover the
 * read as well as the final atomic write. */
type ProjectLockOptions = { allowInactive?: boolean; enforceAccess?: boolean; accessToken?: string | string[] };

async function withProjectLock<T>(projectId: string, task: () => Promise<T>, options: ProjectLockOptions = {}): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  const queuedLifecycle = lifecycleFor(projectId);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  projectLocks.set(projectId, queued);
  await previous;
  try {
    if (!options.allowInactive) assertProjectActive(projectId, queuedLifecycle.generation);
    if (options.enforceAccess) assertProjectAccessToken(projectId, options.accessToken);
    return await task();
  } finally {
    release();
    if (projectLocks.get(projectId) === queued) projectLocks.delete(projectId);
  }
}

function publicAccessLease(lease: InternalProjectAccessLease): ProjectAccessLease {
  const { token: _token, ...publicLease } = lease;
  return publicLease;
}

function activeAccessLease(projectId: string) {
  const lease = projectAccessLeases.get(projectId);
  if (!lease) return undefined;
  if (Date.parse(lease.expiresAt) > Date.now()) return lease;
  projectAccessLeases.delete(projectId);
  publish('project-access', { projectId, lease: null });
  return undefined;
}

export function runtimeActivity() {
  for (const projectId of projectAccessLeases.keys()) activeAccessLease(projectId);
  return {
    activeJobs: activeJobCount(),
    activeLeases: projectAccessLeases.size,
    activePreviews: activePreviewRenders,
  };
}

export function closeRuntimeConnections() {
  for (const client of clients) client.reply.raw.end();
  clients.clear();
}

function projectIdFromApiUrl(url: string) {
  const pathname = url.split('?', 1)[0];
  const match = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/|$)/);
  return match?.[1];
}

function isAccessLeaseRoute(url: string) {
  return /^\/api\/projects\/[A-Za-z0-9_-]+\/access(?:\?|$)/.test(url);
}

function assertProjectAccess(request: FastifyRequest) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS' || isAccessLeaseRoute(request.url)) return;
  const projectId = projectIdFromApiUrl(request.url);
  if (!projectId) return;
  const lease = activeAccessLease(projectId);
  if (!lease || request.headers['x-cutloc-access-token'] === lease.token) return;
  throw Object.assign(new Error(message('projectLocked', { owner: lease.ownerLabel })), {
    statusCode: 423,
    code: 'PROJECT_LOCKED',
    lease: publicAccessLease(lease),
  });
}

function assertProjectAccessToken(projectId: string, token: string | string[] | undefined) {
  const lease = activeAccessLease(projectId);
  if (!lease || token === lease.token) return;
  throw Object.assign(new Error(message('projectLocked', { owner: lease.ownerLabel })), {
    statusCode: 423,
    code: 'PROJECT_LOCKED',
    lease: publicAccessLease(lease),
  });
}

function requestProjectLockOptions(request: FastifyRequest): ProjectLockOptions {
  return { enforceAccess: true, accessToken: request.headers['x-cutloc-access-token'] };
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await fsp.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    // Migrate preferences that older builds exposed before the corresponding
    // interface/encoder support existed, while preserving every other setting.
    stored.hardwareAcceleration = 'software';
    stored.experimentalAi = false;
    stored.shortcuts = DEFAULT_SHORTCUT_SETTINGS;
    settings = SettingsSchema.parse(stored);
  } catch {
    settings = defaultSettings();
  }
  settings = { ...settings, experimentalAi: false, hasOpenAiKey: false, hasGeminiKey: false };
}

async function saveSettings(next: Partial<Settings> & { openAiKey?: string; geminiKey?: string }) {
  const safe = SettingsSchema.parse({
    ...settings,
    ...next,
    shortcuts: DEFAULT_SHORTCUT_SETTINGS,
    experimentalAi: false,
    hasOpenAiKey: false,
    hasGeminiKey: false,
  });
  settings = safe;
  await ensureDir(dataDir);
  await atomicWrite(settingsFile, JSON.stringify(safe, null, 2));
  return safe;
}

const binaryPathCache = new Map<'ffmpeg' | 'ffprobe', string | null>();
const ffmpegFilterCache = new Map<string, boolean>();

function systemBinaryPath(name: 'ffmpeg' | 'ffprobe') {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
}

function ffmpegHasFilter(binary: string | null, filter: string) {
  if (!binary) return false;
  const cacheKey = `${binary}\0${filter}`;
  const cached = ffmpegFilterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = spawnSync(binary, ['-hide_banner', '-filters'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const available = result.status === 0 && new RegExp(`^\\s*[.A-Z]+\\s+${filter}\\s`, 'm').test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  ffmpegFilterCache.set(cacheKey, available);
  return available;
}

function binaryPath(name: 'ffmpeg' | 'ffprobe') {
  if (binaryPathCache.has(name)) return binaryPathCache.get(name) ?? null;
  const envPath = process.env[name.toUpperCase() + '_PATH'];
  if (envPath && fs.existsSync(envPath)) {
    binaryPathCache.set(name, envPath);
    return envPath;
  }
  let packaged: string | null = null;
  try {
    const value = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
    if (typeof value === 'string' && fs.existsSync(value)) packaged = value;
  } catch { /* package optional during development */ }
  const system = systemBinaryPath(name);
  const resolved = name === 'ffmpeg'
    ? [packaged, system].find((candidate) => ffmpegHasFilter(candidate, 'drawtext')) ?? packaged ?? system
    : packaged ?? system;
  binaryPathCache.set(name, resolved ?? null);
  return resolved ?? null;
}

async function probeMedia(file: string) {
  const ffprobe = binaryPath('ffprobe');
  if (!ffprobe) return {};
  return await new Promise<Record<string, unknown>>((resolve) => {
    const child = spawn(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
    let out = '';
    const maxProbeOutputBytes = 4 * 1024 * 1024;
    const timeout = setTimeout(() => child.kill(), Math.min(maxFfmpegRuntimeMs, 5 * 60 * 1000));
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (Buffer.byteLength(out) > maxProbeOutputBytes) {
        out = '';
        child.kill();
      }
    });
    child.once('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(out) as { format?: { duration?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
        const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
        const audio = parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
        resolve({
          formatName: parsed.format?.format_name,
          duration: Number(parsed.format?.duration ?? video?.duration ?? 0),
          width: Number(video?.width ?? 0) || undefined,
          height: Number(video?.height ?? 0) || undefined,
          fps: typeof video?.r_frame_rate === 'string' && video.r_frame_rate.includes('/')
            ? Number(video.r_frame_rate.split('/')[0]) / Number(video.r_frame_rate.split('/')[1])
            : undefined,
          hasAudio: audio,
          hasVideo: Boolean(video),
        });
      } catch { resolve({}); }
    });
  });
}

function publicJob(job: InternalJob): Job {
  const safeJob = { ...job };
  delete safeJob.outputPath;
  delete safeJob.absoluteOutputPath;
  delete safeJob.relativeOutputPath;
  if (job.kind === 'export') safeJob.downloadUrl = `/api/jobs/${job.id}/download`;
  return JobSchema.parse(safeJob);
}

function publish(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.reply.raw.write(payload);
}

function updateJob(jobId: string, patch: Partial<InternalJob>) {
  const job = jobs.get(jobId);
  if (!job) return;
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  scheduleJobsPersist();
  pruneJobs();
  publish('job', publicJob(next));
}

async function cancelProjectJobs(projectId: string) {
  const terminations: Promise<void>[] = [];
  for (const job of jobs.values()) {
    if (job.projectId !== projectId || !['queued', 'running'].includes(job.status)) continue;
    const process = jobProcesses.get(job.id);
    if (process) {
      terminations.push(new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(finish, 5000);
        timeout.unref?.();
        process.once('close', finish);
        process.once('error', finish);
        try {
          if (process.exitCode === null) process.kill();
          else finish();
        } catch {
          finish();
        }
      }));
    }
    updateJob(job.id, { status: 'cancelled', message: message('cancelledMessage') });
  }
  await Promise.all(terminations);
}

function pruneJobs() {
  if (jobs.size <= maxJobHistory) return;
  const removable = Array.from(jobs.values())
    .filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const job of removable.slice(0, Math.max(0, jobs.size - maxJobHistory))) jobs.delete(job.id);
  scheduleJobsPersist();
}

async function makeJob(projectId: string, kind: Job['kind'], runner: (job: InternalJob) => Promise<void>) {
  assertProjectActive(projectId);
  if (activeJobCount() >= maxConcurrentJobs) throw Object.assign(new Error(message(kind === 'proxy' ? 'tooManyMediaJobs' : 'tooManyJobs')), { statusCode: 429 });
  const now = new Date().toISOString();
  const job: Job = { id: id('job'), projectId, kind, status: 'queued', progress: 0, createdAt: now, updatedAt: now };
  jobs.set(job.id, job);
  scheduleJobsPersist();
  pruneJobs();
  publish('job', publicJob(job));
  // A cancelled process can still reject while its child is being reaped.  Do
  // not turn that expected rejection into a misleading "failed" state.
  void (async () => {
    assertProjectActive(projectId);
    await runner(job);
  })().catch((error: unknown) => {
    const current = jobs.get(job.id);
    if (current?.status === 'cancelled') return;
    updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  });
  return job;
}

async function runFfmpeg(args: string[], job: Job, outputPath?: string) {
  if (jobs.get(job.id)?.status === 'cancelled') throw new Error(message('cancelled'));
  const ffmpeg = binaryPath('ffmpeg');
  if (!ffmpeg) throw new Error(message('ffmpegMissingDetailed'));
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    jobProcesses.set(job.id, child);
    if (jobs.get(job.id)?.status === 'cancelled') child.kill();
    const timeout = setTimeout(() => child.kill(), maxFfmpegRuntimeMs);
    let stderr = '';
    const maxStderrChars = 64 * 1024;
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-maxStderrChars);
      const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr.slice(-500));
      if (match) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        updateJob(job.id, { status: 'running', progress: Math.min(0.98, seconds / Math.max(1, jobProgressDuration.get(job.id) ?? 1)) });
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      jobProcesses.delete(job.id);
      jobProgressDuration.delete(job.id);
      if (outputPath) void fsp.rm(outputPath, { force: true }).catch(() => undefined);
      reject(error);
    });
    child.once('close', async (code) => {
      clearTimeout(timeout);
      jobProcesses.delete(job.id);
      jobProgressDuration.delete(job.id);
      if (code === 0 && jobs.get(job.id)?.status !== 'cancelled') {
        if (!outputPath) {
          resolve();
          return;
        }
        try {
          const output = await fsp.stat(outputPath);
          if (output.size <= 0) throw new Error(message('ffmpegEmpty'));
          resolve();
          return;
        } catch (error) {
          await fsp.rm(outputPath, { force: true }).catch(() => undefined);
          reject(error instanceof Error ? error : new Error(message('ffmpegOutputInvalid')));
          return;
        }
      }
      // The output is always a newly generated file.  Removing a partial file
      // makes retrying safe and prevents a failed export looking complete in
      // the exports directory.
      if (outputPath) void fsp.rm(outputPath, { force: true }).catch(() => undefined);
      if (jobs.get(job.id)?.status === 'cancelled') {
        reject(new Error(message('cancelled')));
        return;
      }
      reject(new Error(stderr.slice(-2400) || `FFmpeg exit code ${code}`));
    });
  });
}

const jobProgressDuration = new Map<string, number>();
const activeDerivedJobs = new Map<string, Job>();

async function stageGeneratedFiles(files: Array<{ tempPath: string; finalPath: string }>) {
  const staged = files.map(({ tempPath, finalPath }) => ({ tempPath, finalPath, backupPath: `${finalPath}.previous-${crypto.randomUUID()}`, hadPrevious: fs.existsSync(finalPath), published: false }));
  try {
    for (const file of staged) {
      if (file.hadPrevious) await fsp.rename(file.finalPath, file.backupPath);
      await fsp.rename(file.tempPath, file.finalPath);
      file.published = true;
    }
  } catch (error) {
    for (const file of staged.slice().reverse()) {
      if (file.published) await fsp.rm(file.finalPath, { force: true }).catch(() => undefined);
      if (file.hadPrevious && fs.existsSync(file.backupPath)) await fsp.rename(file.backupPath, file.finalPath).catch(() => undefined);
    }
    throw error;
  }
  return {
    commit: async () => { await Promise.all(staged.filter((file) => file.hadPrevious).map((file) => fsp.rm(file.backupPath, { force: true }))); },
    rollback: async () => {
      for (const file of staged.slice().reverse()) {
        await fsp.rm(file.finalPath, { force: true }).catch(() => undefined);
        if (file.hadPrevious && fs.existsSync(file.backupPath)) await fsp.rename(file.backupPath, file.finalPath).catch(() => undefined);
      }
    },
  };
}

async function launchRenderBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      throw new Error(`Chromium renderer could not start: ${bundledError instanceof Error ? bundledError.message : String(bundledError)}`);
    }
  }
}

async function prepareRenderPage(browser: Browser, projectId: string, width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${runtimePort}/?renderProject=${encodeURIComponent(projectId)}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction((id) => (window as Window & { __cutlocRenderer?: { projectId: string } }).__cutlocRenderer?.projectId === id, projectId, { timeout: 30_000 });
  const canvas = page.locator('.canvas-frame');
  await canvas.waitFor({ state: 'visible', timeout: 30_000 });
  const box = await canvas.boundingBox();
  if (!box || Math.abs(box.width - width) > 1 || Math.abs(box.height - height) > 1) {
    await page.close();
    throw new Error(`Browser compositor size mismatch: expected ${width}x${height}, received ${box ? `${box.width}x${box.height}` : 'no canvas'}`);
  }
  return page;
}

async function captureRenderPage(page: Page, session?: CDPSession) {
  if (!session) return page.screenshot({ type: 'png' });
  const result = await session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  return Buffer.from(result.data, 'base64');
}

async function browserRenderedFrame(projectId: string, width: number, height: number, time: number, signal?: AbortSignal) {
  const browser = await launchRenderBrowser();
  const abort = () => { void browser.close().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  let page: Page | undefined;
  try {
    if (signal?.aborted) throw new Error(message('cancelled'));
    page = await prepareRenderPage(browser, projectId, width, height);
    await page.evaluate(async (seekTime) => {
      const renderer = (window as Window & { __cutlocRenderer?: { seek: (time: number) => Promise<unknown> } }).__cutlocRenderer;
      if (!renderer) throw new Error('Browser compositor is not ready');
      await renderer.seek(seekTime);
    }, time);
    if (signal?.aborted) throw new Error(message('cancelled'));
    const session = await page.context().newCDPSession(page);
    return await captureRenderPage(page, session);
  } finally {
    signal?.removeEventListener('abort', abort);
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function browserRenderedExport(project: Project, options: ExportOptions, outputPath: string, job: Job) {
  const ffmpeg = binaryPath('ffmpeg');
  if (!ffmpeg) throw new Error(message('ffmpegMissingDetailed'));
  const { width, height } = outputDimensions(project, project.canvas.aspect, options.resolution);
  const rangeStart = options.range?.start ?? 0;
  const rangeEnd = options.range?.end ?? project.duration;
  const duration = Math.max(1 / options.fps, rangeEnd - rangeStart);
  const frameCount = Math.max(1, Math.ceil(duration * options.fps));
  const audioRender = compileComposition(project, { ...options, aspect: project.canvas.aspect, format: 'wav', audioOnly: true }, `${outputPath}.audio.wav`);
  const filterIndex = audioRender.args.indexOf('-filter_complex');
  if (filterIndex < 0) throw new Error('Audio graph is missing');
  const audioInputs = audioRender.args.slice(0, filterIndex);
  const audioGraph = audioRender.args[filterIndex + 1];
  const imageInputIndex = audioInputs.filter((value) => value === '-i').length;
  const quality = options.quality === 'draft'
    ? { preset: 'veryfast', crf: 28 }
    : options.quality === 'high'
      ? { preset: 'slow', crf: 18 }
      : { preset: 'medium', crf: 23 };
  const encodeArgs = [
    ...audioInputs,
    '-f', 'image2pipe', '-framerate', ffmpegNumber(options.fps), '-vcodec', 'png', '-i', 'pipe:0',
    '-filter_complex', audioGraph,
    '-map', `${imageInputIndex}:v`, '-map', '[aout]', '-t', ffmpegNumber(duration), '-r', ffmpegNumber(options.fps), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', quality.preset,
    ...(options.rateMode === 'bitrate' && options.videoBitrateKbps ? ['-b:v', `${options.videoBitrateKbps}k`] : ['-crf', String(options.crf ?? quality.crf)]),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', `${options.audioBitrateKbps}k`, '-movflags', '+faststart', outputPath,
  ];
  const browser = await launchRenderBrowser();
  const concurrency = width * height > 1920 * 1080 ? 2 : Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
  const pages: Page[] = [];
  const sessions: CDPSession[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    pages.push(...await Promise.all(Array.from({ length: concurrency }, () => prepareRenderPage(browser, project.id, width, height))));
    sessions.push(...await Promise.all(pages.map((page) => page.context().newCDPSession(page))));
    child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...encodeArgs], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    if (!child.stdin || !child.stderr) throw new Error('FFmpeg pipe creation failed');
    const encoderInput = child.stdin;
    const encoderError = child.stderr;
    jobProcesses.set(job.id, child);
    let stderr = '';
    encoderError.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
    const completion = new Promise<void>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', (code) => {
        if (code === 0 && jobs.get(job.id)?.status !== 'cancelled') resolve();
        else reject(new Error(jobs.get(job.id)?.status === 'cancelled' ? message('cancelled') : stderr.slice(-2400) || `FFmpeg exit code ${code}`));
      });
    });
    const writeFrame = async (buffer: Buffer) => {
      if (!encoderInput.write(buffer)) await new Promise<void>((resolve) => encoderInput.once('drain', resolve));
    };
    for (let start = 0; start < frameCount; start += pages.length) {
      if (jobs.get(job.id)?.status === 'cancelled') throw new Error(message('cancelled'));
      const indices = pages.map((_, offset) => start + offset).filter((index) => index < frameCount);
      const frames = await Promise.all(indices.map(async (frameIndex, offset) => {
        const time = rangeStart + frameIndex / options.fps;
        await pages[offset].evaluate(async (seekTime) => {
          const renderer = (window as Window & { __cutlocRenderer?: { seek: (time: number) => Promise<unknown> } }).__cutlocRenderer;
          if (!renderer) throw new Error('Browser compositor is not ready');
          await renderer.seek(seekTime);
        }, time);
        return captureRenderPage(pages[offset], sessions[offset]);
      }));
      for (const frame of frames) await writeFrame(frame);
      updateJob(job.id, { status: 'running', phase: 'rendering', progress: Math.min(0.96, (start + frames.length) / frameCount * 0.96) });
    }
    encoderInput.end();
    await completion;
    const stat = await fsp.stat(outputPath);
    if (stat.size <= 0) throw new Error(message('ffmpegEmpty'));
  } finally {
    jobProcesses.delete(job.id);
    if (child && child.exitCode === null) child.kill();
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    await browser.close().catch(() => undefined);
  }
}

async function publishGeneratedFile(tempPath: string, finalPath: string) {
  const publication = await stageGeneratedFiles([{ tempPath, finalPath }]);
  await publication.commit();
}

async function queueDerivedMediaJob(projectId: string, asset: Asset) {
  assertProjectActive(projectId);
  const assetJobKey = `${projectId}:${asset.id}`;
  const existing = activeDerivedJobs.get(assetJobKey);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) return existing;
  const sourcePath = assetFile(projectId, asset);
  if (!fs.existsSync(sourcePath)) throw Object.assign(new Error(message('sourceMissing')), { statusCode: 404 });
  const sourceSnapshot = await fsp.stat(sourcePath);
  const sourceFingerprint = `${sourceSnapshot.size}:${sourceSnapshot.mtimeMs}:${sourceSnapshot.ctimeMs}`;
  const quality = settings?.proxyQuality === 'draft'
    ? { width: 640, crf: 32, preset: 'veryfast' }
    : settings?.proxyQuality === 'high'
      ? { width: 1280, crf: 26, preset: 'faster' }
      : { width: 960, crf: 30, preset: 'veryfast' };
  const job = await makeJob(projectId, 'proxy', async (jobInfo) => {
    const tempPaths: string[] = [];
    try {
      assertProjectActive(projectId);
      updateJob(jobInfo.id, { status: 'running', message: message('derivativesPreparing') });
      await serverTestHooks.beforeDerivedWrite?.(projectId);
      assertProjectActive(projectId);
      const proxyDir = path.join(projectPath(projectId), 'proxies');
      const thumbnailDir = path.join(projectPath(projectId), 'thumbnails');
      const waveformDir = path.join(projectPath(projectId), 'waveforms');
      await Promise.all([ensureDir(proxyDir), ensureDir(thumbnailDir), ensureDir(waveformDir)]);
      if (!binaryPath('ffmpeg')) throw new Error(message('ffmpegDerivativesMissing'));
      const proxyPath = path.join(proxyDir, `${asset.id}.mp4`);
      const thumbnailPath = path.join(thumbnailDir, `${asset.id}.jpg`);
      const waveformPath = path.join(waveformDir, `${asset.id}.png`);
      const proxyTemp = path.join(proxyDir, `${asset.id}.${jobInfo.id}.tmp.mp4`);
      const thumbnailTemp = path.join(thumbnailDir, `${asset.id}.${jobInfo.id}.tmp.jpg`);
      const waveformTemp = path.join(waveformDir, `${asset.id}.${jobInfo.id}.tmp.png`);
      tempPaths.push(proxyTemp, thumbnailTemp, waveformTemp);
      jobProgressDuration.set(jobInfo.id, asset.duration || 1);
      let proxyRelative: string | undefined;
      let thumbnailRelative: string | undefined;
      let waveformRelative: string | undefined;
      if (asset.type === 'video') {
        assertProjectActive(projectId);
        await runFfmpeg(['-i', sourcePath, '-vf', `scale=${quality.width}:-2:force_original_aspect_ratio=decrease`, '-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf), '-c:a', 'aac', '-b:a', '128k', proxyTemp], jobInfo, proxyTemp);
        proxyRelative = path.relative(projectPath(projectId), proxyPath);
      }
      if (asset.type === 'video' || asset.type === 'image') {
        assertProjectActive(projectId);
        const thumbnailTime = Math.max(0, Math.min(0.2, Math.max(0, asset.duration - 0.001)));
        const thumbnailInput = asset.type === 'video' && thumbnailTime > 0 ? ['-ss', ffmpegNumber(thumbnailTime), '-i', sourcePath] : ['-i', sourcePath];
        await runFfmpeg([...thumbnailInput, '-frames:v', '1', '-vf', 'scale=480:-2', thumbnailTemp], jobInfo, thumbnailTemp);
        thumbnailRelative = path.relative(projectPath(projectId), thumbnailPath);
      }
      if (asset.hasAudio || asset.type === 'audio') {
        assertProjectActive(projectId);
        await runFfmpeg(['-i', sourcePath, '-filter_complex', 'showwavespic=s=900x120:colors=80e6c4:scale=sqrt', '-frames:v', '1', waveformTemp], jobInfo, waveformTemp);
        waveformRelative = path.relative(projectPath(projectId), waveformPath);
      }
      assertProjectActive(projectId);
      await withProjectLock(projectId, async () => {
        const updated = await readProject(projectId);
        const index = updated.assets.findIndex((item) => item.id === asset.id);
        const currentAsset = index >= 0 ? updated.assets[index] : undefined;
        const currentSource = await fsp.stat(sourcePath).catch(() => undefined);
        const currentFingerprint = currentSource ? `${currentSource.size}:${currentSource.mtimeMs}:${currentSource.ctimeMs}` : '';
        const sameSource = currentAsset
          && currentAsset.name === asset.name
          && currentAsset.size === asset.size
          && currentAsset.path.replaceAll('\\', '/') === asset.path.replaceAll('\\', '/')
          && currentFingerprint === sourceFingerprint;
        if (!sameSource) throw new Error(message('cancelled'));
        const publication = await stageGeneratedFiles([
          ...(proxyRelative ? [{ tempPath: proxyTemp, finalPath: proxyPath }] : []),
          ...(thumbnailRelative ? [{ tempPath: thumbnailTemp, finalPath: thumbnailPath }] : []),
          ...(waveformRelative ? [{ tempPath: waveformTemp, finalPath: waveformPath }] : []),
        ]);
        try {
          updated.assets[index] = { ...currentAsset, proxyPath: proxyRelative, thumbnailPath: thumbnailRelative, waveformPath: waveformRelative };
          await saveProject(ProjectSchema.parse({ ...updated, revision: updated.revision + 1, updatedAt: new Date().toISOString() }));
          await publication.commit();
        } catch (error) {
          await publication.rollback();
          throw error;
        }
      });
      updateJob(jobInfo.id, { status: 'completed', progress: 1, message: message('mediaReady') });
    } finally {
      await Promise.all(tempPaths.map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
      if (activeDerivedJobs.get(assetJobKey)?.id === jobInfo.id) activeDerivedJobs.delete(assetJobKey);
    }
  });
  activeDerivedJobs.set(assetJobKey, job);
  return job;
}

function safeJoin(base: string, candidate: string) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, candidate);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(message('invalidPath'));
  return resolved;
}

function safeExistingPath(base: string, candidate: string) {
  const resolved = safeJoin(base, candidate);
  if (!fs.existsSync(resolved)) return resolved;
  const realBase = fs.realpathSync.native(base);
  const realPath = fs.realpathSync.native(resolved);
  const relative = path.relative(realBase, realPath);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(message('invalidPath'));
  return realPath;
}

function safeManagedAssetPath(projectId: string, candidate: string) {
  const normalized = candidate.replaceAll('\\', '/');
  const match = /^(media|proxies|thumbnails|waveforms)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(normalized);
  if (!match) throw new Error(message('invalidPath'));
  const root = projectPath(projectId);
  const folder = safeJoin(root, match[1]);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error(message('invalidPath'));
  if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) throw new Error(message('invalidPath'));
  const target = safeJoin(folder, match[2]);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(message('invalidPath'));
  return target;
}

function assetFile(projectId: string, asset: Asset) {
  return safeManagedAssetPath(projectId, asset.path);
}

async function replaceMediaWithRollback(sourcePath: string, targetPath: string, commit: () => Promise<void>, previousTargetPath = targetPath) {
  const backupPath = previousTargetPath + '.' + process.pid + '.' + crypto.randomUUID() + '.backup';
  let oldMoved = false;
  let newMoved = false;
  try {
    if (fs.existsSync(previousTargetPath)) {
      await fsp.rename(previousTargetPath, backupPath);
      oldMoved = true;
    }
    await serverTestHooks.beforeRelinkMove?.(sourcePath, targetPath);
    await fsp.rename(sourcePath, targetPath);
    newMoved = true;
    await commit();
    if (oldMoved) await fsp.rm(backupPath, { force: true }).catch(() => undefined);
  } catch (error) {
    if (newMoved || fs.existsSync(targetPath)) await fsp.rm(targetPath, { force: true }).catch(() => undefined);
    if (oldMoved && fs.existsSync(backupPath)) await fsp.rename(backupPath, previousTargetPath).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(sourcePath, { force: true }).catch(() => undefined);
  }
}
function bundleAssetExtension(asset: Asset) {
  const extension = path.extname(asset.path).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  return asset.type === 'video' ? '.mp4' : asset.type === 'audio' ? '.wav' : '.png';
}

function portableBundleFilePath(value: unknown) {
  if (typeof value !== 'string' || !/^media\/[A-Za-z0-9._-]+$/.test(value)) throw new Error(message('invalidBundle'));
  return value;
}

async function createPortableBundle(project: Project) {
  const media: PortableBundleManifest['media'] = [];
  const files: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify(project, null, 2)),
  };
  for (const [index, asset] of project.assets.entries()) {
    const source = assetFile(project.id, asset);
    if (!fs.existsSync(source)) throw new Error(message('bundleMediaMissing', { name: asset.name }));
    const file = `media/${index}${bundleAssetExtension(asset)}`;
    media.push({ assetId: asset.id, file });
    files[file] = new Uint8Array(await fsp.readFile(source));
  }
  const manifest: PortableBundleManifest = {
    format: 'cutloc-project',
    version: 2,
    exportedAt: new Date().toISOString(),
    projectFile: 'project.json',
    media,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

function parsePortableBundle(payload: Buffer) {
  const files = unzipSync(payload);
  const manifestFile = files['manifest.json'];
  const projectFileContent = files['project.json'];
  if (!manifestFile || !projectFileContent) throw new Error(message('invalidBundle'));
  const manifest = JSON.parse(strFromU8(manifestFile)) as Partial<PortableBundleManifest>;
  if (manifest.format !== 'cutloc-project' || manifest.version !== 2 || manifest.projectFile !== 'project.json' || !Array.isArray(manifest.media)) {
    throw new Error(message('invalidBundle'));
  }
  const source = ProjectSchema.parse(JSON.parse(strFromU8(projectFileContent)));
  const entries = new Map<string, Uint8Array>();
  const assetFiles = new Map<string, Uint8Array>();
  for (const entry of manifest.media) {
    if (!entry || typeof entry.assetId !== 'string' || entries.has(entry.assetId)) throw new Error(message('invalidBundle'));
    const file = portableBundleFilePath(entry.file);
    const content = files[file];
    if (!content) throw new Error(message('bundleMediaMissing', { name: entry.assetId }));
    entries.set(entry.assetId, content);
  }
  for (const asset of source.assets) {
    if (assetFiles.has(asset.id)) throw new Error(message('invalidBundle'));
    const content = entries.get(asset.id);
    if (!content) throw new Error(message('bundleMediaMissing', { name: asset.name }));
    assetFiles.set(asset.id, content);
  }
  if (entries.size !== source.assets.length) throw new Error(message('invalidBundle'));
  return { source, assetFiles };
}

function parseLegacyBundle(submitted: unknown) {
  const raw = (submitted && typeof submitted === 'object' && 'bundle' in submitted
    ? (submitted as { bundle?: LegacyBundle }).bundle
    : submitted) as LegacyBundle | undefined;
  if (!raw || raw.format !== 'cutloc-project' || raw.version !== 1 || !raw.project) throw new Error(message('invalidBundle'));
  return ProjectSchema.parse(raw.project);
}

async function importProject(source: Project, sourceFiles?: Map<string, Uint8Array>) {
  const importedId = id('project');
  const now = new Date().toISOString();
  const assetIds = new Set<string>();
  const assetIdMap = new Map<string, string>();
  const assets = source.assets.map((asset) => {
    if (assetIds.has(asset.id)) throw new Error(message('invalidBundle'));
    assetIds.add(asset.id);
    const importedAssetId = id('asset');
    assetIdMap.set(asset.id, importedAssetId);
    return {
      ...asset,
      id: importedAssetId,
      path: path.join('media', `${importedAssetId}${bundleAssetExtension(asset)}`),
      proxyPath: undefined,
      thumbnailPath: undefined,
      waveformPath: undefined,
    };
  });
  const tracks = source.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!clip.assetId) return clip;
      const importedAssetId = assetIdMap.get(clip.assetId);
      if (!importedAssetId) throw new Error(message('invalidBundle'));
      return { ...clip, assetId: importedAssetId };
    }),
  }));
  const project = ProjectSchema.parse({ ...source, id: importedId, name: message('bundleSuffix', { name: source.name }), createdAt: now, updatedAt: now, revision: 0, assets, tracks });
  await ensureProjectFolders(project.id);
  try {
    if (sourceFiles) {
      await Promise.all(source.assets.map(async (sourceAsset, index) => {
        const content = sourceFiles.get(sourceAsset.id);
        if (!content) throw new Error(message('bundleMediaMissing', { name: sourceAsset.name }));
        const target = safeJoin(projectPath(project.id), project.assets[index].path);
        await fsp.writeFile(target, content);
      }));
    }
    await saveProject(project);
    return project;
  } catch (error) {
    await fsp.rm(projectPath(project.id), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const supportedExportFps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

function nearestExportFps(value: unknown, fallback = 30) {
  const requested = numberOr(value, fallback);
  return supportedExportFps.reduce((best, candidate) => Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best, supportedExportFps[0]);
}

function defaultAspect(project: Project) {
  if (project.canvas.aspect) return project.canvas.aspect;
  if (project.canvas.width === project.canvas.height) return '1:1' as const;
  return project.canvas.width > project.canvas.height ? '16:9' as const : '9:16' as const;
}

function normalizeExportOptions(project: Project, request: ExportRequest = {}): ExportOptions {
  const format = request.format ?? (request.audioOnly ? 'mp3' : 'mp4');
  return ExportOptionsSchema.parse({
    ...request,
    format,
    aspect: request.aspect ?? defaultAspect(project),
    resolution: request.resolution ?? '1080p',
    fps: request.fps ?? nearestExportFps(project.canvas.fps, 30),
    quality: request.quality ?? 'standard',
    audioBitrateKbps: request.audioBitrateKbps ?? 256,
  });
}

function outputDimensions(project: Project, aspect: ExportOptions['aspect'], resolution: ExportOptions['resolution']) {
  return exportDimensions(aspect, resolution, { width: project.canvas.width, height: project.canvas.height });
}

function safeExportName(project: Project, requested: string | undefined, extension: string) {
  const withoutExtension = path.basename(requested?.trim() || project.name).replace(/\.[^.]+$/, '');
  const safe = withoutExtension.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';
  return `${safe}.${extension}`;
}

async function runFfmpegStandalone(args: string[], outputPath: string, signal?: AbortSignal) {
  const ffmpeg = binaryPath('ffmpeg');
  if (!ffmpeg) throw new Error(message('ffmpegMissingDetailed'));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    const timeout = setTimeout(() => child.kill(), Math.min(maxFfmpegRuntimeMs, 120_000));
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(Object.assign(new Error('Preview render cancelled'), { name: 'AbortError' })));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(stderr.slice(-2400) || `FFmpeg exit code ${code}`));
      });
    });
  });
  const stat = await fsp.stat(outputPath);
  if (stat.size <= 0) throw new Error(message('ffmpegEmpty'));
}

function attachmentContentDisposition(fileName: string) {
  const safeName = path.basename(fileName).replace(/["\r\n]/g, '-');
  const asciiName = safeName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '-')
    .trim() || 'export';
  const encodedName = encodeURIComponent(safeName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function uniqueOutputPath(exportDir: string, fileName: string) {
  const parsed = path.parse(fileName);
  let candidate = path.join(exportDir, fileName);
  let index = 2;
  while (fs.existsSync(candidate) || reservedExportPaths.has(candidate)) candidate = path.join(exportDir, `${parsed.name}-${index++}${parsed.ext}`);
  return safeJoin(exportDir, path.relative(exportDir, candidate));
}

function visibleRenderClip(clip: TimelineClip, rangeStart: number, rangeEnd: number): TimelineClip | null {
  const clipStart = Math.max(0, numberOr(clip.start, 0));
  const clipEnd = clipStart + Math.max(0, numberOr(clip.duration, 0));
  const visibleStart = Math.max(clipStart, rangeStart);
  const visibleEnd = Math.min(clipEnd, rangeEnd);
  if (visibleEnd <= visibleStart) return null;
  const sliced = sliceClipForRange(clip, visibleStart - clipStart, visibleEnd - clipStart);
  return { ...sliced, start: visibleStart - rangeStart, duration: visibleEnd - visibleStart };
}

type AdjustmentRenderSegment = {
  start: number;
  end: number;
  filters: TimelineClip['filters'];
};

const EMPTY_FILTERS: TimelineClip['filters'] = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
  grayscale: 0,
  temperature: 0,
  hue: 0,
  vignette: 0,
};

function normalizeCrop(crop: NonNullable<TimelineClip['crop']>) {
  const x = clamp(numberOr(crop.x, 0), 0, 0.99);
  const y = clamp(numberOr(crop.y, 0), 0, 0.99);
  return {
    x,
    y,
    width: clamp(Math.min(numberOr(crop.width, 1), 1 - x), 0.01, 1),
    height: clamp(Math.min(numberOr(crop.height, 1), 1 - y), 0.01, 1),
  };
}

function ffmpegNumber(value: number) {
  // Filter expressions are easier to debug when they never contain scientific
  // notation.  Keep enough precision for frame-accurate clip boundaries.
  const finite = Number.isFinite(value) ? value : 0;
  return finite.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function appendColorFilters(target: string[], values: TimelineClip['filters'], interval?: { start: number; end: number }) {
  const enabled = interval ? `:enable='between(t,${ffmpegNumber(interval.start)},${ffmpegNumber(interval.end)})'` : '';
  const brightness = numberOr(values.brightness, 0);
  const contrast = numberOr(values.contrast, 0);
  const saturation = numberOr(values.saturation, 0);
  if (Math.abs(brightness) > 0.001 || Math.abs(contrast) > 0.001 || Math.abs(saturation) > 0.001) {
    target.push(`eq=brightness=${ffmpegNumber(brightness)}:contrast=${ffmpegNumber(1 + contrast)}:saturation=${ffmpegNumber(1 + saturation)}${enabled}`);
  }
  const blur = Math.max(0, numberOr(values.blur, 0));
  if (blur > 0.01) target.push(`boxblur=luma_radius=${ffmpegNumber(Math.max(1, blur / 2))}:luma_power=1${enabled}`);
  if (numberOr(values.grayscale, 0) > 0.01) target.push(`hue=s=0${enabled}`);
  const temperature = numberOr(values.temperature, 0);
  if (Math.abs(temperature) > 0.001) target.push(`colorbalance=rs=${ffmpegNumber(temperature * 0.35)}:gs=${ffmpegNumber(temperature * 0.08)}:bs=${ffmpegNumber(-temperature * 0.35)}${enabled}`);
  const hue = numberOr(values.hue, 0);
  if (Math.abs(hue) > 0.001) target.push(`hue=h=${ffmpegNumber(hue)}${enabled}`);
  const vignette = clamp(numberOr(values.vignette, 0), 0, 1);
  if (vignette > 0.001) target.push(`vignette=angle=${ffmpegNumber(Math.PI / 4 + vignette * Math.PI / 4)}${enabled}`);
  if (values.chromaKey) {
    const key = values.chromaKey;
    target.push(`chromakey=${ffmpegColor(key.color)}:${ffmpegNumber(key.similarity)}:${ffmpegNumber(key.blend)}${enabled}`);
  }
}

function ffmpegColor(value: string) {
  const normalized = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(normalized)) {
    const alpha = Number.parseInt(normalized.slice(6), 16) / 255;
    return `0x${normalized.slice(0, 6)}@${ffmpegNumber(alpha)}`;
  }
  return /^[0-9a-f]{6}$/i.test(normalized) ? `0x${normalized}` : '0x101116';
}

function ffmpegText(value: string) {
  return normalizeTextLineBreaks(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll(':', '\\:')
    .replaceAll('%', '\\%')
    .replaceAll('\r', '\n');
}

function ffmpegFont(value: string) {
  const family = String(value || 'Arial').split(',')[0].trim() || 'Arial';
  return ffmpegText(family);
}

function ffmpegFontSource(value: string, weight = 400, fontStyle: 'normal' | 'italic' = 'normal') {
  const family = String(value || 'Arial').split(',')[0].trim() || 'Arial';
  const bold = weight >= 600;
  const italic = fontStyle === 'italic';
  const windowsFiles: Record<string, [string, string, string, string]> = {
    arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
    'courier new': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
    'segoe ui': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
    'times new roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  };
  const names = windowsFiles[family.toLowerCase()];
  if (process.platform === 'win32' && names) {
    const index = bold ? italic ? 3 : 1 : italic ? 2 : 0;
    const fontFile = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', names[index]);
    if (fs.existsSync(fontFile)) {
      const escaped = fontFile.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
      return `fontfile='${escaped}'`;
    }
  }
  return `font='${ffmpegFont(family)}'`;
}

function atempoChain(speed: number) {
  const filters: string[] = [];
  let remaining = Math.max(0.25, Math.min(4, speed));
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining *= 2;
  }
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 0.0001) filters.push(`atempo=${ffmpegNumber(remaining)}`);
  return filters;
}

function exportClipDuration(clip: TimelineClip, projectDuration: number) {
  const start = Math.max(0, numberOr(clip.start, 0));
  return Math.max(0, Math.min(numberOr(clip.duration, 0), projectDuration - start));
}

/**
 * Build one deterministic FFmpeg invocation for a timeline.  Keeping all
 * media as separate inputs and composing them in a filter graph means image
 * clips, audio-only timelines, gaps, and multiple overlay tracks all export
 * consistently with the preview's timeline coordinates.
 */
function compileComposition(project: Project, request: ExportRequest, output: string) {
  const body = normalizeExportOptions(project, request);
  const { width: outWidth, height: outHeight } = outputDimensions(project, body.aspect, body.resolution);
  // Clip transforms are stored in project-canvas pixels. Export presets may
  // render that canvas at a different resolution, so positional and text
  // metrics must be mapped into output pixels before FFmpeg evaluates them.
  const outputScaleX = outWidth / Math.max(1, numberOr(project.canvas.width, outWidth));
  const outputScaleY = outHeight / Math.max(1, numberOr(project.canvas.height, outHeight));
  const fps = body.fps;
  const audioOnly = body.format === 'mp3' || body.format === 'wav' || request.audioOnly === true;
  const visualPlan = visualLayerPlan(project);
  const visualByClipId = new Map(visualPlan.map((item) => [item.clip.id, item]));
  const allTimelineClips: Array<{ clip: TimelineClip; asset: Asset; trackMuted: boolean; trackVolume: number; stackOrder: number; visualVisible: boolean }> = [];
  const allTextClips: Array<{ clip: TimelineClip; stackOrder: number }> = [];
  for (const { track, clip, stackOrder: clipStackOrder } of visualPlan) {
      if (clip.adjustment) continue;
      if (clip.type === 'text' || clip.type === 'subtitle') {
        if (clip.textStyle?.text || clip.subtitle?.text) allTextClips.push({ clip, stackOrder: clipStackOrder });
        continue;
      }
  }
  for (const track of [...project.tracks].sort((left, right) => left.order - right.order)) {
    for (const clip of track.clips) {
      if (clip.adjustment || clip.type === 'text' || clip.type === 'subtitle' || !clip.assetId || numberOr(clip.duration, 0) <= 0) continue;
      const asset = project.assets.find((item) => item.id === clip.assetId);
      if (!asset) throw new Error(message('clipMediaMissing', { name: clip.name }));
      const file = assetFile(project.id, asset);
      if (!fs.existsSync(file)) throw new Error(message('mediaFileMissingNamed', { name: asset.name }));
      const visual = visualByClipId.get(clip.id);
      allTimelineClips.push({ clip, asset, trackMuted: track.muted, trackVolume: clamp(numberOr(track.volume, 1), 0, 2), stackOrder: visual?.stackOrder ?? -1, visualVisible: Boolean(visual) });
    }
  }
  if (!allTimelineClips.length && !allTextClips.length) throw new Error(message('timelineNeedsClip'));

  const fullDuration = Math.max(0.1, numberOr(project.duration, 0), ...allTimelineClips.map(({ clip }) => Math.max(0, numberOr(clip.start, 0)) + Math.max(0, numberOr(clip.duration, 0))), ...allTextClips.map(({ clip }) => Math.max(0, numberOr(clip.start, 0)) + Math.max(0, numberOr(clip.duration, 0))));
  if (body.range && (body.range.start >= fullDuration || body.range.end > fullDuration + 0.000001)) throw new Error(message('invalidExportRange'));
  const rangeStart = body.range?.start ?? 0;
  const rangeEnd = body.range?.end ?? fullDuration;
  const projectDuration = Math.max(0.1, rangeEnd - rangeStart);
  const clips = allTimelineClips
    .map((entry) => {
      const visible = visibleRenderClip(entry.clip, rangeStart, rangeEnd);
      if (!visible) return { ...entry, clip: null, adjustmentSegments: [] as AdjustmentRenderSegment[] };
      const visual = visualByClipId.get(entry.clip.id);
      const layers = visualPlan.filter(({ clip }) => clip.adjustment
        && numberOr(clip.start, 0) < numberOr(entry.clip.start, 0) + numberOr(entry.clip.duration, 0)
        && numberOr(clip.start, 0) + numberOr(clip.duration, 0) > numberOr(entry.clip.start, 0));
      const visibleEnd = visible.start + visible.duration;
      const boundaries = [
        visible.start,
        visibleEnd,
        ...layers.flatMap((layer) => [
          clamp(numberOr(layer.clip.start, 0) - rangeStart, visible.start, visibleEnd),
          clamp(numberOr(layer.clip.start, 0) + numberOr(layer.clip.duration, 0) - rangeStart, visible.start, visibleEnd),
        ]),
      ].sort((a, b) => a - b).filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 0.000001);
      const adjustmentSegments = boundaries.slice(0, -1).flatMap((start, index): AdjustmentRenderSegment[] => {
        const end = boundaries[index + 1];
        if (end <= start) return [];
        const midpoint = (start + end) / 2 + rangeStart;
        const activeLayers = visual ? adjustmentLayersForVisual(visualPlan, visual, midpoint).filter((layer) => layers.includes(layer)) : [];
        if (!activeLayers.length) return [];
        return [{ start: start - visible.start, end: end - visible.start, filters: mergeVisualFilters(EMPTY_FILTERS, activeLayers.map(({ clip }) => clip.filters)) }];
      });
      return { ...entry, clip: visible, adjustmentSegments };
    })
    .filter((entry): entry is { clip: TimelineClip; asset: Asset; trackMuted: boolean; trackVolume: number; stackOrder: number; visualVisible: boolean; adjustmentSegments: AdjustmentRenderSegment[] } => Boolean(entry.clip));
  const textClips = allTextClips
    .map((entry) => ({ ...entry, clip: visibleRenderClip(entry.clip, rangeStart, rangeEnd) }))
    .filter((entry): entry is { clip: TimelineClip; stackOrder: number } => Boolean(entry.clip));
  if (!clips.length && !textClips.length) throw new Error('Selected range does not contain media or text');
  const inputArgs: string[] = [];
  const videoClips: Array<{ clip: TimelineClip; asset: Asset; inputIndex: number; duration: number; stackOrder: number; adjustmentSegments: AdjustmentRenderSegment[] }> = [];
  const audioClips: Array<{ clip: TimelineClip; asset: Asset; inputIndex: number; duration: number; trackMuted: boolean; trackVolume: number }> = [];
  const filterLines: string[] = [];

  for (const entry of clips) {
    const { clip, asset, trackMuted, trackVolume, stackOrder: clipStackOrder, visualVisible, adjustmentSegments } = entry;
    const clipDuration = Math.max(0, numberOr(clip.duration, 0));
    if (clipDuration <= 0) continue;
    const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
    const isImage = asset.type === 'image' || clip.type === 'image';
    const wantsVideo = visualVisible && !audioOnly && (clip.type === 'video' || clip.type === 'image') && (asset.type === 'video' || asset.type === 'image');
    const wantsAudio = asset.hasAudio && (clip.type === 'video' || clip.type === 'audio') && !trackMuted;
    if (!wantsVideo && !wantsAudio) continue;

    const sourceStart = Math.max(0, numberOr(clip.sourceStart, 0));
    const requestedSourceDuration = Math.max(0.1, sourceTimeAt(clip.speedCurve, speed, clipDuration) + 0.1);
    const sourceDuration = asset.duration > 0
      ? Math.max(0.1, Math.min(requestedSourceDuration, Math.max(0.1, asset.duration - Math.min(sourceStart, Math.max(0, asset.duration - 0.1)))))
      : requestedSourceDuration;
    const inputPath = assetFile(project.id, asset);
    const inputIndex = inputArgs.filter((arg) => arg === '-i').length;
    if (isImage) inputArgs.push('-loop', '1', '-framerate', String(fps), '-i', inputPath);
    else inputArgs.push('-ss', ffmpegNumber(Math.min(sourceStart, Math.max(0, asset.duration - 0.05))), '-t', ffmpegNumber(sourceDuration), '-i', inputPath);

    if (wantsVideo) videoClips.push({ clip, asset, inputIndex, duration: clipDuration, stackOrder: clipStackOrder, adjustmentSegments });
    if (wantsAudio) audioClips.push({ clip, asset, inputIndex, duration: clipDuration, trackMuted, trackVolume });
  }

  if (!audioOnly) {
    const baseDuration = ffmpegNumber(projectDuration);
    filterLines.push(`color=c=${ffmpegColor(project.canvas.background)}:s=${outWidth}x${outHeight}:r=${ffmpegNumber(fps)}:d=${baseDuration}[base]`);
    let current = '[base]';
    let nextTextIndex = 0;
    const appendTextClip = ({ clip }: { clip: TimelineClip; stackOrder: number }, index: number) => {
      const style = clip.textStyle ?? { text: clip.subtitle?.text ?? clip.name, fontFamily: 'Arial', fontSize: 42, fontWeight: 700, fontStyle: 'normal', textDecoration: 'none', letterSpacing: 0, lineHeight: 1.2, padding: 4, color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' as const };
      const transform = clip.transform;
      const lines = normalizeTextLineBreaks(style.text).split('\n');
      const baseFontSize = numberOr(style.fontSize, 42);
      const fontSize = Math.max(8, Math.round(baseFontSize * outputScaleY));
      const paddingX = Math.max(0, numberOr(style.padding, 0) * outputScaleX);
      const paddingY = Math.max(0, numberOr(style.padding, 0) * outputScaleY);
      const longestLine = Math.max(1, ...lines.map((line) => line.length));
      const baseTextWidth = longestLine * baseFontSize * 0.58;
      const spacedTextWidth = Math.max(baseFontSize * 0.2, baseTextWidth + Math.max(0, longestLine - 1) * numberOr(style.letterSpacing, 0));
      const letterSpacingScale = clamp(spacedTextWidth / Math.max(1, baseTextWidth), 0.2, 4);
      // Browser font metrics are consistently a little wider than FFmpeg's
      // Windows drawtext rasterization, even when both resolve to Arial. Keep
      // a small horizontal metric correction in the export contract so text
      // and its background occupy the same footprint as the canvas preview.
      const textWidthScale = letterSpacingScale * 1.1;
      const textGeometry = resolveTextFrameGeometry(style, project.canvas.width, project.canvas.height);
      // The later horizontal metric correction emulates browser glyph and
      // letter spacing. Compensate the transparent source box before applying
      // it so the final layer footprint remains the shared canvas geometry.
      const sourceWidth = Math.max(2, Math.ceil((textGeometry.width * outputScaleX) / textWidthScale / 2) * 2);
      const sourceHeight = Math.max(2, Math.ceil(textGeometry.height * outputScaleY / 2) * 2);
      const fontColor = ffmpegColor(style.color);
      const strokeColor = ffmpegColor(style.stroke);
      const duration = Math.max(0.001, numberOr(clip.duration, 0));
      const textEnter = clamp(numberOr(clip.transitionIn?.duration, 0), 0, clip.duration);
      const textLeave = clamp(numberOr(clip.transitionOut?.duration, 0), 0, clip.duration);
      const usesTextFadeIn = clip.transitionIn?.type !== 'none' && clip.transitionIn?.type !== 'slide' && clip.transitionIn?.type !== 'zoom' && textEnter > 0;
      const usesTextFadeOut = clip.transitionOut?.type !== 'none' && clip.transitionOut?.type !== 'slide' && clip.transitionOut?.type !== 'zoom' && textLeave > 0;
      const alphaExpressions: string[] = [keyframeExpression(clip, 'opacity', clamp(numberOr(transform.opacity, 1), 0, 1), 'T')];
      const fadeIn = clamp(numberOr(clip.fadeIn, 0), 0, clip.duration);
      const fadeOut = clamp(numberOr(clip.fadeOut, 0), 0, clip.duration);
      if (usesTextFadeIn) alphaExpressions.push(`if(lt(T,${ffmpegNumber(textEnter)}),T/${ffmpegNumber(textEnter)},1)`);
      else if (fadeIn > 0) alphaExpressions.push(`if(lt(T,${ffmpegNumber(fadeIn)}),T/${ffmpegNumber(fadeIn)},1)`);
      if (usesTextFadeOut) alphaExpressions.push(`if(gt(T,${ffmpegNumber(duration - textLeave)}),(${ffmpegNumber(duration)}-T)/${ffmpegNumber(textLeave)},1)`);
      else if (fadeOut > 0) alphaExpressions.push(`if(gt(T,${ffmpegNumber(duration - fadeOut)}),(${ffmpegNumber(duration)}-T)/${ffmpegNumber(fadeOut)},1)`);

      const source = `[textsrc${index}]`;
      const transformed = `[texttransform${index}]`;
      const textFilters: string[] = ['format=rgba'];
      if (style.background !== 'transparent') textFilters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${ffmpegColor(style.background)}:t=fill:replace=1`);
      lines.forEach((line, lineIndex) => {
        const alignX = style.align === 'left' ? ffmpegNumber(paddingX) : style.align === 'right' ? `w-text_w-${ffmpegNumber(paddingX)}` : '(w-text_w)/2';
        const lineHeight = fontSize * numberOr(style.lineHeight, 1.2);
        const lineTop = paddingY + lineIndex * lineHeight;
        const draw = [`drawtext=${ffmpegFontSource(style.fontFamily, style.fontWeight, style.fontStyle)}`, `text='${ffmpegText(line)}'`, `fontsize=${fontSize}`, `fontcolor=${fontColor}`, `x=${alignX}`, `y=${ffmpegNumber(lineTop)}+(${ffmpegNumber(lineHeight)}-text_h)/2`];
        if (numberOr(style.strokeWidth, 0) > 0 && style.stroke !== 'transparent') draw.push(`borderw=${ffmpegNumber(numberOr(style.strokeWidth, 0) * outputScaleY)}`, `bordercolor=${strokeColor}`);
        if (style.shadow) draw.push(`shadowx=${ffmpegNumber(2 * outputScaleX)}`, `shadowy=${ffmpegNumber(2 * outputScaleY)}`, 'shadowcolor=0x00000099');
        textFilters.push(draw.join(':'));
      });
      if (alphaExpressions.some((expression) => expression !== '1')) textFilters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alphaExpressions.join('*')})'`);
      if (clip.transitionIn?.type === 'wipe') textFilters.push(wipeAlphaFilter(clip.transitionIn, duration, true));
      if (clip.transitionOut?.type === 'wipe') textFilters.push(wipeAlphaFilter(clip.transitionOut, duration, false));
      if (Math.abs(textWidthScale - 1) > 0.0001) textFilters.push(`scale=ceil(iw*${ffmpegNumber(textWidthScale)}/2)*2:ih`);
      const baseScale = Math.max(0.05, numberOr(transform.scale, 1));
      const scaleExpression = keyframeExpression(clip, 'scale', baseScale);
      const transitionScale = transitionScaleExpression(clip, duration);
      const hasScaleKeyframes = clip.keyframes.some((keyframe) => keyframe.property === 'scale');
      if (hasScaleKeyframes || transitionScale !== '1') {
        const maximumKeyframeScale = Math.max(baseScale, ...clip.keyframes.filter((keyframe) => keyframe.property === 'scale').map((keyframe) => Math.max(0.05, keyframe.value)));
        const maximumTransitionScale = clip.transitionOut?.type === 'zoom'
          ? 1 + 0.18 * clamp(numberOr(clip.transitionOut.intensity, 1), 0.1, 2)
          : 1;
        const maximumScale = maximumKeyframeScale * maximumTransitionScale;
        const paddedWidth = Math.max(2, Math.ceil(sourceWidth * textWidthScale * maximumScale / 2) * 2 + 8);
        const paddedHeight = Math.max(2, Math.ceil(sourceHeight * maximumScale / 2) * 2 + 8);
        textFilters.push(`scale=w=ceil(iw*(${ffmpegExpression(scaleExpression)})*(${ffmpegExpression(transitionScale)})/2)*2:h=ceil(ih*(${ffmpegExpression(scaleExpression)})*(${ffmpegExpression(transitionScale)})/2)*2:eval=frame`);
        textFilters.push('format=rgba', `pad=${paddedWidth}:${paddedHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000:eval=frame`);
      } else if (Math.abs(baseScale - 1) > 0.0001) {
        textFilters.push(`scale=ceil(iw*${ffmpegNumber(baseScale)}/2)*2:ceil(ih*${ffmpegNumber(baseScale)}/2)*2`);
      }
      const rotationExpression = keyframeExpression(clip, 'rotation', numberOr(transform.rotation, 0));
      if (clip.keyframes.some((keyframe) => keyframe.property === 'rotation') || Math.abs(numberOr(transform.rotation, 0)) > 0.001) {
        textFilters.push(`rotate=(${ffmpegExpression(rotationExpression)})*PI/180:ow='hypot(iw,ih)':oh='hypot(iw,ih)':fillcolor=none`);
      }
      textFilters.push(`setpts=PTS-STARTPTS+${ffmpegNumber(Math.max(0, numberOr(clip.start, 0)))}/TB`);
      filterLines.push(`color=c=black@0:s=${sourceWidth}x${sourceHeight}:r=${ffmpegNumber(fps)}:d=${ffmpegNumber(duration)}${source}`);
      filterLines.push(`${source}${textFilters.join(',')}${transformed}`);

      const overlayLocalTime = `(t-${ffmpegNumber(clip.start)})`;
      const x = keyframeExpression(clip, 'x', numberOr(transform.x, 0), overlayLocalTime);
      const y = keyframeExpression(clip, 'y', numberOr(transform.y, 0), overlayLocalTime);
      const transitionX = [clip.transitionIn, clip.transitionOut].map((transition, transitionIndex) => transition ? transitionOffsetExpression(transition, duration, transitionIndex === 0, 'x', overlayLocalTime) : '0').filter((expression) => expression !== '0').join('+') || '0';
      const transitionY = [clip.transitionIn, clip.transitionOut].map((transition, transitionIndex) => transition ? transitionOffsetExpression(transition, duration, transitionIndex === 0, 'y', overlayLocalTime) : '0').filter((expression) => expression !== '0').join('+') || '0';
      const next = `[text${index}]`;
      filterLines.push(`${current}${transformed}overlay=x=(main_w-overlay_w)/2+(${ffmpegExpression(x)}+${ffmpegExpression(transitionX)})*${ffmpegNumber(outputScaleX)}:y=(main_h-overlay_h)/2+(${ffmpegExpression(y)}+${ffmpegExpression(transitionY)})*${ffmpegNumber(outputScaleY)}:eof_action=pass:shortest=0:format=auto${next}`);
      current = next;
    };
    videoClips.forEach(({ clip, inputIndex, duration, stackOrder: clipStackOrder, adjustmentSegments }, index) => {
      const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
      const transform = clip.transform;
      const segments = speedCurveSegments(duration, speed, clip.speedCurve);
      const sourceLabels = segments.map((_, segmentIndex) => `[vsrc${index}_${segmentIndex}]`);
      if (segments.length > 1) {
        filterLines.push(`[${inputIndex}:v]split=${segments.length}${segments.map((_, segmentIndex) => `[vbranch${index}_${segmentIndex}]`).join('')}`);
      }
      const renderedSegments: string[] = [];
      segments.forEach((segment, segmentIndex) => {
        const source = segments.length > 1 ? `[vbranch${index}_${segmentIndex}]` : `[${inputIndex}:v]`;
        const segmentFilters = [`trim=start=${ffmpegNumber(segment.sourceTime)}:duration=${ffmpegNumber(segment.sourceDuration)}`, 'setpts=PTS-STARTPTS'];
        if (Math.abs(segment.speed - 1) > 0.0001) segmentFilters.push(`setpts=PTS/${ffmpegNumber(segment.speed)}`);
        segmentFilters.push(`trim=duration=${ffmpegNumber(segment.duration)}`, 'setpts=PTS-STARTPTS');
        const label = sourceLabels[segmentIndex];
        filterLines.push(`${source}${segmentFilters.join(',')}${label}`);
        renderedSegments.push(label);
      });
      const timedVideo = `[vtimed${index}]`;
      if (renderedSegments.length > 1) filterLines.push(`${renderedSegments.join('')}concat=n=${renderedSegments.length}:v=1:a=0,setpts=PTS-STARTPTS${timedVideo}`);
      else filterLines.push(`${renderedSegments[0]}setpts=PTS-STARTPTS${timedVideo}`);
      const filters: string[] = [];
      if (clip.crop) {
        const crop = normalizeCrop(clip.crop);
        filters.push(`crop=iw*${ffmpegNumber(crop.width)}:ih*${ffmpegNumber(crop.height)}:iw*${ffmpegNumber(crop.x)}:ih*${ffmpegNumber(crop.y)}`);
      }
      const fit = effectiveVisualFit(project.canvas.fitMode, transform.fit);
      if (fit === 'cover') filters.push(`scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase`, `crop=${outWidth}:${outHeight}`);
      else if (fit === 'stretch') filters.push(`scale=${outWidth}:${outHeight}`);
      else filters.push(`scale=${outWidth}:${outHeight}:force_original_aspect_ratio=decrease`);
      const scale = Math.max(0.05, numberOr(transform.scale, 1));
      const scaleExpression = keyframeExpression(clip, 'scale', scale);
      const hasScaleKeyframes = clip.keyframes.some((keyframe) => keyframe.property === 'scale');
      const transitionScale = transitionScaleExpression(clip, duration);
      if (transform.flipX) filters.push('hflip');
      if (transform.flipY) filters.push('vflip');
      appendColorFilters(filters, clip.filters);
      for (const segment of adjustmentSegments) appendColorFilters(filters, segment.filters, segment);
      const opacity = Math.max(0, Math.min(1, numberOr(transform.opacity, 1)));
      const opacityExpression = keyframeExpression(clip, 'opacity', opacity, 'T');
      const alphaExpressions = [opacityExpression];
      const fadeIn = clamp(numberOr(clip.fadeIn, 0), 0, duration);
      const fadeOut = clamp(numberOr(clip.fadeOut, 0), 0, duration);
      const transitionInProgress = clip.transitionIn ? transitionProgressExpression(clip.transitionIn, duration, true, 'T') : null;
      const transitionOutProgress = clip.transitionOut ? transitionProgressExpression(clip.transitionOut, duration, false, 'T') : null;
      if (transitionInProgress && (clip.transitionIn?.type === 'fade' || clip.transitionIn?.type === 'dissolve')) alphaExpressions.push(transitionInProgress);
      else if (fadeIn > 0) alphaExpressions.push(`if(lt(T,${ffmpegNumber(fadeIn)}),T/${ffmpegNumber(fadeIn)},1)`);
      if (transitionOutProgress && (clip.transitionOut?.type === 'fade' || clip.transitionOut?.type === 'dissolve')) alphaExpressions.push(transitionOutProgress);
      else if (fadeOut > 0) alphaExpressions.push(`if(gt(T,${ffmpegNumber(Math.max(0, duration - fadeOut))}),(${ffmpegNumber(duration)}-T)/${ffmpegNumber(fadeOut)},1)`);
      if (alphaExpressions.some((expression) => expression !== '1')) filters.push(`format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alphaExpressions.join('*')})'`);
      if (clip.transitionIn?.type === 'wipe') filters.push(wipeAlphaFilter(clip.transitionIn, duration, true));
      if (clip.transitionOut?.type === 'wipe') filters.push(wipeAlphaFilter(clip.transitionOut, duration, false));
      if (clip.mask) filters.push(maskFilter(clip.mask));
      if (hasScaleKeyframes || transitionScale !== '1') {
        // Dynamic frame dimensions are negotiated from the first frame by
        // several FFmpeg filters. Without a fixed transparent envelope, a
        // scale animation that starts at 0.68 can stay visually stuck at 0.68
        // even while the scale expression advances. Pad every scaled frame to
        // a stable maximum footprint so downstream rotate/overlay filters see
        // one stream size while the visible content continues to animate.
        const maximumKeyframeScale = Math.max(scale, ...clip.keyframes.filter((keyframe) => keyframe.property === 'scale').map((keyframe) => Math.max(0.05, keyframe.value)));
        const maximumTransitionScale = clip.transitionOut?.type === 'zoom'
          ? 1 + 0.18 * clamp(numberOr(clip.transitionOut.intensity, 1), 0.1, 2)
          : 1;
        const maximumScale = maximumKeyframeScale * maximumTransitionScale;
        const paddedWidth = Math.max(2, Math.ceil(outWidth * maximumScale / 2) * 2);
        const paddedHeight = Math.max(2, Math.ceil(outHeight * maximumScale / 2) * 2);
        filters.push(`scale=w=ceil(iw*(${ffmpegExpression(scaleExpression)})*(${ffmpegExpression(transitionScale)})/2)*2:h=ceil(ih*(${ffmpegExpression(scaleExpression)})*(${ffmpegExpression(transitionScale)})/2)*2:eval=frame`);
        filters.push('format=rgba', `pad=${paddedWidth}:${paddedHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000:eval=frame`);
      } else if (Math.abs(scale - 1) > 0.0001) {
        filters.push(`scale=ceil(iw*${ffmpegNumber(scale)}/2)*2:ceil(ih*${ffmpegNumber(scale)}/2)*2`);
      }
      const rotation = numberOr(transform.rotation, 0);
      const rotationExpression = keyframeExpression(clip, 'rotation', rotation);
      if (clip.keyframes.some((keyframe) => keyframe.property === 'rotation')) filters.push(`rotate=(${ffmpegExpression(rotationExpression)})*PI/180:fillcolor=none`);
      else if (Math.abs(rotation) > 0.001) filters.push(`rotate=${ffmpegNumber(rotation * Math.PI / 180)}:fillcolor=none`);
      filters.push(`setpts=PTS-STARTPTS+${ffmpegNumber(Math.max(0, numberOr(clip.start, 0)))}/TB`);
      const label = `[v${index}]`;
      filterLines.push(`${timedVideo}${filters.length ? filters.join(',') : 'null'}${label}`);
      while (nextTextIndex < textClips.length && textClips[nextTextIndex].stackOrder < clipStackOrder) {
        appendTextClip(textClips[nextTextIndex], nextTextIndex);
        nextTextIndex += 1;
      }
      // Overlay expressions run on the main timeline clock, while the media
      // branch above runs clip-local. Convert the clock before evaluating
      // position keyframes and slide transitions.
      const overlayLocalTime = `(t-${ffmpegNumber(clip.start)})`;
      const x = keyframeExpression(clip, 'x', numberOr(transform.x, 0), overlayLocalTime);
      const y = keyframeExpression(clip, 'y', numberOr(transform.y, 0), overlayLocalTime);
      const transitionX = [clip.transitionIn, clip.transitionOut].map((transition, transitionIndex) => transition ? transitionOffsetExpression(transition, duration, transitionIndex === 0, 'x', overlayLocalTime) : '0').filter((expression) => expression !== '0').join('+') || '0';
      const transitionY = [clip.transitionIn, clip.transitionOut].map((transition, transitionIndex) => transition ? transitionOffsetExpression(transition, duration, transitionIndex === 0, 'y', overlayLocalTime) : '0').filter((expression) => expression !== '0').join('+') || '0';
      const next = `[comp${index}]`;
      filterLines.push(`${current}${label}overlay=x=(main_w-overlay_w)/2+(${ffmpegExpression(x)}+${ffmpegExpression(transitionX)})*${ffmpegNumber(outputScaleX)}:y=(main_h-overlay_h)/2+(${ffmpegExpression(y)}+${ffmpegExpression(transitionY)})*${ffmpegNumber(outputScaleY)}:eof_action=pass:shortest=0:format=auto${next}`);
      current = next;
    });
    while (nextTextIndex < textClips.length) {
      appendTextClip(textClips[nextTextIndex], nextTextIndex);
      nextTextIndex += 1;
    }
    // The output always has a video stream, even when a project currently only
    // contains audio.  This makes the export action useful while a user is
    // assembling a timeline and avoids FFmpeg's "Output file is empty" error.
    filterLines.push(`${current}format=yuv420p[vout]`);
  }

  if (!request.frameOnly) {
    const audioLabels: string[] = [];
    audioClips.forEach(({ clip, inputIndex, duration, trackVolume }, index) => {
      const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
      const segments = speedCurveSegments(duration, speed, clip.speedCurve);
      const sourceLabels = segments.map((_, segmentIndex) => `[asrc${index}_${segmentIndex}]`);
      if (segments.length > 1) filterLines.push(`[${inputIndex}:a]asplit=${segments.length}${segments.map((_, segmentIndex) => `[abranch${index}_${segmentIndex}]`).join('')}`);
      const renderedSegments: string[] = [];
      segments.forEach((segment, segmentIndex) => {
        const source = segments.length > 1 ? `[abranch${index}_${segmentIndex}]` : `[${inputIndex}:a]`;
        const segmentFilters = [`atrim=start=${ffmpegNumber(segment.sourceTime)}:duration=${ffmpegNumber(segment.sourceDuration)}`, 'asetpts=PTS-STARTPTS', ...atempoChain(segment.speed), `atrim=duration=${ffmpegNumber(segment.duration)}`, 'asetpts=PTS-STARTPTS'];
        const label = sourceLabels[segmentIndex];
        filterLines.push(`${source}${segmentFilters.join(',')}${label}`);
        renderedSegments.push(label);
      });
      const timedAudio = `[atimed${index}]`;
      if (renderedSegments.length > 1) filterLines.push(`${renderedSegments.join('')}concat=n=${renderedSegments.length}:v=0:a=1,asetpts=PTS-STARTPTS${timedAudio}`);
      else filterLines.push(`${renderedSegments[0]}asetpts=PTS-STARTPTS${timedAudio}`);
      const filters: string[] = [];
      const clipVolume = Math.max(0, Math.min(2, numberOr(clip.volume, 1)));
      const volumeExpression = `(${keyframeExpression(clip, 'volume', clipVolume)})*${ffmpegNumber(clamp(trackVolume, 0, 2))}`;
      if (volumeExpression !== '1') filters.push(`volume=${ffmpegExpression(volumeExpression)}`);
      const fadeIn = clamp(numberOr(clip.fadeIn, 0), 0, duration);
      const fadeOut = clamp(numberOr(clip.fadeOut, 0), 0, duration);
      if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${ffmpegNumber(fadeIn)}`);
      if (fadeOut > 0) filters.push(`afade=t=out:st=${ffmpegNumber(Math.max(0, duration - fadeOut))}:d=${ffmpegNumber(fadeOut)}`);
      if (clip.normalize) filters.push('dynaudnorm=f=150:g=15');
      const delay = Math.max(0, Math.round(numberOr(clip.start, 0) * 1000));
      if (delay > 0) filters.push(`adelay=${delay}:all=1`);
      const label = `[a${index}]`;
      filterLines.push(`${timedAudio}${filters.length ? filters.join(',') : 'anull'}${label}`);
      audioLabels.push(label);
    });
    if (audioLabels.length) filterLines.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,aresample=48000:async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo,alimiter=limit=0.95:attack=5:release=50[aout]`);
    else filterLines.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${ffmpegNumber(projectDuration)}[aout]`);
  }

  const args = [...inputArgs, '-filter_complex', filterLines.join(';')];
  const outputFormat = body.format;
  if (request.frameOnly) {
    args.push('-map', '[vout]', '-frames:v', '1', '-c:v', 'png', '-f', 'image2');
  } else if (audioOnly) {
    args.push('-map', '[aout]', '-vn', '-t', ffmpegNumber(projectDuration), '-ar', '48000', '-ac', '2');
    if (outputFormat === 'wav') args.push('-c:a', 'pcm_s16le');
    else args.push('-c:a', 'libmp3lame', '-b:a', `${body.audioBitrateKbps}k`);
  } else {
    const quality = body.quality === 'draft'
      ? { preset: 'veryfast', crf: 28 }
      : body.quality === 'high'
        ? { preset: 'slow', crf: 18 }
        : { preset: 'medium', crf: 23 };
    args.push('-map', '[vout]', '-map', '[aout]', '-t', ffmpegNumber(projectDuration), '-r', ffmpegNumber(fps), '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', quality.preset);
    if (body.rateMode === 'bitrate' && body.videoBitrateKbps) args.push('-b:v', `${body.videoBitrateKbps}k`);
    else args.push('-crf', String(body.crf ?? quality.crf));
    args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', `${body.audioBitrateKbps}k`, '-movflags', '+faststart');
  }
  args.push(output);
  return { args, duration: projectDuration, audioOnly, outputFormat };
}

function estimateExportBytes(options: ExportOptions, duration: number) {
  if (options.format === 'wav') return Math.ceil(duration * 48000 * 2 * 2);
  if (options.format === 'mp3') return Math.ceil(duration * options.audioBitrateKbps * 1000 / 8);
  const videoKbps = options.rateMode === 'bitrate' && options.videoBitrateKbps
    ? options.videoBitrateKbps
    : options.quality === 'high' ? 12000 : options.quality === 'draft' ? 3500 : 7000;
  return Math.ceil(duration * (videoKbps + options.audioBitrateKbps) * 1000 / 8);
}

async function exportPreflight(project: Project, options: ExportOptions, exportDir: string) {
  const errors: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string; severity?: 'info' | 'warning'; clipIds?: string[]; properties?: string[] }> = [];
  const ffmpeg = binaryPath('ffmpeg');
  if (!ffmpeg) errors.push({ code: 'FFMPEG_MISSING', message: message('preflightFfmpegMissing') });
  try {
    const browserVideo = options.format === 'mp4';
    const preflightExtension = browserVideo || options.format === 'wav' ? 'wav' : 'mp3';
    const preflightOutput = path.join(exportDir, `.preflight-${crypto.randomUUID()}.${preflightExtension}`);
    const render = compileComposition(project, browserVideo ? { ...options, format: 'wav', audioOnly: true } : options, preflightOutput);
    const estimatedBytes = estimateExportBytes(options, render.duration);
    try {
      const stat = fs.statfsSync(exportDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes < estimatedBytes * 1.2) errors.push({ code: 'DISK_SPACE', message: message('preflightDiskSpace') });
      else if (freeBytes < estimatedBytes * 2) warnings.push({ code: 'DISK_SPACE_LOW', message: message('preflightDiskLow') });
    } catch {
      warnings.push({ code: 'DISK_SPACE_UNKNOWN', message: message('preflightDiskUnknown') });
    }
    if (options.fps !== nearestExportFps(project.canvas.fps, project.canvas.fps)) warnings.push({ code: 'FPS_CONVERT', message: message('preflightFpsConvert', { fps: options.fps }) });
    if (options.resolution === '4K') warnings.push({ code: 'LARGE_OUTPUT', message: message('preflightLargeOutput') });
    if (ffmpeg && errors.length === 0) {
      try {
        const probeArgs = [...render.args.slice(0, -1), '-t', ffmpegNumber(Math.min(0.08, render.duration)), preflightOutput];
        await runFfmpegStandalone(probeArgs, preflightOutput);
      } catch (error) {
        errors.push({ code: 'FFMPEG_GRAPH_INVALID', message: error instanceof Error ? error.message : message('preflightInvalidTimeline') });
      } finally {
        await fsp.rm(preflightOutput, { force: true }).catch(() => undefined);
      }
    }
    const approximateTextClips = browserVideo ? [] : project.tracks.flatMap((track) => track.clips).filter((clip) => clip.textStyle && (Math.abs(clip.transform.rotation) > 0.001 || clip.textStyle.letterSpacing !== 0 || clip.textStyle.textDecoration !== 'none'));
    if (approximateTextClips.length) {
      const properties = Array.from(new Set(approximateTextClips.flatMap((clip) => [
        ...(Math.abs(clip.transform.rotation) > 0.001 ? ['rotation'] : []),
        ...(clip.textStyle?.letterSpacing !== 0 ? ['letterSpacing'] : []),
        ...(clip.textStyle?.textDecoration !== 'none' ? ['textDecoration'] : []),
      ])));
      warnings.push({ code: 'TEXT_RENDER_APPROXIMATION', message: message('preflightTextLimit'), severity: 'warning', clipIds: approximateTextClips.map((clip) => clip.id), properties });
    }
    return { ok: errors.length === 0, errors, warnings, estimatedBytes };
  } catch (error) {
    errors.push({ code: 'INVALID_TIMELINE', message: error instanceof Error ? error.message : message('preflightInvalidTimeline') });
    return { ok: false, errors, warnings };
  }
}

async function listProjects() {
  await ensureDir(projectsDir);
  const names = await fsp.readdir(projectsDir, { withFileTypes: true });
  const result: Array<Pick<Project, 'id' | 'name' | 'updatedAt' | 'createdAt' | 'duration' | 'canvas' | 'assets'> & { sizeBytes: number }> = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await readProject(entry.name);
      const sizeBytes = await directorySize(projectPath(project.id));
      result.push({ id: project.id, name: project.name, updatedAt: project.updatedAt, createdAt: project.createdAt, duration: project.duration, canvas: project.canvas, assets: project.assets, sizeBytes });
    } catch { /* skip corrupt projects in list; opening exposes recovery state later */ }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function trashPath(trashId: string) {
  if (!/^[A-Za-z0-9_-]+-\d+$/.test(trashId)) throw Object.assign(new Error(message('invalidTrashId')), { statusCode: 400 });
  return safeJoin(path.join(dataDir, 'trash'), trashId);
}

function trashDeletionTime(trashId: string) {
  const timestamp = Number(trashId.match(/-(\d+)$/)?.[1]);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function listTrash() {
  const trashDir = path.join(dataDir, 'trash');
  if (!fs.existsSync(trashDir)) return [];
  const entries = await fsp.readdir(trashDir, { withFileTypes: true });
  const result: Array<{ trashId: string; projectId: string; name: string; createdAt: string; updatedAt: string; deletedAt: string; expiresAt: string; duration: number; assetCount: number; sizeBytes: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+-\d+$/.test(entry.name)) continue;
    try {
      const deletedTime = trashDeletionTime(entry.name);
      const expiresTime = deletedTime + trashRetentionMs;
      const itemPath = trashPath(entry.name);
      if (expiresTime <= Date.now()) {
        await fsp.rm(itemPath, { recursive: true, force: true });
        continue;
      }
      const project = ProjectSchema.parse(JSON.parse(await fsp.readFile(path.join(itemPath, 'project.json'), 'utf8')));
      const sizeBytes = await directorySize(itemPath);
      result.push({ trashId: entry.name, projectId: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, deletedAt: new Date(deletedTime).toISOString(), expiresAt: new Date(expiresTime).toISOString(), duration: project.duration, assetCount: project.assets.length, sizeBytes });
    } catch { /* skip incomplete/corrupt trash entries */ }
  }
  return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function listBackups(projectId: string) {
  const backupDir = safeJoin(projectPath(projectId), 'backups');
  if (!fs.existsSync(backupDir)) return [];
  const entries = await fsp.readdir(backupDir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^project-\d+\.json$/i.test(entry.name)) continue;
    const file = safeJoin(backupDir, entry.name);
    const stat = await fsp.stat(file);
    result.push({ fileName: entry.name, createdAt: stat.mtime.toISOString(), size: stat.size });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type UploadedMediaType = 'image' | 'audio' | 'video';
type MediaExtensionInfo = { type: UploadedMediaType; mimeType: string; storedExtension: string };

const mediaExtensionInfo: Record<string, MediaExtensionInfo> = {
  '.png': { type: 'image', mimeType: 'image/png', storedExtension: '.png' },
  '.jpg': { type: 'image', mimeType: 'image/jpeg', storedExtension: '.jpg' },
  '.jpeg': { type: 'image', mimeType: 'image/jpeg', storedExtension: '.jpg' },
  '.gif': { type: 'image', mimeType: 'image/gif', storedExtension: '.gif' },
  '.webp': { type: 'image', mimeType: 'image/webp', storedExtension: '.webp' },
  '.bmp': { type: 'image', mimeType: 'image/bmp', storedExtension: '.bmp' },
  '.tif': { type: 'image', mimeType: 'image/tiff', storedExtension: '.tif' },
  '.tiff': { type: 'image', mimeType: 'image/tiff', storedExtension: '.tif' },
  '.mp3': { type: 'audio', mimeType: 'audio/mpeg', storedExtension: '.mp3' },
  '.wav': { type: 'audio', mimeType: 'audio/wav', storedExtension: '.wav' },
  '.m4a': { type: 'audio', mimeType: 'audio/mp4', storedExtension: '.m4a' },
  '.aac': { type: 'audio', mimeType: 'audio/aac', storedExtension: '.aac' },
  '.ogg': { type: 'audio', mimeType: 'audio/ogg', storedExtension: '.ogg' },
  '.oga': { type: 'audio', mimeType: 'audio/ogg', storedExtension: '.oga' },
  '.flac': { type: 'audio', mimeType: 'audio/flac', storedExtension: '.flac' },
  '.opus': { type: 'audio', mimeType: 'audio/ogg', storedExtension: '.opus' },
  '.mp4': { type: 'video', mimeType: 'video/mp4', storedExtension: '.mp4' },
  '.webm': { type: 'video', mimeType: 'video/webm', storedExtension: '.webm' },
  '.mov': { type: 'video', mimeType: 'video/quicktime', storedExtension: '.mov' },
  '.mkv': { type: 'video', mimeType: 'video/x-matroska', storedExtension: '.mkv' },
  '.avi': { type: 'video', mimeType: 'video/x-msvideo', storedExtension: '.avi' },
  '.m4v': { type: 'video', mimeType: 'video/x-m4v', storedExtension: '.m4v' },
};

const imageProbeFormats = new Set(['png_pipe', 'jpeg_pipe', 'gif', 'webp_pipe', 'bmp_pipe', 'tiff', 'image2', 'image2pipe']);
const containerProbeFormats = new Set(['wav', 'mp3', 'mp4', 'mov', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'ogg', 'oga', 'flac', 'aac', 'image2']);
const expectedProbeFormats: Record<string, readonly string[]> = {
  '.png': ['png_pipe'], '.jpg': ['jpeg_pipe'], '.jpeg': ['jpeg_pipe'], '.gif': ['gif'], '.webp': ['webp_pipe'], '.bmp': ['bmp_pipe'], '.tif': ['tiff'], '.tiff': ['tiff'],
  '.mp3': ['mp3'], '.wav': ['wav'], '.m4a': ['m4a', 'mov', 'mp4'], '.aac': ['aac'], '.ogg': ['ogg'], '.oga': ['ogg', 'oga'], '.flac': ['flac'], '.opus': ['ogg', 'opus'],
  '.mp4': ['mp4', 'mov'], '.m4v': ['m4v', 'mov', 'mp4'], '.mov': ['mov', 'mp4'], '.mkv': ['matroska', 'webm'], '.webm': ['webm', 'matroska'], '.avi': ['avi'],
};

function matchesExpectedMediaFormat(extension: string, probed: Record<string, unknown>) {
  const formats = String(probed.formatName ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return expectedProbeFormats[extension]?.some((format) => formats.includes(format)) ?? false;
}

function detectedMediaType(probed: Record<string, unknown>): UploadedMediaType | undefined {
  const formats = String(probed.formatName ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (formats.some((format) => imageProbeFormats.has(format))) return 'image';
  if (!formats.some((format) => containerProbeFormats.has(format))) return undefined;
  if (probed.hasVideo === true) return 'video';
  if (probed.hasAudio === true) return 'audio';
  return undefined;
}

function ffmpegExpression(value: string) {
  return value.replaceAll(',', '\\,');
}

function easingExpression(value: string, easing: string | undefined) {
  if (easing === 'ease-in') return `(${value})*(${value})`;
  if (easing === 'ease-out') return `1-(1-(${value}))*(1-(${value}))`;
  if (easing === 'ease-in-out') return `if(lt(${value},0.5),2*(${value})*(${value}),1-((-2*(${value})+2)*(-2*(${value})+2))/2)`;
  return value;
}

/** Translate the shared keyframe interpolation contract to FFmpeg's frame expression syntax. */
function keyframeExpression(clip: TimelineClip, property: TimelineClip['keyframes'][number]['property'], fallback: number, timeExpression = 't') {
  const points = clip.keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
  if (!points.length) return ffmpegNumber(fallback);
  // Each media branch is reset to PTS-STARTPTS before this expression runs,
  // so FFmpeg's `t` is already clip-local.  Subtracting the timeline start
  // here made keyframes on clips away from 0 fire too early or never fire.
  const localTime = `(${timeExpression})`;
  let expression = ffmpegNumber(points.at(-1)?.value ?? fallback);
  for (let index = points.length - 1; index > 0; index -= 1) {
    const previous = points[index - 1];
    const next = points[index];
    const progress = `(${localTime}-${ffmpegNumber(previous.time)})/${ffmpegNumber(Math.max(0.000001, next.time - previous.time))}`;
    const eased = easingExpression(progress, next.easing);
    const value = `${ffmpegNumber(previous.value)}+(${ffmpegNumber(next.value)}-${ffmpegNumber(previous.value)})*(${eased})`;
    expression = `if(lt(${localTime},${ffmpegNumber(next.time)}),${value},${expression})`;
  }
  expression = `if(lt(${localTime},${ffmpegNumber(points[0].time)}),${ffmpegNumber(points[0].value)},${expression})`;
  return expression;
}

function transitionProgressExpression(transition: NonNullable<TimelineClip['transitionIn']>, duration: number, entering: boolean, timeExpression = 't') {
  const transitionDuration = clamp(numberOr(transition.duration, 0), 0, duration);
  if (transition.type === 'none' || transitionDuration <= 0) return null;
  const time = `(${timeExpression})`;
  const raw = entering
    ? `(${time}/${ffmpegNumber(transitionDuration)})`
    : `(((${ffmpegNumber(duration)})-${time})/${ffmpegNumber(transitionDuration)})`;
  return `if(${entering ? `lt(${time},${ffmpegNumber(transitionDuration)})` : `gt(${time},${ffmpegNumber(Math.max(0, duration - transitionDuration))})`},${easingExpression(raw, transition.easing)},1)`;
}

function transitionOffsetExpression(transition: NonNullable<TimelineClip['transitionIn']>, duration: number, entering: boolean, axis: 'x' | 'y', timeExpression = 't') {
  if (transition.type !== 'slide') return '0';
  const progress = transitionProgressExpression(transition, duration, entering, timeExpression);
  if (!progress) return '0';
  const direction = transition.direction ?? 'left';
  const vector = axis === 'x' ? direction === 'right' ? 1 : direction === 'left' ? -1 : 0 : direction === 'down' ? 1 : direction === 'up' ? -1 : 0;
  if (!vector) return '0';
  const distance = ffmpegNumber(120 * clamp(numberOr(transition.intensity, 1), 0.1, 2));
  return `${vector}*(1-(${progress}))*${distance}`;
}

function transitionScaleExpression(clip: TimelineClip, duration: number) {
  const enterAmount = 0.18 * clamp(numberOr(clip.transitionIn?.intensity, 1), 0.1, 2);
  const leaveAmount = 0.18 * clamp(numberOr(clip.transitionOut?.intensity, 1), 0.1, 2);
  const entering = clip.transitionIn?.type === 'zoom' ? transitionProgressExpression(clip.transitionIn, duration, true) : null;
  const leaving = clip.transitionOut?.type === 'zoom' ? transitionProgressExpression(clip.transitionOut, duration, false) : null;
  const parts = ['1'];
  if (entering) parts.push(`-(1-(${entering}))*${ffmpegNumber(enterAmount)}`);
  if (leaving) parts.push(`+(1-(${leaving}))*${ffmpegNumber(leaveAmount)}`);
  return parts.length === 1 ? '1' : parts.join('');
}

function wipeAlphaFilter(transition: NonNullable<TimelineClip['transitionIn']>, duration: number, entering: boolean) {
  const progress = transitionProgressExpression(transition, duration, entering, 'T') ?? '1';
  const direction = transition.direction ?? 'left';
  const visibility = direction === 'right'
    ? `gte(X/W,1-(${progress}))`
    : direction === 'up'
      ? `lte(Y/H,${progress})`
      : direction === 'down'
        ? `gte(Y/H,1-(${progress}))`
        : direction === 'center'
          ? `lte(sqrt((X/W-0.5)*(X/W-0.5)+(Y/H-0.5)*(Y/H-0.5)),(${progress})*0.7072)`
          : `lte(X/W,${progress})`;
  return `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${visibility},alpha(X,Y),0)'`;
}

function maskFilter(mask: NonNullable<TimelineClip['mask']>) {
  const left = ffmpegNumber(clamp(mask.x, 0, 1));
  const top = ffmpegNumber(clamp(mask.y, 0, 1));
  const right = ffmpegNumber(clamp(mask.x + mask.width, 0, 1));
  const bottom = ffmpegNumber(clamp(mask.y + mask.height, 0, 1));
  const inside = mask.type === 'ellipse'
    ? `(((X/W-${ffmpegNumber(mask.x + mask.width / 2)})/${ffmpegNumber(Math.max(0.01, mask.width / 2) )})^2+((Y/H-${ffmpegNumber(mask.y + mask.height / 2)})/${ffmpegNumber(Math.max(0.01, mask.height / 2))})^2<1)`
    : `between(X/W,${left},${right})*between(Y/H,${top},${bottom})`;
  const feather = clamp(numberOr(mask.feather, 0), 0, 1);
  if (feather <= 0.0001) {
    const condition = mask.invert ? `not(${inside})` : inside;
    return `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${condition},alpha(X,Y),0)'`;
  }
  // The browser SVG uses a Gaussian blur of `feather * 6` in a 100-unit
  // viewBox. Model the same narrow, symmetric edge here. Treating `feather`
  // as a full-frame percentage made a 0.1 mask fade across 10% of the image,
  // turning crisp preview shapes into much smaller blurry export blobs.
  const featherSize = ffmpegNumber(Math.max(0.0001, feather * 0.12));
  const softness = mask.type === 'ellipse'
    ? `clip(0.5+(1-sqrt(((X/W-${ffmpegNumber(mask.x + mask.width / 2)})/${ffmpegNumber(Math.max(0.01, mask.width / 2))})^2+((Y/H-${ffmpegNumber(mask.y + mask.height / 2)})/${ffmpegNumber(Math.max(0.01, mask.height / 2))})^2))/${featherSize},0,1)`
    : `clip(0.5+min(min(X/W-${left},${right}-X/W),min(Y/H-${top},${bottom}-Y/H))/${featherSize},0,1)`;
  const alpha = mask.invert ? `(1-(${softness}))` : softness;
  return `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${alpha}'`;
}

async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const ffmpeg = binaryPath('ffmpeg');
    const activity = runtimeActivity();
    return {
      ok: true,
      product: 'CutLoc',
      version: CUTLOC_VERSION,
      apiVersion: API_PROTOCOL_VERSION,
      port: runtimePort,
      ffmpeg: Boolean(ffmpeg),
      ffprobe: Boolean(binaryPath('ffprobe')),
      textRendering: ffmpegHasFilter(ffmpeg, 'drawtext'),
      dataDir: path.basename(dataDir),
      ...activity,
      busy: activity.activeJobs > 0 || activity.activeLeases > 0 || activity.activePreviews > 0,
    };
  });

  app.get('/api/settings', async () => settings);
  app.put<{ Body: Partial<Settings> & { openAiKey?: string; geminiKey?: string } }>('/api/settings', async (request, reply) => {
    try {
      return await saveSettings(request.body ?? {});
    } catch (error) {
      return reply.code(400).send({ error: localizedError(error, 'settingsInvalid') });
    }
  });

  app.get('/api/stock', async () => STOCK_MEDIA.map((item) => { const { id, name, description, mimeType, width, height } = localizedStock(item); return { id, name, description, mimeType, width, height }; }));
  app.get<{ Params: { stockId: string } }>('/api/stock/:stockId', async (request, reply) => {
    const item = STOCK_MEDIA.find((entry) => entry.id === request.params.stockId);
    if (!item) return reply.code(404).send({ error: message('stockNotFound') });
    const file = path.join(stockDir, item.fileName);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: message('stockFileNotFound') });
    const stat = await fsp.stat(file);
    return reply.header('Content-Type', item.mimeType).header('Content-Length', stat.size).send(fs.createReadStream(file));
  });

  app.get('/api/projects', async () => listProjects());
  app.get('/api/trash', async () => listTrash());

  app.post<{ Params: { trashId: string } }>('/api/trash/:trashId/restore', async (request, reply) => {
    try {
      const source = trashPath(request.params.trashId);
      const project = ProjectSchema.parse(JSON.parse(await fsp.readFile(safeJoin(source, 'project.json'), 'utf8')));
      const restored = await withProjectLock(project.id, async () => {
        const target = projectPath(project.id);
        if (fs.existsSync(target)) throw Object.assign(new Error(message('projectAlreadyExists')), { statusCode: 409 });
        await ensureDir(projectsDir);
        await fsp.rename(source, target);
        const previous = lifecycleFor(project.id);
        projectLifecycles.set(project.id, { state: 'active', generation: previous.generation + 1 });
        return project;
      }, { allowInactive: true });
      return reply.send(restored);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 404;
      return reply.code(statusCode === 400 || statusCode === 409 ? statusCode : 404).send({ error: localizedError(error, 'projectRestoreFailed') });
    }
  });

  app.delete<{ Params: { trashId: string } }>('/api/trash/:trashId', async (request, reply) => {
    try {
      const target = trashPath(request.params.trashId);
      if (!fs.existsSync(target)) return reply.code(404).send({ error: message('trashNotFound') });
      await fsp.rm(target, { recursive: true, force: false });
      return reply.send({ ok: true });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 400 ? 400 : 404).send({ error: localizedError(error, 'trashDeleteFailed') });
    }
  });

  app.post<{ Body: { name?: string; preset?: string; aspect?: Project['canvas']['aspect']; fps?: number; background?: string } }>('/api/projects', async (request, reply) => {
    const project = defaultProject(id('project'), request.body?.name?.trim() || message('newProject'));
    const defaultProjectFps = settings.defaultExport.fps;
    const presetCanvas = request.body?.preset === 'shorts' ? { width: 1080, height: 1920, aspect: '9:16' as const, fitMode: 'fill' as const, fps: defaultProjectFps, background: '#070B14' } : {};
    const aspectDimensions: Partial<Record<Project['canvas']['aspect'], { width: number; height: number }>> = {
      '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '1:1': { width: 1080, height: 1080 },
      '4:5': { width: 1080, height: 1350 }, '3:2': { width: 1620, height: 1080 }, '21:9': { width: 2560, height: 1080 },
    };
    const dimensions = request.body?.aspect ? aspectDimensions[request.body.aspect] : undefined;
    const configured = ProjectSchema.parse({
      ...project,
      canvas: {
        ...project.canvas,
        ...presetCanvas,
        ...(dimensions ? { ...dimensions, aspect: request.body!.aspect } : {}),
        ...{ fps: request.body?.fps ?? defaultProjectFps },
        ...(request.body?.background ? { background: request.body.background } : {}),
      },
    });
    await ensureProjectFolders(configured.id);
    await saveProject(configured);
    return reply.code(201).send(configured);
  });

  app.post<{ Params: { projectId: string }; Body: { stockId?: string } }>('/api/projects/:projectId/stock', async (request, reply) => {
    const item = STOCK_MEDIA.find((entry) => entry.id === request.body?.stockId);
    if (!item) return reply.code(400).send({ error: message('invalidStock') });
    try {
      const result = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        const source = path.join(stockDir, item.fileName);
        if (!fs.existsSync(source)) throw Object.assign(new Error(message('stockFileNotFound')), { statusCode: 404 });
        const assetId = id('asset');
        const relativePath = path.join('media', assetId + '.png');
        const target = safeJoin(projectPath(current.id), relativePath);
        await ensureDir(path.dirname(target));
        await fsp.copyFile(source, target);
        const stat = await fsp.stat(target);
        const asset: Asset = {
          id: assetId,
          name: localizedStock(item).name,
          type: 'image',
          mimeType: item.mimeType,
          path: relativePath,
          thumbnailPath: relativePath,
          size: stat.size,
          duration: 5,
          width: item.width,
          height: item.height,
          hasAudio: false,
          createdAt: new Date().toISOString(),
        };
        const updated = ProjectSchema.parse({ ...current, assets: [...current.assets, asset], updatedAt: new Date().toISOString(), revision: current.revision + 1, duration: projectDuration(current) });
        await saveProject(updated);
        return { asset, project: updated };
      }, requestProjectLockOptions(request));
      return reply.code(201).send(result);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 423 ? statusCode : 400).send({ error: localizedError(error, 'stockAddFailed') });
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    try { return await readProject(request.params.projectId); }
    catch (error) {
      const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      return reply.code(missing ? 404 : 500).send({ error: missing ? message('projectNotFound') : localizedError(error, 'projectReadFailed') });
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/access', async (request, reply) => {
    try {
      await readProject(request.params.projectId);
      const lease = activeAccessLease(request.params.projectId);
      return { lease: lease ? publicAccessLease(lease) : null };
    } catch (error) {
      const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      return reply.code(missing ? 404 : 500).send({ error: missing ? message('projectNotFound') : localizedError(error, 'projectReadFailed') });
    }
  });

  app.post<{
    Params: { projectId: string };
    Body: { ownerId?: string; ownerLabel?: string; client?: string; ttlMs?: number; force?: boolean };
  }>('/api/projects/:projectId/access', async (request, reply) => {
    try {
      const ownerId = String(request.body?.ownerId ?? '').trim().slice(0, 120);
      const ownerLabel = String(request.body?.ownerLabel ?? 'CutLoc CLI').trim().slice(0, 120);
      if (!ownerId || !ownerLabel || request.body?.client !== 'cli') return reply.code(400).send({ error: message('projectSaveFailed') });
      const result = await withProjectLock(request.params.projectId, async () => {
        await readProject(request.params.projectId);
        const current = activeAccessLease(request.params.projectId);
        if (current) {
          throw Object.assign(new Error(message('projectLocked', { owner: current.ownerLabel })), { statusCode: 423, code: 'PROJECT_LOCKED', lease: publicAccessLease(current) });
        }
        const ttlMs = Math.round(clamp(Number(request.body?.ttlMs) || 15_000, minAccessLeaseMs, maxAccessLeaseMs));
        const acquiredAt = new Date().toISOString();
        const lease: InternalProjectAccessLease = {
          projectId: request.params.projectId,
          ownerId,
          ownerLabel,
          client: 'cli',
          acquiredAt,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          token: crypto.randomBytes(32).toString('base64url'),
        };
        projectAccessLeases.set(request.params.projectId, lease);
        publish('project-access', { projectId: request.params.projectId, lease: publicAccessLease(lease) });
        return { lease: publicAccessLease(lease), token: lease.token };
      });
      return reply.send(result);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 404;
      const locked = error as { code?: string; lease?: ProjectAccessLease };
      if (statusCode === 423) return reply.code(423).send({ error: localizedError(error, 'projectSaveFailed'), code: locked.code, lease: locked.lease });
      return reply.code(404).send({ error: message('projectNotFound') });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: { ttlMs?: number } }>('/api/projects/:projectId/access', async (request, reply) => {
    const lease = activeAccessLease(request.params.projectId);
    const token = request.headers['x-cutloc-access-token'];
    if (!lease || token !== lease.token) return reply.code(404).send({ error: message('projectNotFound') });
    const ttlMs = Math.round(clamp(Number(request.body?.ttlMs) || 15_000, minAccessLeaseMs, maxAccessLeaseMs));
    lease.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    publish('project-access', { projectId: request.params.projectId, lease: publicAccessLease(lease) });
    return { lease: publicAccessLease(lease) };
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId/access', async (request, reply) => {
    const lease = activeAccessLease(request.params.projectId);
    const token = request.headers['x-cutloc-access-token'];
    if (!lease) return reply.send({ ok: true });
    if (token !== lease.token) return reply.code(423).send({ error: message('projectLocked', { owner: lease.ownerLabel }), code: 'PROJECT_LOCKED', lease: publicAccessLease(lease) });
    projectAccessLeases.delete(request.params.projectId);
    publish('project-access', { projectId: request.params.projectId, lease: null });
    return reply.send({ ok: true });
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/bundle', async (request, reply) => {
    let project: Project;
    try {
      project = await readProject(request.params.projectId);
    } catch (error) {
      const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      return reply.code(missing ? 404 : 500).send({ error: missing ? message('projectNotFound') : localizedError(error, 'projectReadFailed') });
    }
    try {
      const bundle = await createPortableBundle(project);
      return reply.header('Content-Type', 'application/zip').header('Content-Length', bundle.byteLength).header('Content-Disposition', `attachment; filename="${safeExportName(project, project.name, 'cutloc')}"`).send(Buffer.from(bundle));
    } catch (error) { return reply.code(400).send({ error: localizedError(error, 'bundleOpenFailed') }); }
  });

  app.post<{ Body: unknown }>('/api/projects/import', async (request, reply) => {
    try {
      const submitted = request.body;
      const imported = Buffer.isBuffer(submitted)
        ? parsePortableBundle(submitted)
        : { source: parseLegacyBundle(submitted), assetFiles: undefined };
      const project = await importProject(imported.source, imported.assetFiles);
      return reply.code(201).send(project);
    } catch (error) { return reply.code(400).send({ error: localizedError(error, 'bundleOpenFailed') }); }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/backups', async (request, reply) => {
    try {
      await readProject(request.params.projectId);
      return listBackups(request.params.projectId);
    } catch {
      return reply.code(404).send({ error: message('projectNotFound') });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { fileName?: string } }>('/api/projects/:projectId/restore', async (request, reply) => {
    const requestedFileName = String(request.body?.fileName ?? '');
    const fileName = path.basename(requestedFileName);
    if (!requestedFileName || fileName !== requestedFileName || !/^project-\d+\.json$/i.test(fileName)) return reply.code(400).send({ error: message('invalidBackup') });
    try {
      const restored = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        const backupPath = safeExistingPath(path.join(projectPath(request.params.projectId), 'backups'), fileName);
        if (!fs.existsSync(backupPath)) throw Object.assign(new Error(message('backupNotFound')), { statusCode: 404 });
        const backup = ProjectSchema.parse(JSON.parse(await fsp.readFile(backupPath, 'utf8')));
        if (backup.id !== current.id) throw Object.assign(new Error(message('backupWrongProject')), { statusCode: 400 });
        const next = ProjectSchema.parse({ ...backup, id: current.id, revision: current.revision + 1, updatedAt: new Date().toISOString() });
        await saveProject(next);
        return next;
      }, requestProjectLockOptions(request));
      return reply.send(restored);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 423 ? statusCode : 400).send({ error: localizedError(error, 'backupRestoreFailed') });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: Partial<Project> & { revision?: number } }>('/api/projects/:projectId', async (request, reply) => {
    try {
      const next = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        if (request.body.revision === undefined) throw Object.assign(new Error(message('revisionRequired')), { statusCode: 409, project: current });
        if (request.body.revision !== current.revision) throw Object.assign(new Error(message('revisionConflict')), { statusCode: 409, project: current });
        const rawUpdated = { ...current, ...request.body, id: current.id, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date().toISOString() };
        const updated = ProjectSchema.parse({ ...rawUpdated, duration: projectDuration(rawUpdated as Project) });
        const guarded = enforceLockedTrackInvariants(current, updated);
        if (JSON.stringify(guarded.tracks) !== JSON.stringify(updated.tracks)) throw Object.assign(new Error(message('lockedTrackConflict')), { statusCode: 409, project: current });
        const retainedAssetIds = new Set(updated.assets.map((asset) => asset.id));
        const removedAssetFiles = current.assets
          .filter((asset) => !retainedAssetIds.has(asset.id))
          .flatMap((asset) => [asset.path, asset.proxyPath, asset.thumbnailPath, asset.waveformPath])
          .filter((item): item is string => Boolean(item));
        const removalPaths = removedAssetFiles.map((relative) => safeManagedAssetPath(current.id, relative));
        await saveProject(updated);
        await Promise.all(removalPaths.map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
        return updated;
      }, requestProjectLockOptions(request));
      return next;
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      const conflictProject = statusCode === 409 && typeof error === 'object' && error !== null && 'project' in error ? error.project : undefined;
      const responseCode = statusCode === 404 || statusCode === 409 || statusCode === 423 ? statusCode : 400;
      return reply.code(responseCode).send({ error: localizedError(error, responseCode === 404 ? 'projectNotFound' : 'projectSaveFailed'), ...(conflictProject ? { project: conflictProject } : {}) });
    }
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/duplicate', async (request, reply) => {
    try {
      const copy = await withProjectLock(request.params.projectId, async () => {
        const original = await readProject(request.params.projectId);
        const duplicated = ProjectSchema.parse({ ...original, id: id('project'), name: original.name + ' kopya', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 });
        await copyProjectFolder(original.id, duplicated.id);
        await saveProject(duplicated);
        return duplicated;
      }, requestProjectLockOptions(request));
      return reply.code(201).send(copy);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : undefined;
      if (statusCode === 423) return reply.code(423).send({ error: localizedError(error, 'projectCopyFailed') });
      if (statusCode === 404 || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) return reply.code(404).send({ error: message('projectNotFound') });
      return reply.code(400).send({ error: message('projectCopyFailed') });
    }
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    try {
      const result = await withProjectLock(request.params.projectId, async () => {
        const lifecycle = lifecycleFor(request.params.projectId);
        if (lifecycle.state !== 'active') throw Object.assign(new Error(message('projectNotFound')), { statusCode: 404 });
        const deletingLifecycle = { state: 'deleting' as const, generation: lifecycle.generation + 1 };
        projectLifecycles.set(request.params.projectId, deletingLifecycle);
        await cancelProjectJobs(request.params.projectId);
        const target = projectPath(request.params.projectId);
        if (!fs.existsSync(target)) {
          projectLifecycles.set(request.params.projectId, { state: 'deleted', generation: deletingLifecycle.generation });
          throw Object.assign(new Error(message('projectNotFound')), { statusCode: 404 });
        }
        const trash = safeJoin(path.join(dataDir, 'trash'), `${path.basename(target)}-${Date.now()}`);
        await ensureDir(path.dirname(trash));
        try {
          await fsp.rename(target, trash);
        } catch (error) {
          projectLifecycles.set(request.params.projectId, lifecycle);
          throw error;
        }
        projectLifecycles.set(request.params.projectId, { state: 'deleted', generation: deletingLifecycle.generation });
        return { ok: true, trashId: path.basename(trash) };
      }, { ...requestProjectLockOptions(request), allowInactive: true });
      return result;
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 423 ? statusCode : 400).send({ error: localizedError(error, 'projectNotFound') });
    }
  });

  app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/media', async (request, reply) => {
    let part: Awaited<ReturnType<FastifyRequest['file']>> | undefined;
    try {
      part = await request.file();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      return reply.code(code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400).send({ error: message(code === 'FST_REQ_FILE_TOO_LARGE' ? 'uploadTooLarge' : 'fileUnreadable') });
    }
    if (!part) return reply.code(400).send({ error: message('fileMissing') });
    const extension = path.extname(part.filename).toLowerCase();
    const expected = mediaExtensionInfo[extension];
    const declaredMimeType = String(part.mimetype || '').toLowerCase().split(';')[0];
    if (!expected || (declaredMimeType && declaredMimeType !== 'application/octet-stream' && declaredMimeType !== expected.mimeType)) {
      return reply.code(415).send({ error: message('unsupportedMedia') });
    }
    try {
      const result = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        const assetId = id('asset');
        const uploadRelativePath = path.join('media', assetId + '.upload');
        const uploadAbsolutePath = safeJoin(projectPath(current.id), uploadRelativePath);
        const relativePath = path.join('media', assetId + expected.storedExtension);
        const absolutePath = safeJoin(projectPath(current.id), relativePath);
        let asset: Asset;
        let updated: Project;
        try {
          await ensureDir(path.dirname(uploadAbsolutePath));
          await pipeline(part!.file, fs.createWriteStream(uploadAbsolutePath));
          const probed = await probeMedia(uploadAbsolutePath);
          if (detectedMediaType(probed) !== expected.type || !matchesExpectedMediaFormat(extension, probed)) throw Object.assign(new Error(message('contentMismatch')), { statusCode: 415 });
          await fsp.rename(uploadAbsolutePath, absolutePath);
          const stat = await fsp.stat(absolutePath);
          asset = {
            id: assetId,
            name: part!.filename,
            type: expected.type,
            mimeType: expected.mimeType,
            path: relativePath,
            size: stat.size,
            duration: Number(probed.duration ?? 0),
            width: Number(probed.width ?? 0) || undefined,
            height: Number(probed.height ?? 0) || undefined,
            fps: Number(probed.fps ?? 0) || undefined,
            hasAudio: Boolean(probed.hasAudio ?? expected.type === 'audio'),
            createdAt: new Date().toISOString(),
          };
          updated = ProjectSchema.parse({ ...current, assets: [...current.assets, asset], updatedAt: new Date().toISOString(), revision: current.revision + 1, duration: projectDuration(current) });
          await saveProject(updated);
        } catch (error) {
          await fsp.rm(uploadAbsolutePath, { force: true }).catch(() => undefined);
          await fsp.rm(absolutePath, { force: true }).catch(() => undefined);
          throw error;
        }
        try {
          const job = await queueDerivedMediaJob(current.id, asset);
          return { asset, project: updated, job };
        } catch (jobError) {
          return { asset, project: updated, jobError };
        }
      }, requestProjectLockOptions(request));
      return reply.code(201).send({ asset: result.asset, ...(result.job ? { job: publicJob(result.job) } : { warning: localizedError(result.jobError, 'derivativesPrepareFailed') }), project: result.project });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      const responseCode = [404, 415, 423, 429].includes(statusCode) ? statusCode : 400;
      return reply.code(responseCode).send({ error: localizedError(error, statusCode === 415 ? 'contentMismatch' : statusCode === 404 ? 'projectNotFound' : 'derivativesPrepareFailed') });
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/media-health', async (request, reply) => {
    try {
      const project = await readProject(request.params.projectId);
      return project.assets.map((asset) => {
        const sourceExists = fs.existsSync(assetFile(project.id, asset));
        const proxyExists = Boolean(asset.proxyPath && fs.existsSync(safeManagedAssetPath(project.id, asset.proxyPath)));
        const thumbnailExists = Boolean(asset.thumbnailPath && fs.existsSync(safeManagedAssetPath(project.id, asset.thumbnailPath)));
        const waveformExists = Boolean(asset.waveformPath && fs.existsSync(safeManagedAssetPath(project.id, asset.waveformPath)));
        return { assetId: asset.id, sourceExists, proxyExists, thumbnailExists, waveformExists, status: !sourceExists ? 'missing' : sourceExists && (asset.type === 'audio' ? waveformExists : thumbnailExists) ? 'ready' : 'derived-missing' };
      });
    } catch { return reply.code(404).send({ error: message('projectNotFound') }); }
  });

  app.post<{ Params: { projectId: string; assetId: string } }>('/api/projects/:projectId/media/:assetId/rebuild-derived', async (request, reply) => {
    try {
      const job = await withProjectLock(request.params.projectId, async () => {
        const project = await readProject(request.params.projectId);
        const asset = project.assets.find((item) => item.id === request.params.assetId);
        if (!asset) throw Object.assign(new Error(message('mediaNotFound')), { statusCode: 404 });
        return queueDerivedMediaJob(project.id, asset);
      }, requestProjectLockOptions(request));
      return reply.code(202).send({ job: publicJob(job) });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 423 || statusCode === 429 ? statusCode : 400).send({ error: localizedError(error, 'derivativesRebuildFailed') });
    }
  });

  app.post<{ Params: { projectId: string; assetId: string } }>('/api/projects/:projectId/media/:assetId/relink', async (request, reply) => {
    let part: Awaited<ReturnType<FastifyRequest['file']>> | undefined;
    try { part = await request.file(); } catch { return reply.code(400).send({ error: message('fileUnreadable') }); }
    if (!part) return reply.code(400).send({ error: message('fileMissing') });
    const extension = path.extname(part.filename).toLowerCase();
    const expected = mediaExtensionInfo[extension];
    const declaredMimeType = String(part.mimetype || '').toLowerCase().split(';')[0];
    try {
      const result = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        const asset = current.assets.find((item) => item.id === request.params.assetId);
        if (!asset) throw Object.assign(new Error(message('mediaNotFound')), { statusCode: 404 });
        if (!expected || expected.type !== asset.type || (declaredMimeType && declaredMimeType !== 'application/octet-stream' && declaredMimeType !== expected.mimeType)) throw Object.assign(new Error(message('relinkTypeMismatch')), { statusCode: 415 });
        const uploadPath = safeJoin(projectPath(current.id), path.join('media', asset.id + '.relink'));
        try {
          await ensureDir(path.dirname(uploadPath));
          await pipeline(part!.file, fs.createWriteStream(uploadPath));
          const probed = await probeMedia(uploadPath);
          if (detectedMediaType(probed) !== expected.type || !matchesExpectedMediaFormat(extension, probed)) throw Object.assign(new Error(message('mediaValidationFailed')), { statusCode: 415 });
          const finalRelativePath = path.join('media', asset.id + expected.storedExtension);
          const finalPath = safeJoin(projectPath(current.id), finalRelativePath);
          const previousPath = assetFile(current.id, asset);
          const staleDerivedPaths = [asset.proxyPath, asset.thumbnailPath, asset.waveformPath]
            .filter((item): item is string => Boolean(item))
            .map((relative) => safeManagedAssetPath(current.id, relative))
            .filter((file) => file !== previousPath && file !== finalPath);
          let savedAsset: Asset;
          let savedProject: Project;
          const stat = await fsp.stat(uploadPath);
          const replacementDuration = Number(probed.duration ?? 0);
          const hasOutOfBoundsSourceRange = replacementDuration > 0 && current.tracks.some((track) => track.clips.some((clip) => clip.assetId === asset.id && clip.sourceStart + clip.sourceDuration > replacementDuration + 0.000001));
          if (hasOutOfBoundsSourceRange) throw Object.assign(new Error(message('mediaValidationFailed')), { statusCode: 400 });
          const updatedAsset: Asset = { ...asset, name: part!.filename, path: finalRelativePath, mimeType: expected.mimeType, size: stat.size, duration: replacementDuration, width: Number(probed.width ?? 0) || undefined, height: Number(probed.height ?? 0) || undefined, fps: Number(probed.fps ?? 0) || undefined, hasAudio: Boolean(probed.hasAudio ?? expected.type === 'audio'), proxyPath: undefined, thumbnailPath: undefined, waveformPath: undefined };
          await replaceMediaWithRollback(uploadPath, finalPath, async () => {
            const index = current.assets.findIndex((item) => item.id === asset.id);
            if (index < 0) throw Object.assign(new Error(message('mediaNotFound')), { statusCode: 404 });
            const nextProject = ProjectSchema.parse({ ...current, assets: current.assets.map((item, itemIndex) => itemIndex === index ? updatedAsset : item), duration: projectDuration(current), revision: current.revision + 1, updatedAt: new Date().toISOString() });
            await saveProject(nextProject);
            savedAsset = updatedAsset;
            savedProject = nextProject;
          }, previousPath);
          await Promise.all(staleDerivedPaths.map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
          try { return { asset: savedAsset!, project: savedProject!, job: await queueDerivedMediaJob(current.id, savedAsset!) }; }
          catch (jobError) { return { asset: savedAsset!, project: savedProject!, jobError }; }
        } catch (error) {
          await fsp.rm(uploadPath, { force: true }).catch(() => undefined);
          throw error;
        }
      }, requestProjectLockOptions(request));
      return reply.code(202).send({ project: result.project, asset: result.asset, ...(result.job ? { job: publicJob(result.job) } : { warning: localizedError(result.jobError, 'derivativesOutputFailed') }) });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      const responseCode = [404, 415, 423, 429].includes(statusCode) ? statusCode : 400;
      return reply.code(responseCode).send({ error: localizedError(error, statusCode === 404 ? 'mediaNotFound' : statusCode === 415 ? 'mediaValidationFailed' : 'derivativesOutputFailed') });
    }
  });

  app.delete<{ Params: { projectId: string; assetId: string } }>('/api/projects/:projectId/media/:assetId', async (request, reply) => {
    try {
      const project = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        const asset = current.assets.find((item) => item.id === request.params.assetId);
        if (!asset) throw Object.assign(new Error(message('mediaNotFound')), { statusCode: 404 });
        if (current.tracks.some((track) => track.locked && track.clips.some((clip) => clip.assetId === asset.id))) {
          throw Object.assign(new Error(message('lockedTrackConflict')), { statusCode: 409 });
        }
        const rawNext = { ...current, assets: current.assets.filter((item) => item.id !== asset.id), tracks: current.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.assetId !== asset.id) })), revision: current.revision + 1, updatedAt: new Date().toISOString() };
        const next = ProjectSchema.parse({ ...rawNext, duration: projectDuration(rawNext as Project) });
        const removalPaths = [asset.path, asset.proxyPath, asset.thumbnailPath, asset.waveformPath]
          .filter((item): item is string => Boolean(item))
          .map((relative) => safeManagedAssetPath(current.id, relative));
        await saveProject(next);
        await Promise.all(removalPaths.map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
        return next;
      }, requestProjectLockOptions(request));
      return reply.send(project);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 409 || statusCode === 423 ? statusCode : 400).send({ error: localizedError(error, statusCode === 404 ? 'mediaNotFound' : statusCode === 409 ? 'lockedTrackConflict' : 'projectSaveFailed') });
    }
  });

  app.get<{ Params: { projectId: string; assetId: string }; Querystring: { proxy?: string; waveform?: string; thumbnail?: string } }>('/api/projects/:projectId/media/:assetId', async (request, reply) => {
    const project = await readProject(request.params.projectId);
    const asset = project.assets.find((item) => item.id === request.params.assetId);
    if (!asset) return reply.code(404).send({ error: message('mediaNotFound') });
    const sourceFile = assetFile(project.id, asset);
    let file = sourceFile;
    let derivedKind: 'proxy' | 'waveform' | 'thumbnail' | undefined;
    if (request.query.proxy === '1' && asset.proxyPath) {
      file = safeManagedAssetPath(project.id, asset.proxyPath);
      derivedKind = 'proxy';
    }
    if (request.query.waveform === '1' && asset.waveformPath) {
      file = safeManagedAssetPath(project.id, asset.waveformPath);
      derivedKind = 'waveform';
    }
    if (request.query.thumbnail === '1' && asset.thumbnailPath) {
      file = safeManagedAssetPath(project.id, asset.thumbnailPath);
      derivedKind = 'thumbnail';
    }
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch (error) {
      // Replacing a derived file is transactional, but Windows cannot rename over an
      // existing destination. During that tiny swap window an image thumbnail can
      // safely fall back to the immutable source instead of leaking a transient 500.
      if (derivedKind === 'thumbnail' && asset.type === 'image') {
        file = sourceFile;
        try {
          stat = await fsp.stat(file);
        } catch {
          return reply.code(404).send({ error: message('mediaFileNotFound') });
        }
      } else {
        return reply.code(404).send({ error: message('mediaFileNotFound') });
      }
    }
    const range = request.headers.range;
    const extension = path.extname(file).toLowerCase();
    const contentType = request.query.proxy === '1'
      ? 'video/mp4'
      : extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.png'
          ? 'image/png'
          : asset.mimeType || 'application/octet-stream';
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', contentType);
    if (!range) return reply.header('Content-Length', stat.size).send(fs.createReadStream(file));
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) return reply.header('Content-Length', stat.size).send(fs.createReadStream(file));
    const requestedStart = match[1] ? Number(match[1]) : undefined;
    const requestedEnd = match[2] ? Number(match[2]) : undefined;
    const start = requestedStart ?? Math.max(stat.size - (requestedEnd ?? 0), 0);
    const end = requestedStart === undefined ? stat.size - 1 : requestedEnd ?? stat.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size || end >= stat.size) {
      return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  });

  app.post<{ Params: { projectId: string }; Body: ExportRequest }>('/api/projects/:projectId/export/preflight', async (request, reply) => {
    try {
      return await withProjectLock(request.params.projectId, async () => {
        const project = await readProject(request.params.projectId);
        if (request.body?.projectRevision !== undefined && request.body.projectRevision !== project.revision) throw Object.assign(new Error(message('revisionConflict')), { statusCode: 409 });
        const exportDir = path.join(projectPath(project.id), 'exports');
        await ensureDir(exportDir);
        const options = normalizeExportOptions(project, request.body ?? {});
        return exportPreflight(project, options, exportDir);
      }, requestProjectLockOptions(request));
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 409 || statusCode === 423 ? statusCode : 400).send({ error: localizedError(error, 'exportSettingsInvalid') });
    }
  });

  app.post<{ Params: { projectId: string }; Body: ExportRequest }>('/api/projects/:projectId/export', async (request, reply) => {
    try {
      const result = await withProjectLock(request.params.projectId, async () => {
        const project = await readProject(request.params.projectId);
        if (request.body?.projectRevision !== undefined && request.body.projectRevision !== project.revision) throw Object.assign(new Error(message('revisionConflict')), { statusCode: 409 });
        const exportDir = path.join(projectPath(project.id), 'exports');
        await ensureDir(exportDir);
        const options = normalizeExportOptions(project, request.body ?? {});
        const preflight = await exportPreflight(project, options, exportDir);
        if (!preflight.ok) return { preflight, job: undefined };
        const extension = options.format === 'wav' ? 'wav' : options.format === 'mp3' ? 'mp3' : 'mp4';
        const fileName = safeExportName(project, options.fileName, extension);
        const output = uniqueOutputPath(exportDir, fileName);
        const reservedFileName = path.basename(output);
        const temporaryOutput = path.join(exportDir, `.${reservedFileName}.${crypto.randomUUID()}.tmp.${extension}`);
        reservedExportPaths.add(output);
        try {
          const audioOnly = options.format === 'mp3' || options.format === 'wav';
          const render = audioOnly ? compileComposition(project, options, temporaryOutput) : null;
          const job = await makeJob(project.id, 'export', async (jobInfo) => {
            try {
              assertProjectActive(project.id);
              if (jobs.get(jobInfo.id)?.status === 'cancelled') return;
              updateJob(jobInfo.id, { status: 'running', phase: 'rendering', message: message(audioOnly ? 'exportAudioRunning' : 'exportVideoRunning') });
              if (render) {
                jobProgressDuration.set(jobInfo.id, render.duration);
                await runFfmpeg(render.args, jobInfo, temporaryOutput);
              } else {
                await browserRenderedExport(project, options, temporaryOutput, jobInfo);
              }
              assertProjectActive(project.id);
              await publishGeneratedFile(temporaryOutput, output);
              jobProgressDuration.delete(jobInfo.id);
              updateJob(jobInfo.id, { absoluteOutputPath: output, relativeOutputPath: path.relative(projectPath(project.id), output), fileName: reservedFileName, format: options.format, phase: 'complete' });
              updateJob(jobInfo.id, { status: 'completed', progress: 1, outputPath: path.relative(rootDir, output), message: message('exportCompleted') });
            } finally {
              await fsp.rm(temporaryOutput, { force: true }).catch(() => undefined);
              reservedExportPaths.delete(output);
            }
          });
          updateJob(job.id, { fileName: reservedFileName, format: options.format, outputPath: path.relative(rootDir, output), absoluteOutputPath: output, relativeOutputPath: path.relative(projectPath(project.id), output), phase: 'queued' });
          return { preflight, job };
        } catch (error) {
          await fsp.rm(temporaryOutput, { force: true }).catch(() => undefined);
          reservedExportPaths.delete(output);
          throw error;
        }
      }, requestProjectLockOptions(request));
      if (!result.job) return reply.code(400).send({ error: result.preflight.errors.map((item) => item.message).join(' '), preflight: result.preflight });
      return reply.code(202).send({ job: publicJob(result.job), preflight: result.preflight });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      const responseCode = [404, 409, 423, 429].includes(statusCode) ? statusCode : 400;
      return reply.code(responseCode).send({ error: localizedError(error, statusCode === 429 ? 'tooManyJobs' : statusCode === 409 ? 'revisionConflict' : statusCode === 404 ? 'projectNotFound' : 'exportPrepareFailed') });
    }
  });

  app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId/download', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job || job.kind !== 'export') return reply.code(404).send({ error: message('exportJobNotFound') });
    if (job.status !== 'completed') return reply.code(409).send({ error: message('exportNotReady') });
    if (!job.relativeOutputPath || !job.fileName) return reply.code(404).send({ error: message('exportFileNotFound') });
    let file: string;
    try { file = safeExistingPath(projectPath(job.projectId), job.relativeOutputPath); }
    catch { return reply.code(404).send({ error: message('exportFileNotFound') }); }
    if (!fs.existsSync(file)) return reply.code(404).send({ error: message('exportFileNotFound') });
    const stat = await fsp.stat(file);
    const contentType = job.format === 'mp4' ? 'video/mp4' : job.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const fileName = path.basename(job.fileName).replace(/["\r\n]/g, '-');
    return reply.header('Content-Type', contentType)
      .header('Content-Disposition', attachmentContentDisposition(fileName))
      .header('Content-Length', stat.size)
      .send(fs.createReadStream(file));
  });

  app.get('/api/jobs', async () => Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob));
  app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: message('jobNotFound') });
    return publicJob(job);
  });
  app.delete<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ error: message('jobNotFound') });
    if (!['queued', 'running'].includes(job.status)) return reply.code(409).send({ error: message('jobAlreadyFinished') });
    try {
      return await withProjectLock(job.projectId, async () => {
        const process = jobProcesses.get(request.params.jobId);
        if (process) process.kill();
        updateJob(request.params.jobId, { status: 'cancelled', message: message('cancelledMessage') });
        return { ok: true };
      }, requestProjectLockOptions(request));
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 || statusCode === 423 ? statusCode : 400).send({ error: localizedError(error, 'jobNotFound') });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { time?: string; resolution?: string; fps?: string } }>('/api/projects/:projectId/preview-frame', {
    config: { rateLimit: { max: previewRequestsPerMinute, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    let previewSlotAcquired = false;
    let previewAbortController: AbortController | null = null;
    let abortPreviewRequest: (() => void) | null = null;
    try {
      const project = await readProject(request.params.projectId);
      const time = Number(request.query.time ?? 0);
      if (!Number.isFinite(time) || time < 0 || time >= Math.max(project.duration, 0.001)) return reply.code(400).send({ error: message('exportSettingsInvalid') });
      const resolution = ExportResolutionSchema.parse(request.query.resolution ?? '720p');
      const fps = ExportFpsSchema.parse(Number(request.query.fps ?? nearestExportFps(project.canvas.fps, 30)));
      const frameTime = clamp(Math.round(time * fps) / fps, 0, Math.max(0, project.duration - 1 / fps));
      const cacheKey = `${project.id}:${project.revision}:${ffmpegNumber(frameTime)}:${resolution}:${fps}`;
      const cached = previewFrameCache.get(cacheKey);
      if (cached) {
        previewFrameCache.delete(cacheKey);
        previewFrameCache.set(cacheKey, cached);
        return reply
          .header('Content-Type', 'image/png')
          .header('Content-Length', cached.length)
          .header('Cache-Control', 'private, no-store')
          .header('X-CutLoc-Preview-Cache', 'HIT')
          .send(cached);
      }
      if (activePreviewRenders >= maxConcurrentPreviews) return reply.code(429).send({ error: message('tooManyJobs') });
      activePreviewRenders += 1;
      previewSlotAcquired = true;
      previewAbortController = new AbortController();
      abortPreviewRequest = () => previewAbortController?.abort();
      request.raw.once('aborted', abortPreviewRequest);
      await serverTestHooks.beforePreviewRender?.(project.id);
      const { width, height } = outputDimensions(project, project.canvas.aspect, resolution);
      const bytes = await browserRenderedFrame(project.id, width, height, frameTime, previewAbortController.signal);
      const replaced = previewFrameCache.get(cacheKey);
      if (replaced) previewFrameCacheBytes -= replaced.length;
      previewFrameCache.set(cacheKey, bytes);
      previewFrameCacheBytes += bytes.length;
      while (previewFrameCache.size > maxPreviewFrameCacheEntries || previewFrameCacheBytes > maxPreviewFrameCacheBytes) {
        const oldest = previewFrameCache.keys().next().value as string | undefined;
        if (!oldest) break;
        previewFrameCacheBytes -= previewFrameCache.get(oldest)?.length ?? 0;
        previewFrameCache.delete(oldest);
      }
      return reply
        .header('Content-Type', 'image/png')
        .header('Content-Length', bytes.length)
        .header('Cache-Control', 'private, no-store')
        .header('X-CutLoc-Preview-Cache', 'MISS')
        .send(bytes);
    } catch (error) {
      return reply.code(400).send({ error: localizedError(error, 'exportPrepareFailed') });
    } finally {
      if (abortPreviewRequest) request.raw.off('aborted', abortPreviewRequest);
      if (previewSlotAcquired) activePreviewRenders = Math.max(0, activePreviewRenders - 1);
    }
  });

  app.get('/api/events', async (request, reply) => {
    if (clients.size >= maxSseClients) return reply.code(429).send({ error: message('tooManyProgressConnections') });
    const origin = request.headers.origin;
    reply.hijack();
    const headers: Record<string, string> = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
    if (origin && isAllowedWebOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
    reply.raw.writeHead(200, headers);
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const client = { reply };
    clients.add(client);
    reply.raw.on('close', () => clients.delete(client));
  });

  if (fs.existsSync(webDist)) {
    // Serve the built SPA assets as well as index.html.  `wildcard: false`
    // lets the catch-all route swallow `/assets/*`, which leaves the browser
    // with HTML instead of JavaScript after a cache-busting reload.
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true });
  }
}

async function ensureProjectFolders(projectId: string) {
  for (const folder of ['media', 'proxies', 'thumbnails', 'waveforms', 'exports', 'backups']) await ensureDir(path.join(projectPath(projectId), folder));
}

async function copyProjectFolder(fromId: string, toId: string) {
  await ensureDir(projectPath(toId));
  await fsp.cp(projectPath(fromId), projectPath(toId), { recursive: true });
  await ensureProjectFolders(toId);
}

export async function createServer() {
  await ensureDir(dataDir);
  await ensureDir(projectsDir);
  await loadSettings();
  await loadJobs();
  const app = Fastify({ logger: false, bodyLimit: maxUploadBytes });
  app.addHook('onClose', async () => { await flushJobsPersist(); });
  await app.register(rateLimit, {
    global: true,
    max: globalRequestsPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: message('rateLimitExceeded', { seconds: Math.max(1, Math.ceil(context.ttl / 1000)) }),
    }),
  });
  app.addContentTypeParser(['application/zip', 'application/octet-stream'], { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') && !isAllowedLocalRequest(request)) {
      return reply.code(403).send({ error: message('localOnly') });
    }
    try {
      assertProjectAccess(request);
    } catch (error) {
      const locked = error as { message?: string; code?: string; lease?: ProjectAccessLease };
      return reply.code(423).send({ error: locked.message ?? message('projectSaveFailed'), code: locked.code ?? 'PROJECT_LOCKED', lease: locked.lease });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await registerRoutes(app);
  return app;
}

export function setRuntimePort(port: number) {
  runtimePort = port;
}

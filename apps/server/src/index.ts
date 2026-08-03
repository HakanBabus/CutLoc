import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';
import {
  defaultProject,
  defaultSettings,
  clamp,
  exportDimensions,
  ProjectSchema,
  ExportOptionsSchema,
  SettingsSchema,
  type Asset,
  type ExportOptions,
  type Job,
  type Project,
  type Settings,
} from '@cutloc/shared';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(rootDir, 'data'));
const projectsDir = path.join(dataDir, 'projects');
const settingsFile = path.join(dataDir, 'settings.json');
const stockDir = path.join(rootDir, 'apps', 'server', 'stock');
const port = Number(process.env.PORT ?? 4173);
const webDist = path.join(rootDir, 'apps/web/dist');
function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const maxUploadBytes = boundedNumber(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 1024, 32 * 1024 * 1024, 20 * 1024 * 1024 * 1024);
const maxFfmpegRuntimeMs = boundedNumber(process.env.FFMPEG_TIMEOUT_MS, 30 * 60 * 1000, 30 * 1000, 6 * 60 * 60 * 1000);
const maxJobHistory = 200;
const maxSseClients = 32;
const maxConcurrentJobs = 2;

type SseClient = { reply: FastifyReply };
const clients = new Set<SseClient>();
const jobs = new Map<string, Job>();
const jobProcesses = new Map<string, ReturnType<typeof spawn>>();
let settings: Settings = defaultSettings();
const transientKeys = { openai: '', gemini: '' };

function activeJobCount() {
  return Array.from(jobs.values()).filter((job) => job.status === 'queued' || job.status === 'running').length;
}

type TimelineClip = Project['tracks'][number]['clips'][number];
type ExportRequest = Partial<ExportOptions> & { audioOnly?: boolean };

const STOCK_MEDIA = [
  { id: 'white', name: 'Beyaz yüzey', description: 'Temiz ve aydınlık arka plan', fileName: 'white.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'black', name: 'Siyah yüzey', description: 'Sade ve sinematik arka plan', fileName: 'black.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sage', name: 'Adaçayı degrade', description: 'Yumuşak yeşil geçiş', fileName: 'sage.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'sunset', name: 'Gün batımı', description: 'Sıcak renkli sahne', fileName: 'sunset.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'paper', name: 'Kâğıt dokusu', description: 'Sıcak nötr yüzey', fileName: 'paper.png', mimeType: 'image/png', width: 1600, height: 900 },
  { id: 'neon-grid', name: 'Neon ızgara', description: 'Teknolojik vurgu', fileName: 'neon-grid.png', mimeType: 'image/png', width: 1600, height: 900 },
] as const;

function isLocalHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isAllowedLocalRequest(request: FastifyRequest) {
  const host = request.headers.host;
  if (host) {
    const hostname = host.replace(/^\[/, '').split(']')[0].split(':')[0].toLowerCase();
    if (!isLocalHostname(hostname)) return false;
  }
  const origin = request.headers.origin;
  if (!origin || origin === 'null') return !origin;
  try {
    const parsed = new URL(origin);
    return isLocalHostname(parsed.hostname.toLowerCase()) && (!parsed.port || parsed.port === String(port) || parsed.port === '5173');
  } catch {
    return false;
  }
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

function projectPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw Object.assign(new Error('Geçersiz proje kimliği'), { statusCode: 400 });
  }
  return path.join(projectsDir, projectId);
}

function projectFile(projectId: string) {
  return path.join(projectPath(projectId), 'project.json');
}

async function atomicWrite(file: string, content: string) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, content, 'utf8');
  await fsp.rename(temp, file);
}

async function readProject(projectId: string): Promise<Project> {
  const raw = await fsp.readFile(projectFile(projectId), 'utf8');
  return ProjectSchema.parse(JSON.parse(raw));
}

async function saveProject(project: Project) {
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
async function withProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  projectLocks.set(projectId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (projectLocks.get(projectId) === queued) projectLocks.delete(projectId);
  }
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await fsp.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    // Migrate preferences that older builds exposed before the corresponding
    // interface/encoder support existed, while preserving every other setting.
    stored.hardwareAcceleration = 'software';
    stored.experimentalAi = false;
    stored.shortcuts = defaultSettings().shortcuts;
    settings = SettingsSchema.parse(stored);
  } catch {
    settings = defaultSettings();
  }
  if (process.env.OPENAI_API_KEY) transientKeys.openai = process.env.OPENAI_API_KEY;
  if (process.env.GEMINI_API_KEY) transientKeys.gemini = process.env.GEMINI_API_KEY;
  settings = { ...settings, experimentalAi: false, hasOpenAiKey: false, hasGeminiKey: false };
}

async function saveSettings(next: Partial<Settings> & { openAiKey?: string; geminiKey?: string }) {
  const safe = SettingsSchema.parse({
    ...settings,
    ...next,
    experimentalAi: false,
    shortcuts: defaultSettings().shortcuts,
    hasOpenAiKey: false,
    hasGeminiKey: false,
  });
  settings = safe;
  await ensureDir(dataDir);
  await atomicWrite(settingsFile, JSON.stringify(safe, null, 2));
  return safe;
}

function binaryPath(name: 'ffmpeg' | 'ffprobe') {
  const envPath = process.env[name.toUpperCase() + '_PATH'];
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const pkg = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
    if (typeof pkg === 'string' && fs.existsSync(pkg)) return pkg;
  } catch { /* package optional during development */ }
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

async function probeMedia(file: string) {
  const ffprobe = binaryPath('ffprobe');
  if (!ffprobe) return {};
  return await new Promise<Record<string, unknown>>((resolve) => {
    const child = spawn(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
    let out = '';
    const timeout = setTimeout(() => child.kill(), Math.min(maxFfmpegRuntimeMs, 5 * 60 * 1000));
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.once('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
        const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
        const audio = parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
        resolve({
          duration: Number(parsed.format?.duration ?? video?.duration ?? 0),
          width: Number(video?.width ?? 0) || undefined,
          height: Number(video?.height ?? 0) || undefined,
          fps: typeof video?.r_frame_rate === 'string' && video.r_frame_rate.includes('/')
            ? Number(video.r_frame_rate.split('/')[0]) / Number(video.r_frame_rate.split('/')[1])
            : undefined,
          hasAudio: audio,
        });
      } catch { resolve({}); }
    });
  });
}

function publicJob(job: Job) {
  return job;
}

function publish(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.reply.raw.write(payload);
}

function updateJob(jobId: string, patch: Partial<Job>) {
  const job = jobs.get(jobId);
  if (!job) return;
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  pruneJobs();
  publish('job', publicJob(next));
}

function pruneJobs() {
  if (jobs.size <= maxJobHistory) return;
  const removable = Array.from(jobs.values())
    .filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const job of removable.slice(0, Math.max(0, jobs.size - maxJobHistory))) jobs.delete(job.id);
}

async function makeJob(projectId: string, kind: Job['kind'], runner: (job: Job) => Promise<void>) {
  const now = new Date().toISOString();
  const job: Job = { id: id('job'), projectId, kind, status: 'queued', progress: 0, createdAt: now, updatedAt: now };
  jobs.set(job.id, job);
  pruneJobs();
  publish('job', job);
  // A cancelled process can still reject while its child is being reaped.  Do
  // not turn that expected rejection into a misleading "failed" state.
  void runner(job).catch((error: unknown) => {
    const current = jobs.get(job.id);
    if (current?.status === 'cancelled') return;
    updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  });
  return job;
}

async function runFfmpeg(args: string[], job: Job, outputPath?: string) {
  const ffmpeg = binaryPath('ffmpeg');
  if (!ffmpeg) throw new Error('FFmpeg bulunamadı. npm install sonrası ffmpeg-static kurulmalı veya FFMPEG_PATH tanımlanmalı.');
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    jobProcesses.set(job.id, child);
    const timeout = setTimeout(() => child.kill(), maxFfmpegRuntimeMs);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
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
    child.once('close', (code) => {
      clearTimeout(timeout);
      jobProcesses.delete(job.id);
      jobProgressDuration.delete(job.id);
      if (code === 0 && jobs.get(job.id)?.status !== 'cancelled') {
        resolve();
        return;
      }
      // The output is always a newly generated file.  Removing a partial file
      // makes retrying safe and prevents a failed export looking complete in
      // the exports directory.
      if (outputPath) void fsp.rm(outputPath, { force: true }).catch(() => undefined);
      if (jobs.get(job.id)?.status === 'cancelled') {
        reject(new Error('İşlem iptal edildi'));
        return;
      }
      reject(new Error(stderr.slice(-2400) || `FFmpeg exit code ${code}`));
    });
  });
}

const jobProgressDuration = new Map<string, number>();

function safeJoin(base: string, candidate: string) {
  const resolved = path.resolve(base, candidate);
  if (resolved !== path.resolve(base) && !resolved.startsWith(`${path.resolve(base)}${path.sep}`)) throw new Error('Geçersiz dosya yolu');
  return resolved;
}

function safeExistingPath(base: string, candidate: string) {
  const resolved = safeJoin(base, candidate);
  if (!fs.existsSync(resolved)) return resolved;
  const realBase = fs.realpathSync.native(base);
  const realPath = fs.realpathSync.native(resolved);
  if (realPath !== realBase && !realPath.startsWith(realBase + path.sep)) throw new Error('Geçersiz dosya yolu');
  return realPath;
}

function assetFile(projectId: string, asset: Asset) {
  return safeExistingPath(projectPath(projectId), asset.path);
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const supportedExportFps = [24, 25, 30, 50, 60] as const;

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
    fps: nearestExportFps(request.fps, numberOr(project.canvas.fps, 30)),
    quality: request.quality ?? 'standard',
    audioBitrateKbps: request.audioBitrateKbps ?? 192,
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

function uniqueOutputPath(exportDir: string, fileName: string) {
  const parsed = path.parse(fileName);
  let candidate = path.join(exportDir, fileName);
  let index = 2;
  while (fs.existsSync(candidate)) candidate = path.join(exportDir, `${parsed.name}-${index++}${parsed.ext}`);
  return safeJoin(exportDir, path.relative(exportDir, candidate));
}

function visibleRenderClip(clip: TimelineClip, rangeStart: number, rangeEnd: number): TimelineClip | null {
  const clipStart = Math.max(0, numberOr(clip.start, 0));
  const clipEnd = clipStart + Math.max(0, numberOr(clip.duration, 0));
  const visibleStart = Math.max(clipStart, rangeStart);
  const visibleEnd = Math.min(clipEnd, rangeEnd);
  if (visibleEnd <= visibleStart) return null;
  const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
  const offset = Math.max(0, visibleStart - clipStart);
  return {
    ...clip,
    start: visibleStart - rangeStart,
    duration: visibleEnd - visibleStart,
    sourceStart: Math.max(0, numberOr(clip.sourceStart, 0) + offset * speed),
    sourceDuration: Math.max(0.05, (visibleEnd - visibleStart) * speed),
  };
}

function ffmpegNumber(value: number) {
  // Filter expressions are easier to debug when they never contain scientific
  // notation.  Keep enough precision for frame-accurate clip boundaries.
  return Math.max(0, value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function ffmpegColor(value: string) {
  const normalized = String(value || '').trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? `0x${normalized}` : '0x101116';
}

function ffmpegText(value: string) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll(':', '\\:')
    .replaceAll('%', '\\%')
    .replaceAll('\r', '')
    .replaceAll('\n', '\\n');
}

function ffmpegFont(value: string) {
  const family = String(value || 'Arial').split(',')[0].trim() || 'Arial';
  return ffmpegText(family);
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
function buildExportArgs(project: Project, request: ExportRequest, output: string) {
  const body = normalizeExportOptions(project, request);
  const { width: outWidth, height: outHeight } = outputDimensions(project, body.aspect, body.resolution);
  const fps = body.fps;
  const audioOnly = body.format === 'mp3' || body.format === 'wav' || request.audioOnly === true;
  const tracks = [...project.tracks]
    .filter((track) => !track.hidden)
    .sort((a, b) => a.order - b.order);
  const allTimelineClips: Array<{ clip: TimelineClip; asset: Asset; trackMuted: boolean }> = [];
  const allTextClips: TimelineClip[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.type === 'text' || clip.type === 'subtitle') {
        if (clip.textStyle?.text || clip.subtitle?.text) allTextClips.push(clip);
        continue;
      }
      if (!clip.assetId) continue;
      const asset = project.assets.find((item) => item.id === clip.assetId);
      if (!asset) throw new Error(`Klip medyası bulunamadı: ${clip.name}`);
      const file = assetFile(project.id, asset);
      if (!fs.existsSync(file)) throw new Error(`Medya dosyası bulunamadı: ${asset.name}`);
      if (numberOr(clip.duration, 0) <= 0) continue;
      allTimelineClips.push({ clip, asset, trackMuted: track.muted });
    }
  }
  if (!allTimelineClips.length && !allTextClips.length) throw new Error('Export için timeline üzerinde medya veya metin klibi gerekli');

  const fullDuration = Math.max(0.1, numberOr(project.duration, 0), ...allTimelineClips.map(({ clip }) => Math.max(0, numberOr(clip.start, 0)) + Math.max(0, numberOr(clip.duration, 0))), ...allTextClips.map((clip) => Math.max(0, numberOr(clip.start, 0)) + Math.max(0, numberOr(clip.duration, 0))));
  const rangeStart = clamp(numberOr(body.range?.start, 0), 0, Math.max(0, fullDuration - 0.001));
  const rangeEnd = clamp(numberOr(body.range?.end, fullDuration), rangeStart + 0.001, fullDuration);
  const projectDuration = Math.max(0.1, rangeEnd - rangeStart);
  const clips = allTimelineClips
    .map((entry) => ({ ...entry, clip: visibleRenderClip(entry.clip, rangeStart, rangeEnd) }))
    .filter((entry): entry is { clip: TimelineClip; asset: Asset; trackMuted: boolean } => Boolean(entry.clip));
  const textClips = allTextClips.map((clip) => visibleRenderClip(clip, rangeStart, rangeEnd)).filter((clip): clip is TimelineClip => Boolean(clip));
  if (!clips.length && !textClips.length) throw new Error('Selected range does not contain media or text');
  const inputArgs: string[] = [];
  const videoClips: Array<{ clip: TimelineClip; asset: Asset; inputIndex: number; duration: number }> = [];
  const audioClips: Array<{ clip: TimelineClip; asset: Asset; inputIndex: number; duration: number; trackMuted: boolean }> = [];
  const filterLines: string[] = [];

  for (const entry of clips) {
    const { clip, asset, trackMuted } = entry;
    const clipDuration = Math.max(0, numberOr(clip.duration, 0));
    if (clipDuration <= 0) continue;
    const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
    const isImage = asset.type === 'image' || clip.type === 'image';
    const wantsVideo = !audioOnly && (clip.type === 'video' || clip.type === 'image') && (asset.type === 'video' || asset.type === 'image');
    const wantsAudio = asset.hasAudio && (clip.type === 'video' || clip.type === 'audio') && (audioOnly || !trackMuted);
    if (!wantsVideo && !wantsAudio) continue;

    const sourceStart = Math.max(0, numberOr(clip.sourceStart, 0));
    const requestedSourceDuration = Math.max(0.1, clipDuration * speed + 0.25);
    const sourceDuration = asset.duration > 0
      ? Math.max(0.1, Math.min(requestedSourceDuration, Math.max(0.1, asset.duration - Math.min(sourceStart, Math.max(0, asset.duration - 0.1)))))
      : requestedSourceDuration;
    const inputPath = assetFile(project.id, asset);
    const inputIndex = inputArgs.filter((arg) => arg === '-i').length;
    if (isImage) inputArgs.push('-loop', '1', '-framerate', String(fps), '-i', inputPath);
    else inputArgs.push('-ss', ffmpegNumber(Math.min(sourceStart, Math.max(0, asset.duration - 0.05))), '-t', ffmpegNumber(sourceDuration), '-i', inputPath);

    if (wantsVideo) videoClips.push({ clip, asset, inputIndex, duration: clipDuration });
    if (wantsAudio) audioClips.push({ clip, asset, inputIndex, duration: clipDuration, trackMuted });
  }

  if (!audioOnly) {
    const baseDuration = ffmpegNumber(projectDuration);
    filterLines.push(`color=c=${ffmpegColor(project.canvas.background)}:s=${outWidth}x${outHeight}:r=${ffmpegNumber(fps)}:d=${baseDuration}[base]`);
    let current = '[base]';
    videoClips.forEach(({ clip, inputIndex, duration }, index) => {
      const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
      const transform = clip.transform;
      const filters = ['setpts=PTS-STARTPTS'];
      if (Math.abs(speed - 1) > 0.0001) filters.push(`setpts=PTS/${ffmpegNumber(speed)}`);
      filters.push(`trim=duration=${ffmpegNumber(duration)}`, 'setpts=PTS-STARTPTS');
      const fit = transform.fit;
      if (fit === 'cover') filters.push(`scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase`, `crop=${outWidth}:${outHeight}`);
      else if (fit === 'stretch') filters.push(`scale=${outWidth}:${outHeight}`);
      else filters.push(`scale=${outWidth}:${outHeight}:force_original_aspect_ratio=decrease`);
      const scale = Math.max(0.05, numberOr(transform.scale, 1));
      if (Math.abs(scale - 1) > 0.0001) filters.push(`scale=ceil(iw*${ffmpegNumber(scale)}/2)*2:ceil(ih*${ffmpegNumber(scale)}/2)*2`);
      if (transform.flipX) filters.push('hflip');
      if (transform.flipY) filters.push('vflip');
      const rotation = numberOr(transform.rotation, 0);
      if (Math.abs(rotation) > 0.001) filters.push(`rotate=${ffmpegNumber(rotation * Math.PI / 180)}:fillcolor=none`);
      const brightness = numberOr(clip.filters.brightness, 0);
      const contrast = numberOr(clip.filters.contrast, 0);
      const saturation = numberOr(clip.filters.saturation, 0);
      if (Math.abs(brightness) > 0.001 || Math.abs(contrast) > 0.001 || Math.abs(saturation) > 0.001) {
        filters.push(`eq=brightness=${ffmpegNumber(brightness)}:contrast=${ffmpegNumber(1 + contrast)}:saturation=${ffmpegNumber(1 + saturation)}`);
      }
      const blur = Math.max(0, numberOr(clip.filters.blur, 0));
      if (blur > 0.01) filters.push(`boxblur=luma_radius=${ffmpegNumber(Math.max(1, blur / 2))}:luma_power=1`);
      if (numberOr(clip.filters.grayscale, 0) > 0.01) filters.push('hue=s=0');
      const temperature = numberOr(clip.filters.temperature, 0);
      if (Math.abs(temperature) > 0.001) filters.push(`colorbalance=rs=${ffmpegNumber(temperature * 0.35)}:gs=${ffmpegNumber(temperature * 0.08)}:bs=${ffmpegNumber(-temperature * 0.35)}`);
      const hue = numberOr(clip.filters.hue, 0);
      if (Math.abs(hue) > 0.001) filters.push(`hue=h=${ffmpegNumber(hue)}`);
      const vignette = clamp(numberOr(clip.filters.vignette, 0), 0, 1);
      if (vignette > 0.001) filters.push(`vignette=angle=${ffmpegNumber(Math.PI / 4 + vignette * Math.PI / 4)}`);
      if (clip.filters.chromaKey) {
        const key = clip.filters.chromaKey;
        filters.push(`chromakey=${ffmpegColor(key.color)}:${ffmpegNumber(key.similarity)}:${ffmpegNumber(key.blend)}`);
      }
      const opacity = Math.max(0, Math.min(1, numberOr(transform.opacity, 1)));
      if (opacity < 0.999) filters.push(`format=rgba`, `colorchannelmixer=aa=${ffmpegNumber(opacity)}`);
      const fadeIn = clamp(numberOr(clip.fadeIn, 0), 0, duration);
      const fadeOut = clamp(numberOr(clip.fadeOut, 0), 0, duration);
      if (clip.transitionIn?.type !== 'none' && clip.transitionIn?.duration > 0) filters.push(`fade=t=in:st=0:d=${ffmpegNumber(Math.min(duration, clip.transitionIn.duration))}:alpha=1`);
      else if (fadeIn > 0) filters.push(`fade=t=in:st=0:d=${ffmpegNumber(fadeIn)}:alpha=1`);
      if (clip.transitionOut?.type !== 'none' && clip.transitionOut?.duration > 0) filters.push(`fade=t=out:st=${ffmpegNumber(Math.max(0, duration - clip.transitionOut.duration))}:d=${ffmpegNumber(Math.min(duration, clip.transitionOut.duration))}:alpha=1`);
      else if (fadeOut > 0) filters.push(`fade=t=out:st=${ffmpegNumber(Math.max(0, duration - fadeOut))}:d=${ffmpegNumber(fadeOut)}:alpha=1`);
      filters.push(`setpts=PTS-STARTPTS+${ffmpegNumber(Math.max(0, numberOr(clip.start, 0)))}/TB`);
      const label = `[v${index}]`;
      filterLines.push(`[${inputIndex}:v]${filters.join(',')}${label}`);
      const x = numberOr(transform.x, 0);
      const y = numberOr(transform.y, 0);
      const next = `[comp${index}]`;
      filterLines.push(`${current}${label}overlay=x=(main_w-overlay_w)/2+${ffmpegNumber(x)}:y=(main_h-overlay_h)/2+${ffmpegNumber(y)}:eof_action=pass:shortest=0:format=auto${next}`);
      current = next;
    });
    for (const [index, clip] of textClips.entries()) {
      const style = clip.textStyle ?? { text: clip.subtitle?.text ?? clip.name, fontFamily: 'Arial', fontSize: 42, fontWeight: 700, fontStyle: 'normal', textDecoration: 'none', letterSpacing: 0, lineHeight: 1.2, padding: 4, color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' as const };
      const transform = clip.transform;
      const text = ffmpegText(style.text);
      const fontSize = Math.max(8, Math.round(numberOr(style.fontSize, 42)));
      const fontColor = ffmpegColor(style.color);
      const strokeColor = ffmpegColor(style.stroke);
      const x = numberOr(transform.x, 0);
      const y = numberOr(transform.y, 0);
      const draw = [`drawtext=font='${ffmpegFont(style.fontFamily)}'`, `text='${text}'`, `fontsize=${fontSize}`, `fontcolor=${fontColor}`, `x=(w-text_w)/2+${ffmpegNumber(x)}`, `y=(h-text_h)/2+${ffmpegNumber(y)}`, `enable='between(t,${ffmpegNumber(clip.start)},${ffmpegNumber(clip.start + clip.duration)})'`];
      if (numberOr(style.strokeWidth, 0) > 0 && style.stroke !== 'transparent') draw.push(`borderw=${ffmpegNumber(style.strokeWidth)}`, `bordercolor=${strokeColor}`);
      if (style.shadow) draw.push('shadowx=2', 'shadowy=2', 'shadowcolor=0x00000099');
      const next = `[text${index}]`;
      filterLines.push(`${current}${draw.join(':')}${next}`);
      current = next;
    }
    // The output always has a video stream, even when a project currently only
    // contains audio.  This makes the export action useful while a user is
    // assembling a timeline and avoids FFmpeg's "Output file is empty" error.
    filterLines.push(`${current}format=yuv420p[vout]`);
  }

  const audioLabels: string[] = [];
  audioClips.forEach(({ clip, inputIndex, duration }, index) => {
    const speed = Math.max(0.25, Math.min(4, numberOr(clip.speed, 1)));
    const filters = ['asetpts=PTS-STARTPTS', ...atempoChain(speed), `atrim=duration=${ffmpegNumber(duration)}`, 'asetpts=PTS-STARTPTS'];
    const volume = Math.max(0, Math.min(2, numberOr(clip.volume, 1)));
    if (Math.abs(volume - 1) > 0.001) filters.push(`volume=${ffmpegNumber(volume)}`);
    const fadeIn = clamp(numberOr(clip.fadeIn, 0), 0, duration);
    const fadeOut = clamp(numberOr(clip.fadeOut, 0), 0, duration);
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${ffmpegNumber(fadeIn)}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${ffmpegNumber(Math.max(0, duration - fadeOut))}:d=${ffmpegNumber(fadeOut)}`);
    if (clip.normalize) filters.push('dynaudnorm=f=150:g=15');
    const delay = Math.max(0, Math.round(numberOr(clip.start, 0) * 1000));
    if (delay > 0) filters.push(`adelay=${delay}:all=1`);
    const label = `[a${index}]`;
    filterLines.push(`[${inputIndex}:a]${filters.join(',')}${label}`);
    audioLabels.push(label);
  });
  if (audioLabels.length) filterLines.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,aresample=async=1:first_pts=0[aout]`);
  else filterLines.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${ffmpegNumber(projectDuration)}[aout]`);

  const args = [...inputArgs, '-filter_complex', filterLines.join(';')];
  const outputFormat = body.format;
  if (audioOnly) {
    args.push('-map', '[aout]', '-vn', '-t', ffmpegNumber(projectDuration));
    if (outputFormat === 'wav') args.push('-c:a', 'pcm_s16le');
    else args.push('-c:a', 'libmp3lame', '-b:a', `${body.audioBitrateKbps}k`);
  } else {
    const quality = body.quality === 'draft'
      ? { preset: 'veryfast', crf: 28 }
      : body.quality === 'high'
        ? { preset: 'slow', crf: 18 }
        : { preset: 'medium', crf: 23 };
    args.push('-map', '[vout]', '-map', '[aout]', '-t', ffmpegNumber(projectDuration), '-r', ffmpegNumber(fps), '-c:v', 'libx264', '-preset', quality.preset);
    if (body.rateMode === 'bitrate' && body.videoBitrateKbps) args.push('-b:v', `${body.videoBitrateKbps}k`);
    else args.push('-crf', String(body.crf ?? quality.crf));
    args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${body.audioBitrateKbps}k`, '-movflags', '+faststart');
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
  const warnings: Array<{ code: string; message: string }> = [];
  const ffmpeg = binaryPath('ffmpeg');
  if (!ffmpeg) errors.push({ code: 'FFMPEG_MISSING', message: 'FFmpeg bulunamadı.' });
  try {
    const render = buildExportArgs(project, options, path.join(exportDir, '.preflight.tmp'));
    const estimatedBytes = estimateExportBytes(options, render.duration);
    try {
      const stat = fs.statfsSync(exportDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes < estimatedBytes * 1.2) errors.push({ code: 'DISK_SPACE', message: 'Dışa aktarma için yeterli disk alanı yok.' });
      else if (freeBytes < estimatedBytes * 2) warnings.push({ code: 'DISK_SPACE_LOW', message: 'Dışa aktarma disk alanının büyük bölümünü kullanabilir.' });
    } catch {
      warnings.push({ code: 'DISK_SPACE_UNKNOWN', message: 'Disk alanı doğrulanamadı.' });
    }
    if (options.fps !== nearestExportFps(project.canvas.fps, project.canvas.fps)) warnings.push({ code: 'FPS_CONVERT', message: `Proje FPS değeri ${options.fps} FPS olarak yeniden örneklenecek.` });
    if (options.resolution === '4K') warnings.push({ code: 'LARGE_OUTPUT', message: '4K dışa aktarma daha uzun sürebilir ve daha fazla disk alanı kullanır.' });
    const timelineClips = project.tracks.flatMap((track) => track.clips);
    if (timelineClips.some((clip) => clip.keyframes.length > 0)) warnings.push({ code: 'KEYFRAMES_FALLBACK', message: "Animasyon keyframe'leri preview'de uygulanıyor; export için temel klip değerleri kullanılacak." });
    if (timelineClips.some((clip) => Boolean(clip.speedCurve?.length))) warnings.push({ code: 'SPEED_CURVE_FALLBACK', message: "Hız rampaları preview'de uygulanıyor; export sabit klip hızına dönecek." });
    if (timelineClips.some((clip) => Boolean(clip.mask))) warnings.push({ code: 'MASK_FALLBACK', message: "Maske ayarları preview'de gösteriliyor; export için medya kadrajı kullanılacak." });
    const advancedTransitions = timelineClips.some((clip) => [clip.transitionIn?.type, clip.transitionOut?.type].some((type) => type !== undefined && type !== 'none' && type !== 'fade'));
    if (advancedTransitions) warnings.push({ code: 'TRANSITION_FALLBACK', message: "Dissolve, slide, wipe ve zoom geçişleri export'ta fade yaklaşımıyla işlenir." });
    return { ok: errors.length === 0, errors, warnings, estimatedBytes };
  } catch (error) {
    errors.push({ code: 'INVALID_TIMELINE', message: error instanceof Error ? error.message : 'Timeline dışa aktarılamadı.' });
    return { ok: false, errors, warnings };
  }
}

async function listProjects() {
  await ensureDir(projectsDir);
  const names = await fsp.readdir(projectsDir, { withFileTypes: true });
  const result: Array<Pick<Project, 'id' | 'name' | 'updatedAt' | 'createdAt' | 'duration' | 'canvas' | 'assets'>> = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await readProject(entry.name);
      result.push({ id: project.id, name: project.name, updatedAt: project.updatedAt, createdAt: project.createdAt, duration: project.duration, canvas: project.canvas, assets: project.assets });
    } catch { /* skip corrupt projects in list; opening exposes recovery state later */ }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function trashPath(trashId: string) {
  if (!/^[A-Za-z0-9_-]+-\d+$/.test(trashId)) throw Object.assign(new Error('Geçersiz çöp kutusu kimliği'), { statusCode: 400 });
  return safeJoin(path.join(dataDir, 'trash'), trashId);
}

async function listTrash() {
  const trashDir = path.join(dataDir, 'trash');
  if (!fs.existsSync(trashDir)) return [];
  const entries = await fsp.readdir(trashDir, { withFileTypes: true });
  const result: Array<{ trashId: string; projectId: string; name: string; createdAt: string; updatedAt: string; deletedAt: string; duration: number; assetCount: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+-\d+$/.test(entry.name)) continue;
    try {
      const project = ProjectSchema.parse(JSON.parse(await fsp.readFile(path.join(trashPath(entry.name), 'project.json'), 'utf8')));
      const stat = await fsp.stat(trashPath(entry.name));
      result.push({ trashId: entry.name, projectId: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, deletedAt: stat.mtime.toISOString(), duration: project.duration, assetCount: project.assets.length });
    } catch { /* skip incomplete/corrupt trash entries */ }
  }
  return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function listBackups(projectId: string) {
  const backupDir = path.join(projectPath(projectId), 'backups');
  if (!fs.existsSync(backupDir)) return [];
  const entries = await fsp.readdir(backupDir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^project-\d+\.json$/i.test(entry.name)) continue;
    const file = path.join(backupDir, entry.name);
    const stat = await fsp.stat(file);
    result.push({ fileName: entry.name, createdAt: stat.mtime.toISOString(), size: stat.size });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function extensionFor(name: string, fallback = '.bin') {
  const ext = path.extname(name).toLowerCase();
  return ext && ext.length < 12 ? ext : fallback;
}

async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true, port, ffmpeg: Boolean(binaryPath('ffmpeg')), ffprobe: Boolean(binaryPath('ffprobe')), dataDir: path.basename(dataDir) }));

  app.get('/api/settings', async () => settings);
  app.put<{ Body: Partial<Settings> & { openAiKey?: string; geminiKey?: string } }>('/api/settings', async (request, reply) => {
    try {
      return await saveSettings(request.body ?? {});
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Ayarlar geçersiz' });
    }
  });

  app.get('/api/stock', async () => STOCK_MEDIA.map(({ id, name, description, mimeType, width, height }) => ({ id, name, description, mimeType, width, height })));
  app.get<{ Params: { stockId: string } }>('/api/stock/:stockId', async (request, reply) => {
    const item = STOCK_MEDIA.find((entry) => entry.id === request.params.stockId);
    if (!item) return reply.code(404).send({ error: 'Stok medya bulunamadı' });
    const file = path.join(stockDir, item.fileName);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Stok medya dosyası bulunamadı' });
    const stat = await fsp.stat(file);
    return reply.header('Content-Type', item.mimeType).header('Content-Length', stat.size).send(fs.createReadStream(file));
  });

  app.get('/api/projects', async () => listProjects());
  app.get('/api/trash', async () => listTrash());

  app.post<{ Params: { trashId: string } }>('/api/trash/:trashId/restore', async (request, reply) => {
    try {
      const source = trashPath(request.params.trashId);
      const project = ProjectSchema.parse(JSON.parse(await fsp.readFile(path.join(source, 'project.json'), 'utf8')));
      const target = projectPath(project.id);
      if (fs.existsSync(target)) return reply.code(409).send({ error: 'Bu proje zaten mevcut' });
      await ensureDir(projectsDir);
      await fsp.rename(source, target);
      return reply.send(project);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 404;
      return reply.code(statusCode === 400 ? 400 : 404).send({ error: error instanceof Error ? error.message : 'Proje geri yüklenemedi' });
    }
  });

  app.delete<{ Params: { trashId: string } }>('/api/trash/:trashId', async (request, reply) => {
    try {
      const target = trashPath(request.params.trashId);
      if (!fs.existsSync(target)) return reply.code(404).send({ error: 'Çöp kutusu kaydı bulunamadı' });
      await fsp.rm(target, { recursive: true, force: false });
      return reply.send({ ok: true });
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 400 ? 400 : 404).send({ error: error instanceof Error ? error.message : 'Çöp kutusu kaydı silinemedi' });
    }
  });

  app.post<{ Body: { name?: string } }>('/api/projects', async (request, reply) => {
    const project = defaultProject(id('project'), request.body?.name?.trim() || 'Yeni proje');
    await ensureProjectFolders(project.id);
    await saveProject(project);
    return reply.code(201).send(project);
  });

  app.post<{ Params: { projectId: string }; Body: { stockId?: string } }>('/api/projects/:projectId/stock', async (request, reply) => {
    const item = STOCK_MEDIA.find((entry) => entry.id === request.body?.stockId);
    if (!item) return reply.code(400).send({ error: 'Geçersiz stok medya' });
    try {
      const project = await readProject(request.params.projectId);
      const source = path.join(stockDir, item.fileName);
      if (!fs.existsSync(source)) return reply.code(404).send({ error: 'Stok medya dosyası bulunamadı' });
      const assetId = id('asset');
      const relativePath = path.join('media', `${assetId}.png`);
      const target = safeJoin(projectPath(project.id), relativePath);
      await ensureDir(path.dirname(target));
      await fsp.copyFile(source, target);
      const stat = await fsp.stat(target);
      const asset: Asset = {
        id: assetId,
        name: item.name,
        type: 'image',
        mimeType: item.mimeType,
        path: relativePath,
        size: stat.size,
        duration: 5,
        width: item.width,
        height: item.height,
        hasAudio: false,
        createdAt: new Date().toISOString(),
      };
      const next = await withProjectLock(project.id, async () => {
        const current = await readProject(project.id);
        const updated = ProjectSchema.parse({ ...current, assets: [...current.assets, asset], updatedAt: new Date().toISOString(), revision: current.revision + 1, duration: Math.max(current.duration, asset.duration) });
        await saveProject(updated);
        return updated;
      });
      return reply.code(201).send({ asset, project: next });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Stok medya eklenemedi' });
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    try { return await readProject(request.params.projectId); }
    catch { return reply.code(404).send({ error: 'Proje bulunamadı' }); }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/backups', async (request, reply) => {
    try {
      await readProject(request.params.projectId);
      return listBackups(request.params.projectId);
    } catch {
      return reply.code(404).send({ error: 'Proje bulunamadı' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { fileName?: string } }>('/api/projects/:projectId/restore', async (request, reply) => {
    const requestedFileName = String(request.body?.fileName ?? '');
    const fileName = path.basename(requestedFileName);
    if (!requestedFileName || fileName !== requestedFileName || !/^project-\d+\.json$/i.test(fileName)) return reply.code(400).send({ error: 'Geçersiz backup dosyası' });
    try {
      const restored = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        const backupPath = safeExistingPath(path.join(projectPath(request.params.projectId), 'backups'), fileName);
        if (!fs.existsSync(backupPath)) throw Object.assign(new Error('Backup bulunamadı'), { statusCode: 404 });
        const backup = ProjectSchema.parse(JSON.parse(await fsp.readFile(backupPath, 'utf8')));
        if (backup.id !== current.id) throw Object.assign(new Error('Backup başka bir projeye ait'), { statusCode: 400 });
        const next = ProjectSchema.parse({ ...backup, id: current.id, revision: current.revision + 1, updatedAt: new Date().toISOString() });
        await saveProject(next);
        return next;
      });
      return reply.send(restored);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
      return reply.code(statusCode === 404 ? 404 : 400).send({ error: error instanceof Error ? error.message : 'Backup geri yüklenemedi' });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: Partial<Project> & { revision?: number } }>('/api/projects/:projectId', async (request, reply) => {
    try {
      const next = await withProjectLock(request.params.projectId, async () => {
        const current = await readProject(request.params.projectId);
        if (request.body.revision !== undefined && request.body.revision !== current.revision) throw Object.assign(new Error('Proje başka bir sürümde değişti'), { statusCode: 409, project: current });
        const updated = ProjectSchema.parse({ ...current, ...request.body, id: current.id, schemaVersion: 1, revision: current.revision + 1, updatedAt: new Date().toISOString() });
        await saveProject(updated);
        return updated;
      });
      return next;
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && Number(error.statusCode) === 409 ? 409 : 400;
      const conflictProject = statusCode === 409 && typeof error === 'object' && error !== null && 'project' in error ? error.project : undefined;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Proje kaydedilemedi', ...(conflictProject ? { project: conflictProject } : {}) });
    }
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/duplicate', async (request, reply) => {
    try {
      const original = await readProject(request.params.projectId);
      const copy = ProjectSchema.parse({ ...original, id: id('project'), name: `${original.name} kopya`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 });
      await copyProjectFolder(original.id, copy.id);
      await saveProject(copy);
      return reply.code(201).send(copy);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return reply.code(404).send({ error: 'Proje bulunamadı' });
      return reply.code(400).send({ error: 'Proje kopyalanamadı' });
    }
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const target = projectPath(request.params.projectId);
    if (!fs.existsSync(target)) return reply.code(404).send({ error: 'Proje bulunamadı' });
    const trash = path.join(dataDir, 'trash', `${request.params.projectId}-${Date.now()}`);
    await ensureDir(path.dirname(trash));
    await fsp.rename(target, trash);
    return { ok: true, trashId: path.basename(trash) };
  });

  app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/media', async (request, reply) => {
    const project = await readProject(request.params.projectId);
    let part: Awaited<ReturnType<FastifyRequest['file']>> | undefined;
    try {
      part = await request.file();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      return reply.code(code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400).send({ error: code === 'FST_REQ_FILE_TOO_LARGE' ? 'Dosya boyutu izin verilen sınırı aşıyor.' : 'Dosya okunamadı.' });
    }
    if (!part) return reply.code(400).send({ error: 'Dosya gönderilmedi' });
    const extension = extensionFor(part.filename);
    const mimeType = String(part.mimetype || '').toLowerCase();
    const imageExtension = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(extension);
    const audioExtension = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(extension);
    const videoExtension = /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(extension);
    const supportedMime = mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/');
    if (!supportedMime && !imageExtension && !audioExtension && !videoExtension) {
      return reply.code(415).send({ error: 'Bu medya türü desteklenmiyor' });
    }
    const assetId = id('asset');
    const storedName = `${assetId}${extension}`;
    const relativePath = path.join('media', storedName);
    const absolutePath = safeJoin(projectPath(project.id), relativePath);
    await ensureDir(path.dirname(absolutePath));
    try {
      await pipeline(part.file, fs.createWriteStream(absolutePath));
    } catch {
      await fsp.rm(absolutePath, { force: true });
      return reply.code(400).send({ error: 'Medya yüklemesi tamamlanamadı' });
    }
    const stat = await fsp.stat(absolutePath);
    const probed = await probeMedia(absolutePath);
    const isImage = mimeType.startsWith('image/') || imageExtension;
    const isAudio = mimeType.startsWith('audio/') || audioExtension || (!probed.width && !probed.height && Boolean(probed.hasAudio));
    const asset: Asset = {
      id: assetId,
      name: part.filename,
      type: isImage ? 'image' : isAudio ? 'audio' : 'video',
      mimeType: mimeType || mime.getType(extension) || 'application/octet-stream',
      path: relativePath,
      size: stat.size,
      duration: Number(probed.duration ?? 0),
      width: Number(probed.width ?? 0) || undefined,
      height: Number(probed.height ?? 0) || undefined,
      fps: Number(probed.fps ?? 0) || undefined,
      hasAudio: Boolean(probed.hasAudio ?? isAudio),
      createdAt: new Date().toISOString(),
    };
    const next = await withProjectLock(project.id, async () => {
      const current = await readProject(project.id);
      const updated = ProjectSchema.parse({ ...current, assets: [...current.assets, asset], updatedAt: new Date().toISOString(), revision: current.revision + 1, duration: Math.max(current.duration, asset.duration) });
      await saveProject(updated);
      return updated;
    });
    if (activeJobCount() >= maxConcurrentJobs) return reply.code(429).send({ error: 'Aynı anda çok fazla iş çalışıyor. Mevcut işler tamamlanınca tekrar deneyin.' });
    const job = await makeJob(project.id, 'proxy', async (jobInfo) => {
      updateJob(jobInfo.id, { status: 'running', message: 'Medya hazırlanıyor' });
      const proxyDir = path.join(projectPath(project.id), 'proxies');
      await ensureDir(proxyDir);
      if (binaryPath('ffmpeg')) {
        const proxyPath = path.join(proxyDir, `${asset.id}.mp4`);
        const thumbnailPath = path.join(projectPath(project.id), 'thumbnails', `${asset.id}.jpg`);
        const waveformPath = path.join(projectPath(project.id), 'waveforms', `${asset.id}.png`);
        jobProgressDuration.set(jobInfo.id, asset.duration || 1);
        let proxyRelative: string | undefined;
        let thumbnailRelative: string | undefined;
        let waveformRelative: string | undefined;
        if (asset.type === 'video') {
          await runFfmpeg(['-i', absolutePath, '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '128k', proxyPath], jobInfo);
          proxyRelative = path.relative(projectPath(project.id), proxyPath);
        }
        if (asset.type === 'video' || asset.type === 'image') {
          await runFfmpeg(['-ss', asset.type === 'video' ? '0.2' : '0', '-i', absolutePath, '-frames:v', '1', '-vf', 'scale=480:-2', thumbnailPath], jobInfo);
          thumbnailRelative = path.relative(projectPath(project.id), thumbnailPath);
        }
        if (asset.hasAudio || asset.type === 'audio') {
          await runFfmpeg(['-i', absolutePath, '-filter_complex', 'showwavespic=s=900x120:colors=80e6c4:scale=sqrt', '-frames:v', '1', waveformPath], jobInfo);
          waveformRelative = path.relative(projectPath(project.id), waveformPath);
        }
        await withProjectLock(project.id, async () => {
          const updated = await readProject(project.id);
          const index = updated.assets.findIndex((item) => item.id === asset.id);
          if (index >= 0) updated.assets[index] = { ...updated.assets[index], proxyPath: proxyRelative, thumbnailPath: thumbnailRelative, waveformPath: waveformRelative };
          await saveProject(ProjectSchema.parse({ ...updated, revision: updated.revision + 1, updatedAt: new Date().toISOString() }));
        });
      }
      updateJob(jobInfo.id, { status: 'completed', progress: 1, message: 'Medya hazır' });
    });
    return reply.code(201).send({ asset, job, project: next });
  });

  app.get<{ Params: { projectId: string; assetId: string }; Querystring: { proxy?: string; waveform?: string; thumbnail?: string } }>('/api/projects/:projectId/media/:assetId', async (request, reply) => {
    const project = await readProject(request.params.projectId);
    const asset = project.assets.find((item) => item.id === request.params.assetId);
    if (!asset) return reply.code(404).send({ error: 'Medya bulunamadı' });
    let file = assetFile(project.id, asset);
    if (request.query.proxy === '1' && asset.proxyPath) file = safeExistingPath(projectPath(project.id), asset.proxyPath);
    if (request.query.waveform === '1' && asset.waveformPath) file = safeExistingPath(projectPath(project.id), asset.waveformPath);
    if (request.query.thumbnail === '1' && asset.thumbnailPath) file = safeExistingPath(projectPath(project.id), asset.thumbnailPath);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Medya dosyası bulunamadı' });
    const stat = await fsp.stat(file);
    const range = request.headers.range;
    const contentType = request.query.waveform === '1' || request.query.thumbnail === '1' ? 'image/png' : asset.mimeType || 'application/octet-stream';
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
    let project: Project;
    try { project = await readProject(request.params.projectId); }
    catch { return reply.code(404).send({ error: 'Proje bulunamadı' }); }
    const exportDir = path.join(projectPath(project.id), 'exports');
    await ensureDir(exportDir);
    try {
      const options = normalizeExportOptions(project, request.body ?? {});
      return exportPreflight(project, options, exportDir);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Export ayarları geçersiz' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: ExportRequest }>('/api/projects/:projectId/export', async (request, reply) => {
    let project: Project;
    try {
      project = await readProject(request.params.projectId);
    } catch {
      return reply.code(404).send({ error: 'Proje bulunamadı' });
    }
    const exportDir = path.join(projectPath(project.id), 'exports');
    await ensureDir(exportDir);
    let options: ExportOptions;
    try { options = normalizeExportOptions(project, request.body ?? {}); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Export ayarları geçersiz' }); }
    const preflight = await exportPreflight(project, options, exportDir);
    if (!preflight.ok) return reply.code(400).send({ error: preflight.errors.map((item) => item.message).join(' '), preflight });
    const extension = options.format === 'wav' ? 'wav' : options.format === 'mp3' ? 'mp3' : 'mp4';
    const fileName = safeExportName(project, options.fileName, extension);
    const output = uniqueOutputPath(exportDir, fileName);
    const audioOnly = options.format === 'mp3' || options.format === 'wav';
    let render: ReturnType<typeof buildExportArgs>;
    try {
      render = buildExportArgs(project, options, output);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Export hazırlanamadı' });
    }
    if (activeJobCount() >= maxConcurrentJobs) return reply.code(429).send({ error: 'Aynı anda çok fazla iş çalışıyor. Mevcut işler tamamlanınca tekrar deneyin.' });
    const job = await makeJob(project.id, 'export', async (jobInfo) => {
      updateJob(jobInfo.id, { status: 'running', message: audioOnly ? 'Ses dışa aktarılıyor' : 'Video dışa aktarılıyor' });
      jobProgressDuration.set(jobInfo.id, render.duration);
      await runFfmpeg(render.args, jobInfo, output);
      jobProgressDuration.delete(jobInfo.id);
      updateJob(jobInfo.id, { absoluteOutputPath: output, relativeOutputPath: path.relative(projectPath(project.id), output), fileName, format: options.format, phase: 'complete' });
      updateJob(jobInfo.id, { status: 'completed', progress: 1, outputPath: path.relative(rootDir, output), message: 'Export tamamlandı' });
    });
    updateJob(job.id, { fileName, format: options.format, outputPath: path.relative(rootDir, output), absoluteOutputPath: output, relativeOutputPath: path.relative(projectPath(project.id), output), phase: 'queued' });
    return reply.code(202).send({ job, preflight });
  });

  app.get('/api/jobs', async () => Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  app.delete<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (request, reply) => {
    if (!jobs.has(request.params.jobId)) return reply.code(404).send({ error: 'İş bulunamadı' });
    const process = jobProcesses.get(request.params.jobId);
    if (process) process.kill();
    updateJob(request.params.jobId, { status: 'cancelled', message: 'İptal edildi' });
    return reply.send({ ok: true });
  });

  app.get('/api/events', async (request, reply) => {
    if (clients.size >= maxSseClients) return reply.code(429).send({ error: 'Çok fazla ilerleme bağlantısı açık' });
    const origin = request.headers.origin;
    const allowedOrigins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
    reply.hijack();
    const headers: Record<string, string> = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
    if (origin && allowedOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
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
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') && !isAllowedLocalRequest(request)) {
      return reply.code(403).send({ error: 'Yalnızca yerel istemciye izin verilir' });
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

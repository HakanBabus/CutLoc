#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { ProjectSchema, type Clip, type Project, type ProjectAccessLease, type Track } from '@cutloc/shared';

type JsonObject = Record<string, unknown>;
type LeaseHandle = { lease: ProjectAccessLease; token: string };

const help = `CutLoc CLI — local editor control for people and AI tools

Usage:
  cutloc [--url http://127.0.0.1:4173] <command>

Projects:
  projects list | create [name] [--preset shorts] [--aspect <aspect>] [--fps <fps>]
  projects get <id> [--out <json>] | apply <id> (--file <json> | --stdin)
  projects edit <id> (--file <plan.json> | --stdin) [--dry-run] [--include-project]
  projects duplicate <id> | delete <id> | bundle <id> --out <file>
  projects import <file>

Media and recovery:
  media add <project-id> <file> [--wait] [--include-project]
  media add-many <project-id> <files...> [--wait] [--include-project]
  media remove <project-id> <asset-id>
  media relink <project-id> <asset-id> <file> | rebuild <project-id> <asset-id>
  media health <project-id> | stock <project-id> <stock-id>
  backups list <project-id> | restore <project-id> <file-name>
  trash list | restore <trash-id> | delete <trash-id>

Export and settings:
  export preflight|start <project-id> [--file <options.json>]
  jobs list | get <job-id> | wait <job-id> [--timeout <seconds>] [--interval <seconds>]
  jobs watch <job-id> [--timeout <seconds>] [--interval <seconds>]
  jobs cancel <job-id> | download <job-id> --out <file>
  preview frame <project-id> --time <seconds> --out <png>
  settings get | set (--file <json> | --stdin)

Agent access:
  agent guide | inspect [project-id] [--full] [--limit <n>] [--cursor <n>] [--no-guide]
    Returns machine-readable capabilities, safety rules, and an optional live
    project snapshot so an AI agent can choose the right command safely.
  session <project-id>
    Holds exclusive project access until stdin closes. Send one JSON request per
    line: {"method":"PATCH","path":"/api/projects/<id>","body":{...}}
  api <method> <api-path> [--file <json>] [--data <json>] [--out <file>]
    Low-level JSON API access. Project paths are locked automatically for
    mutating methods. Use the dedicated media/import commands for uploads.

All successful structured output is JSON. Use --compact for one-line output.`;

const agentGuide = {
  protocolVersion: 1,
  product: 'CutLoc',
  transport: {
    baseUrl: 'http://127.0.0.1:4173',
    boundary: 'loopback-only',
    output: 'Successful commands write JSON to stdout; errors write one JSON object to stderr.',
    compactFlag: '--compact',
  },
  recommendedWorkflow: [
    'Run agent inspect to verify the server and discover a compact page of project IDs.',
    'Run projects get <id> --out <file> immediately before editing.',
    'Prefer projects edit <id> --file <plan> --dry-run for atomic timeline changes.',
    'Use projects apply only for complete-document replacement; on a revision conflict, fetch again and reconcile.',
    'Run export preflight <id> before export start <id>.',
    'Use session <id> for several related API operations that need one exclusive lease.',
  ],
  safetyRules: [
    'Never edit data/projects/.../project.json directly.',
    'Use media commands for binary uploads and relinks.',
    'Treat projects delete, media remove, backup restore, and trash delete as destructive.',
    'A mutating project command temporarily makes that project read-only in the web editor.',
    'Do not retry a revision conflict by discarding the newer server project.',
    'Generic api and session commands do not stream /api/events.',
  ],
  projectEditing: {
    schemaVersion: 1,
    mutableAreas: ['name', 'canvas', 'tracks', 'clips', 'markers'],
    clipCapabilities: ['trim', 'timing', 'layout', 'crop', 'speed', 'speed points', 'audio', 'filters', 'mask', 'fade', 'transition', 'keyframes', 'text styling'],
    managedAreas: ['id', 'revision', 'updatedAt', 'asset file paths', 'derived media paths'],
    invariants: ['unique IDs', 'valid asset references', 'source ranges within media duration', 'keyframe and speed-point times within clip duration', 'timeline duration derived from clips'],
  },
  commands: {
    discovery: ['agent guide', 'agent inspect [project-id] [--full] [--limit <n>] [--cursor <n>] [--no-guide]', 'projects list', 'projects get <id>', 'media health <project-id>', 'backups list <project-id>', 'jobs list', 'settings get'],
    projects: ['projects create [name] [--preset shorts]', 'projects edit <id> (--file <plan> | --stdin | --data <json>) [--dry-run]', 'projects apply <id> (--file <json> | --stdin | --data <json>)', 'projects duplicate <id>', 'projects bundle <id> --out <file>', 'projects import <file>', 'projects delete <id>'],
    media: ['media add <project-id> <file> [--wait]', 'media add-many <project-id> <files...> [--wait]', 'media relink <project-id> <asset-id> <file>', 'media rebuild <project-id> <asset-id>', 'media stock <project-id> <stock-id>', 'media remove <project-id> <asset-id>'],
    recovery: ['backups restore <project-id> <file-name>', 'trash list', 'trash restore <trash-id>', 'trash delete <trash-id>'],
    export: ['export preflight <project-id> [--file <options.json>]', 'export start <project-id> [--file <options.json>]', 'jobs wait <job-id>', 'jobs watch <job-id>', 'jobs cancel <job-id>', 'jobs download <job-id> --out <file>'],
    advanced: ['preview frame <project-id> --time <seconds> --out <png>', 'session <project-id>', 'api <method> <api-path> [--file <json> | --data <json> | --out <file>]', 'settings set (--file <json> | --stdin | --data <json>)'],
  },
  examples: [
    'agent inspect',
    'projects get <project-id> --out project.json',
    'projects apply <project-id> --file project.json',
    'export preflight <project-id> --data {"format":"mp4","resolution":"1080p","fps":30,"quality":"standard"}',
  ],
} as const;

function takeFlag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeBooleanFlag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function requireArg(value: string | undefined, description: string) {
  if (!value || value.startsWith('--')) throw new Error(`${description} is required.`);
  return value;
}

function ensureNoArgs(commandArgs: string[]) {
  if (commandArgs.length) throw new Error(`Unexpected argument: ${commandArgs[0]}`);
}

function ensureNoOptionArgs(commandArgs: string[]) {
  const option = commandArgs.find((argument) => argument.startsWith('--'));
  if (option) throw new Error(`Unexpected argument: ${option}`);
}

function positiveNumber(value: string | undefined, name: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function nonNegativeNumber(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}

const args = process.argv.slice(2);
let compact = false;
let parsedBaseUrl!: URL;

function initialize() {
  const baseUrl = takeFlag(args, '--url') ?? process.env.CUTLOC_URL ?? 'http://127.0.0.1:4173';
  compact = takeBooleanFlag(args, '--compact');
  parsedBaseUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) throw new Error('CutLoc CLI only connects to HTTP(S) loopback servers.');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedBaseUrl.hostname)) throw new Error('CutLoc CLI only connects to a loopback server.');
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

async function writeJsonFile(fileName: string, value: unknown) {
  const absolute = path.resolve(fileName);
  await fsp.writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { ok: true, file: absolute };
}

function apiUrl(apiPath: string) {
  if (!apiPath.startsWith('/api/')) throw new Error('API paths must start with /api/.');
  return new URL(apiPath, parsedBaseUrl).toString();
}

async function request(apiPath: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (token) headers.set('x-cutloc-access-token', token);
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(apiUrl(apiPath), { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : `${response.status} ${response.statusText}`;
    throw Object.assign(new Error(message), { status: response.status, body });
  }
  return response;
}

async function jsonRequest(apiPath: string, method = 'GET', body?: unknown, token?: string) {
  const response = await request(apiPath, { method, body: body === undefined ? undefined : JSON.stringify(body) }, token);
  if (response.status === 204) return null;
  return response.json();
}

async function readJsonInput(commandArgs: string[], optional = false) {
  const file = takeFlag(commandArgs, '--file');
  const data = takeFlag(commandArgs, '--data');
  const stdin = takeBooleanFlag(commandArgs, '--stdin');
  const selected = Number(Boolean(file)) + Number(Boolean(data)) + Number(stdin);
  if (selected > 1) throw new Error('Use only one of --file, --data, or --stdin.');
  if (file) return JSON.parse((await fsp.readFile(path.resolve(file), 'utf8')).replace(/^\uFEFF/, '')) as unknown;
  if (data) return JSON.parse(data) as unknown;
  if (stdin) {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
  }
  if (optional) return {};
  throw new Error('Provide JSON with --file, --data, or --stdin.');
}

async function acquire(projectId: string): Promise<LeaseHandle> {
  const ownerId = `cli_${process.pid}_${crypto.randomUUID().slice(0, 12)}`;
  return jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/access`, 'POST', {
    ownerId,
    ownerLabel: `${os.hostname()} · CutLoc CLI (${process.pid})`,
    client: 'cli',
    ttlMs: 15_000,
    force: false,
  }) as Promise<LeaseHandle>;
}

async function release(projectId: string, token: string) {
  await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/access`, 'DELETE', undefined, token).catch(() => undefined);
}

async function withProjectAccess<T>(projectId: string, task: (token: string) => Promise<T>) {
  const handle = await acquire(projectId);
  const heartbeat = setInterval(() => {
    void jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/access`, 'PATCH', { ttlMs: 15_000 }, handle.token).catch(() => undefined);
  }, 5_000);
  heartbeat.unref();
  try {
    return await task(handle.token);
  } finally {
    clearInterval(heartbeat);
    await release(projectId, handle.token);
  }
}

function projectIdFromPath(apiPath: string) {
  const pathname = new URL(apiPath, parsedBaseUrl).pathname;
  return pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
}

function isAccessPath(apiPath: string) {
  return /^\/api\/projects\/[A-Za-z0-9_-]+\/access$/.test(new URL(apiPath, parsedBaseUrl).pathname);
}

function isMutation(method: string) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

async function upload(apiPath: string, filePath: string, token: string) {
  const absolute = path.resolve(filePath);
  const bytes = await fsp.readFile(absolute);
  const form = new FormData();
  form.append('file', new Blob([bytes]), path.basename(absolute));
  return (await request(apiPath, { method: 'POST', body: form }, token)).json();
}

type JobView = { id: string; projectId?: string; status: string; progress?: number; phase?: string; [key: string]: unknown };
const terminalJobStatuses = new Set(['completed', 'failed', 'cancelled']);

async function waitForJob(jobId: string, timeoutSeconds: number, intervalSeconds: number, onUpdate?: (job: JobView) => void) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previousSignature = '';
  while (true) {
    const job = await jsonRequest(`/api/jobs/${encodeURIComponent(jobId)}`) as JobView;
    const signature = `${job.status}:${job.phase ?? ''}:${job.progress ?? ''}`;
    if (signature !== previousSignature) onUpdate?.(job);
    previousSignature = signature;
    if (terminalJobStatuses.has(job.status)) return job;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for job ${jobId} after ${timeoutSeconds} seconds.`);
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

type MediaMutation = {
  asset?: { id?: string; name?: string; [key: string]: unknown };
  job?: JobView;
  project?: Project;
  warning?: unknown;
};

async function mediaMutationResult(projectId: string, result: MediaMutation, wait: boolean, includeProject: boolean) {
  let project = result.project;
  let job = result.job;
  if (wait && job?.id) {
    job = await waitForJob(job.id, 300, 0.25);
    project = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`) as Project;
  }
  const finalAsset = project?.assets.find((asset) => asset.id === result.asset?.id) ?? result.asset;
  return {
    ok: true,
    asset: finalAsset,
    ...(job ? { job } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    revision: project?.revision,
    ...(wait ? { stable: Boolean(job && job.status === 'completed'), finalRevision: project?.revision } : {}),
    ...(includeProject ? { project } : {}),
  };
}

type EditOperation =
  | { op: 'setName'; name: string }
  | { op: 'setCanvas'; canvas: Partial<Project['canvas']> }
  | { op: 'addTrack'; track: Track }
  | { op: 'removeTrack'; trackId: string }
  | { op: 'addClip'; trackId: string; clip: Clip }
  | { op: 'updateClip'; trackId: string; clipId: string; patch: Partial<Clip> }
  | { op: 'removeClip'; trackId: string; clipId: string }
  | { op: 'addMarker'; marker: Project['markers'][number] }
  | { op: 'removeMarker'; markerId: string };

function applyEditPlan(current: Project, input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('Edit plan must be a JSON object.');
  const plan = input as { baseRevision?: number; operations?: EditOperation[] };
  if (plan.baseRevision !== undefined && plan.baseRevision !== current.revision) {
    throw Object.assign(new Error(`Edit plan revision ${plan.baseRevision} does not match current revision ${current.revision}.`), { status: 409 });
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) throw new Error('Edit plan requires a non-empty operations array.');
  const project = structuredClone(current);
  for (const operation of plan.operations) {
    if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') throw new Error('Each edit operation requires an op value.');
    if (operation.op === 'setName') project.name = requireArg(operation.name, 'project name');
    else if (operation.op === 'setCanvas') project.canvas = { ...project.canvas, ...operation.canvas };
    else if (operation.op === 'addTrack') project.tracks.push(operation.track);
    else if (operation.op === 'removeTrack') project.tracks = project.tracks.filter((track) => track.id !== operation.trackId);
    else if (operation.op === 'addClip') {
      const track = project.tracks.find((item) => item.id === operation.trackId);
      if (!track) throw new Error(`Track not found: ${operation.trackId}`);
      track.clips.push(operation.clip);
    } else if (operation.op === 'updateClip') {
      const track = project.tracks.find((item) => item.id === operation.trackId);
      const clip = track?.clips.find((item) => item.id === operation.clipId);
      if (!clip) throw new Error(`Clip not found: ${operation.trackId}/${operation.clipId}`);
      Object.assign(clip, operation.patch, { id: clip.id });
    } else if (operation.op === 'removeClip') {
      const track = project.tracks.find((item) => item.id === operation.trackId);
      if (!track) throw new Error(`Track not found: ${operation.trackId}`);
      track.clips = track.clips.filter((clip) => clip.id !== operation.clipId);
    } else if (operation.op === 'addMarker') project.markers.push(operation.marker);
    else if (operation.op === 'removeMarker') project.markers = project.markers.filter((marker) => marker.id !== operation.markerId);
    else throw new Error(`Unsupported edit operation: ${(operation as { op: string }).op}`);
  }
  project.duration = project.tracks.reduce((maximum, track) => track.clips.reduce((trackMaximum, clip) => Math.max(trackMaximum, clip.start + clip.duration), maximum), 0);
  return ProjectSchema.parse(project);
}

function projectSummary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    revision: project.revision,
    duration: project.duration,
    canvas: project.canvas,
    assetCount: project.assets.length,
    trackCount: project.tracks.length,
    clipCount: project.tracks.reduce((total, track) => total + track.clips.length, 0),
  };
}

async function runSession(projectId: string) {
  const handle = await acquire(projectId);
  const heartbeat = setInterval(() => {
    void jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/access`, 'PATCH', { ttlMs: 15_000 }, handle.token).catch((error) => {
      process.stderr.write(`CutLoc session heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, 5_000);
  heartbeat.unref();
  print({ ready: true, projectId, lease: handle.lease });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const operation = JSON.parse(line) as { method?: string; path?: string; body?: unknown };
        const method = String(operation.method ?? 'GET').toUpperCase();
        const apiPath = requireArg(typeof operation.path === 'string' ? operation.path : undefined, 'session request path');
        const targetProject = projectIdFromPath(apiPath);
        if (targetProject && targetProject !== projectId) throw new Error('A session may only access its locked project.');
        if (isAccessPath(apiPath)) throw new Error('The session manages its own access lease.');
        if (new URL(apiPath, parsedBaseUrl).pathname === '/api/events') throw new Error('SSE streams are not supported in session mode.');
        print({ ok: true, result: await jsonRequest(apiPath, method, operation.body, handle.token) });
      } catch (error) {
        print({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    clearInterval(heartbeat);
    await release(projectId, handle.token);
  }
}

async function main() {
  initialize();
  const group = args.shift();
  if (!group || group === 'help' || group === '--help' || group === '-h') {
    process.stdout.write(`${help}\n`);
    return;
  }

  if (group === 'session') {
    const projectId = requireArg(args.shift(), 'session project ID');
    ensureNoArgs(args);
    await runSession(projectId);
    return;
  }

  if (group === 'api') {
    const method = requireArg(args.shift(), 'api method').toUpperCase();
    const apiPath = requireArg(args.shift(), 'api path');
    if (new URL(apiPath, parsedBaseUrl).pathname === '/api/events') throw new Error('SSE streams are not supported by the api command.');
    const out = takeFlag(args, '--out');
    const body = isMutation(method) ? await readJsonInput(args, true) : undefined;
    ensureNoArgs(args);
    const projectId = projectIdFromPath(apiPath);
    const execute = async (token?: string) => {
      const response = await request(apiPath, { method, body: body === undefined ? undefined : JSON.stringify(body) }, token);
      if (out) {
        const absolute = path.resolve(out);
        await fsp.writeFile(absolute, new Uint8Array(await response.arrayBuffer()));
        return { ok: true, file: absolute };
      }
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('This endpoint returns binary data; use --out or a dedicated CLI command.');
      return response.json();
    };
    print(projectId && isMutation(method) && !isAccessPath(apiPath) ? await withProjectAccess(projectId, execute) : await execute());
    return;
  }

  const action = args.shift();
  if (group === 'agent') {
    if (action === 'guide') {
      ensureNoArgs(args);
      return print(agentGuide);
    }
    if (action === 'inspect') {
      const full = takeBooleanFlag(args, '--full');
      const noGuide = takeBooleanFlag(args, '--no-guide');
      const limit = Math.min(100, nonNegativeInteger(takeFlag(args, '--limit'), '--limit', 20));
      const cursor = nonNegativeInteger(takeFlag(args, '--cursor'), '--cursor', 0);
      const projectId = args.shift();
      ensureNoArgs(args);
      const [server, settings, projects, jobs] = await Promise.all([
        jsonRequest('/api/health'),
        jsonRequest('/api/settings'),
        jsonRequest('/api/projects'),
        jsonRequest('/api/jobs'),
      ]);
      const selectedProject = projectId ? await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`) : undefined;
      const [mediaHealth, backups] = projectId ? await Promise.all([
        jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/media-health`),
        jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/backups`),
      ]) : [undefined, undefined];
      const projectList = projects as Project[];
      const page = projectList.slice(cursor, cursor + limit);
      const compactProjects = page.map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        duration: project.duration,
        aspect: project.canvas.aspect,
        assetCount: project.assets.length,
      }));
      const jobList = jobs as JobView[];
      const relevantJobs = projectId ? jobList.filter((job) => job.projectId === projectId) : jobList.slice(0, limit);
      return print({
        ok: true,
        ...(!noGuide ? { guide: agentGuide } : {}),
        live: {
          server,
          settings,
          projects: full ? page : compactProjects,
          projectPage: { cursor, limit, returned: page.length, total: projectList.length, nextCursor: cursor + page.length < projectList.length ? cursor + page.length : null },
          jobs: relevantJobs,
          selectedProject,
          mediaHealth,
          backups,
        },
        next: projectId
          ? [`projects get ${projectId} --out project.json`, `projects apply ${projectId} --file project.json`, `export preflight ${projectId} --file export-options.json`]
          : ['Choose a project ID from live.projects, then run agent inspect <project-id>.'],
      });
    }
    throw new Error('agent action must be guide or inspect.');
  }
  if (group === 'projects') {
    if (action === 'list') { ensureNoArgs(args); return print(await jsonRequest('/api/projects')); }
    if (action === 'create') {
      const preset = takeFlag(args, '--preset');
      const aspect = takeFlag(args, '--aspect');
      const fpsRaw = takeFlag(args, '--fps');
      const background = takeFlag(args, '--background');
      ensureNoOptionArgs(args);
      if (preset && preset !== 'shorts') throw new Error('--preset currently supports only shorts.');
      const body = {
        name: args.join(' ') || undefined,
        ...(preset ? { preset } : {}),
        ...(aspect ? { aspect } : {}),
        ...(fpsRaw ? { fps: positiveNumber(fpsRaw, '--fps') } : {}),
        ...(background ? { background } : {}),
      };
      return print(await jsonRequest('/api/projects', 'POST', body));
    }
    if (action === 'get') {
      const projectId = requireArg(args.shift(), 'project ID');
      const out = takeFlag(args, '--out');
      ensureNoArgs(args);
      const project = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`);
      return print(out ? await writeJsonFile(out, project) : project);
    }
    if (action === 'apply') {
      const projectId = requireArg(args.shift(), 'project ID');
      const body = await readJsonInput(args);
      ensureNoArgs(args);
      return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', body, token)));
    }
    if (action === 'edit') {
      const projectId = requireArg(args.shift(), 'project ID');
      const dryRun = takeBooleanFlag(args, '--dry-run');
      const includeProject = takeBooleanFlag(args, '--include-project');
      const plan = await readJsonInput(args);
      ensureNoArgs(args);
      const execute = async (token?: string) => {
        const current = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`) as Project;
        const edited = applyEditPlan(current, plan);
        if (dryRun) return { ok: true, dryRun: true, baseRevision: current.revision, summary: projectSummary(edited), ...(includeProject ? { project: edited } : {}) };
        const saved = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', { ...edited, revision: current.revision }, token) as Project;
        return { ok: true, dryRun: false, baseRevision: current.revision, revision: saved.revision, summary: projectSummary(saved), ...(includeProject ? { project: saved } : {}) };
      };
      return print(dryRun ? await execute() : await withProjectAccess(projectId, execute));
    }
    if (action === 'duplicate' || action === 'delete') {
      const projectId = requireArg(args.shift(), 'project ID');
      ensureNoArgs(args);
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const suffix = action === 'duplicate' ? '/duplicate' : '';
      return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}${suffix}`, method, undefined, token)));
    }
    if (action === 'bundle') {
      const projectId = requireArg(args.shift(), 'project ID');
      const out = takeFlag(args, '--out');
      if (!out) throw new Error('projects bundle requires --out.');
      ensureNoArgs(args);
      const response = await request(`/api/projects/${encodeURIComponent(projectId)}/bundle`);
      const absolute = path.resolve(out);
      await fsp.writeFile(absolute, new Uint8Array(await response.arrayBuffer()));
      return print({ ok: true, file: absolute });
    }
    if (action === 'import') {
      const file = path.resolve(requireArg(args.shift(), 'project bundle file'));
      ensureNoArgs(args);
      const bytes = await fsp.readFile(file);
      const isJson = file.toLocaleLowerCase().endsWith('.json');
      const response = await request('/api/projects/import', {
        method: 'POST',
        headers: { 'content-type': isJson ? 'application/json' : 'application/zip' },
        body: isJson ? bytes.toString('utf8') : bytes,
      });
      return print(await response.json());
    }
  }

  if (group === 'media') {
    const projectId = requireArg(args.shift(), 'project ID');
    if (action === 'health') { ensureNoArgs(args); return print(await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/media-health`)); }
    if (action === 'add') {
      const file = requireArg(args.shift(), 'media file');
      const wait = takeBooleanFlag(args, '--wait');
      const includeProject = takeBooleanFlag(args, '--include-project');
      ensureNoArgs(args);
      const result = await withProjectAccess(projectId, (token) => upload(`/api/projects/${encodeURIComponent(projectId)}/media`, file, token)) as MediaMutation;
      return print(await mediaMutationResult(projectId, result, wait, includeProject));
    }
    if (action === 'add-many') {
      const wait = takeBooleanFlag(args, '--wait');
      const includeProject = takeBooleanFlag(args, '--include-project');
      const files = [...args];
      args.length = 0;
      if (!files.length) throw new Error('media add-many requires at least one media file.');
      const results = [];
      // When --wait is selected, complete each derived-media job before the
      // next upload. This avoids bursting past the server's bounded job queue.
      for (const file of files) {
        const uploaded = await withProjectAccess(projectId, (token) => upload(`/api/projects/${encodeURIComponent(projectId)}/media`, file, token)) as MediaMutation;
        results.push(await mediaMutationResult(projectId, uploaded, wait, includeProject));
      }
      return print({ ok: true, count: results.length, results });
    }
    if (action === 'remove') { const assetId = requireArg(args.shift(), 'asset ID'); ensureNoArgs(args); return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}`, 'DELETE', undefined, token))); }
    if (action === 'relink') { const assetId = requireArg(args.shift(), 'asset ID'); const file = requireArg(args.shift(), 'replacement media file'); ensureNoArgs(args); return print(await withProjectAccess(projectId, (token) => upload(`/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}/relink`, file, token))); }
    if (action === 'rebuild') { const assetId = requireArg(args.shift(), 'asset ID'); ensureNoArgs(args); return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}/rebuild-derived`, 'POST', {}, token))); }
    if (action === 'stock') { const stockId = requireArg(args.shift(), 'stock ID'); ensureNoArgs(args); return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/stock`, 'POST', { stockId }, token))); }
  }

  if (group === 'backups') {
    const projectId = requireArg(args.shift(), 'project ID');
    if (action === 'list') { ensureNoArgs(args); return print(await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/backups`)); }
    if (action === 'restore') { const fileName = requireArg(args.shift(), 'backup file name'); ensureNoArgs(args); return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/restore`, 'POST', { fileName }, token))); }
  }

  if (group === 'export') {
    const projectId = requireArg(args.shift(), 'project ID');
    const body = await readJsonInput(args, true) as JsonObject;
    ensureNoArgs(args);
    if (action !== 'preflight' && action !== 'start') throw new Error('export action must be preflight or start.');
    const suffix = action === 'preflight' ? '/export/preflight' : '/export';
    return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/projects/${encodeURIComponent(projectId)}${suffix}`, 'POST', body, token)));
  }

  if (group === 'jobs') {
    if (action === 'list') { ensureNoArgs(args); return print(await jsonRequest('/api/jobs')); }
    const jobIdValue = requireArg(args.shift(), 'job ID');
    const jobId = encodeURIComponent(jobIdValue);
    if (action === 'get') { ensureNoArgs(args); return print(await jsonRequest(`/api/jobs/${jobId}`)); }
    if (action === 'wait' || action === 'watch') {
      const timeout = positiveNumber(takeFlag(args, '--timeout'), '--timeout', 300);
      const interval = positiveNumber(takeFlag(args, '--interval'), '--interval', 1);
      ensureNoArgs(args);
      const job = await waitForJob(jobIdValue, timeout, interval, action === 'watch' ? (value) => print({ event: 'job', job: value }) : undefined);
      return print(action === 'watch' ? { event: 'terminal', job } : job);
    }
    if (action === 'cancel') {
      ensureNoArgs(args);
      const job = await jsonRequest(`/api/jobs/${jobId}`) as { projectId?: string };
      const projectId = requireArg(job.projectId, 'job project ID');
      return print(await withProjectAccess(projectId, (token) => jsonRequest(`/api/jobs/${jobId}`, 'DELETE', undefined, token)));
    }
    if (action === 'download') {
      const out = takeFlag(args, '--out');
      if (!out) throw new Error('jobs download requires --out.');
      ensureNoArgs(args);
      const response = await request(`/api/jobs/${jobId}/download`);
      const absolute = path.resolve(out);
      await fsp.writeFile(absolute, new Uint8Array(await response.arrayBuffer()));
      return print({ ok: true, file: absolute });
    }
  }

  if (group === 'preview') {
    if (action !== 'frame') throw new Error('preview action must be frame.');
    const projectId = requireArg(args.shift(), 'project ID');
    const time = nonNegativeNumber(takeFlag(args, '--time'), '--time', 0);
    const out = takeFlag(args, '--out');
    if (!out) throw new Error('preview frame requires --out.');
    ensureNoArgs(args);
    const response = await request(`/api/projects/${encodeURIComponent(projectId)}/preview-frame?time=${encodeURIComponent(String(time))}`);
    const absolute = path.resolve(out);
    await fsp.writeFile(absolute, new Uint8Array(await response.arrayBuffer()));
    return print({ ok: true, projectId, time, file: absolute });
  }

  if (group === 'trash') {
    if (action === 'list') { ensureNoArgs(args); return print(await jsonRequest('/api/trash')); }
    const trashId = encodeURIComponent(requireArg(args.shift(), 'trash ID'));
    ensureNoArgs(args);
    if (action === 'restore') return print(await jsonRequest(`/api/trash/${trashId}/restore`, 'POST', {}));
    if (action === 'delete') return print(await jsonRequest(`/api/trash/${trashId}`, 'DELETE'));
  }

  if (group === 'settings') {
    if (action === 'get') { ensureNoArgs(args); return print(await jsonRequest('/api/settings')); }
    if (action === 'set') { const body = await readJsonInput(args); ensureNoArgs(args); return print(await jsonRequest('/api/settings', 'PUT', body)); }
  }

  throw new Error(`Unknown command. Run cutloc --help. Received: ${[group, action, ...args].filter(Boolean).join(' ')}`);
}

main().catch((error: unknown) => {
  const detail = error as { message?: string; status?: number; body?: unknown };
  process.stderr.write(`${JSON.stringify({ ok: false, error: detail.message ?? String(error), status: detail.status, detail: detail.body })}\n`);
  process.exitCode = 1;
});

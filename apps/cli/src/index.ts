#!/usr/bin/env node
import crypto from 'node:crypto';
import fs, { createWriteStream, openAsBlob } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  API_PROTOCOL_VERSION,
  CUTLOC_VERSION,
  ensureRuntimeFolders,
  processExists,
  readRuntimeInstance,
  readUserInstallation,
  runtimePaths,
  type RuntimeInstance,
} from '@cutloc/runtime';
import { ProjectSchema, type Clip, type Keyframe, type KeyframeProperty, type Project, type ProjectAccessLease, type Track } from '@cutloc/shared';

type JsonObject = Record<string, unknown>;
type LeaseHandle = { lease: ProjectAccessLease; token: string };

const help = `CutLoc CLI — local editor control for people and AI tools

Usage:
  cutloc [--url http://127.0.0.1:4173] <command>

Runtime:
  open
    Starts the shared local server when needed and opens CutLoc in the browser.
  status [--json]
    Reports server, version, API address, and runtime state without starting it.
  doctor [--json]
    Checks storage, permissions, FFmpeg, server, and CLI/API compatibility.
  stop [--force]
    Stops the shared server without deleting projects or settings.
  restart [--force]
    Restarts the shared server from the currently registered CutLoc installation.

Projects:
  projects list | create [name] [--preset shorts] [--aspect <aspect>] [--fps <fps>]
  projects get <id> [--out <json>] | apply <id> (--file <json> | --data <json> | --stdin)
  projects edit <id> (--file <plan.json> | --data <json> | --stdin) [--dry-run] [--include-project]
  projects duplicate <id> | delete <id> | bundle <id> --out <file>
  projects import <file>

Keyframes:
  keyframes list <project-id> <clip-id> [--property <name>]
  keyframes set <project-id> <clip-id> <property> --time <seconds> --value <number> [--easing <name>]
  keyframes remove <project-id> <clip-id> <keyframe-id>
  keyframes clear <project-id> <clip-id> [--property <name>]

Media and recovery:
  media add <project-id> <file> [--wait] [--include-project]
  media add-many <project-id> <files...> [--wait] [--include-project]
  media remove <project-id> <asset-id>
  media relink <project-id> <asset-id> <file> | rebuild <project-id> <asset-id>
  media health <project-id> | stock <project-id> <stock-id>
  backups list <project-id> | restore <project-id> <file-name>
  trash list | restore <trash-id> | delete <trash-id>

Export and settings:
  export preflight|start <project-id> [--file <options.json> | --data <json>]
  jobs list | get <job-id> | wait <job-id> [--timeout <seconds>] [--interval <seconds>]
  jobs watch <job-id> [--timeout <seconds>] [--interval <seconds>]
  jobs cancel <job-id> | download <job-id> --out <file>
  preview frame <project-id> --time <seconds> --out <png>
  settings get | set (--file <json> | --data <json> | --stdin)

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
  protocolVersion: API_PROTOCOL_VERSION,
  productVersion: CUTLOC_VERSION,
  product: 'CutLoc',
  transport: {
    baseUrl: null as string | null,
    boundary: 'loopback-only',
    discovery: 'Use CutLoc CLI commands; the managed server may start on any available loopback port.',
    output: 'Successful commands write JSON to stdout; errors write one JSON object to stderr.',
    compactFlag: '--compact',
  },
  recommendedWorkflow: [
    'Run cutloc status --json to inspect the shared local runtime without changing it.',
    'Run cutloc agent inspect; live commands start the local server automatically when needed.',
    'Run projects get <id> --out <file> immediately before editing.',
    'Prefer projects edit <id> --file <plan> --dry-run for atomic timeline changes.',
    'Use projects apply only for complete-document replacement; on a revision conflict, fetch again and reconcile.',
    'Run export preflight <id> before export start <id>.',
    'Use session <id> for several related API operations that need one exclusive lease.',
  ],
  safetyRules: [
    'Never search for or edit CutLoc project files directly; use the CLI and local API.',
    'Use media commands for binary uploads and relinks.',
    'Treat projects delete, media remove, backup restore, and trash delete as destructive.',
    'A mutating project command temporarily makes that project read-only in the web editor.',
    'Stop and restart refuse active media and preview work; finish or cancel that work first. Use --force only to close known active editor sessions.',
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
  keyframeEditing: {
    commands: {
      inspect: 'keyframes list <project-id> <clip-id> [--property <name>]',
      createOrUpdate: 'keyframes set <project-id> <clip-id> <property> --time <clip-local-seconds> --value <number> [--easing <name>]',
      remove: 'keyframes remove <project-id> <clip-id> <keyframe-id>',
      clear: 'keyframes clear <project-id> <clip-id> [--property <name>]',
    },
    properties: {
      x: 'horizontal canvas pixels',
      y: 'vertical canvas pixels',
      scale: 'size multiplier; 1 is original size',
      rotation: 'degrees',
      opacity: '0 to 1',
      volume: '0 to 2',
    },
    easing: ['linear', 'ease-in', 'ease-out', 'ease-in-out'],
    rules: ['time is relative to the start of the clip, not the project timeline', 'set is idempotent within the same video frame', 'use list before remove to obtain the generated keyframe ID'],
  },
  commands: {
    runtime: ['open', 'status --json', 'doctor --json', 'stop [--force]', 'restart [--force]'],
    discovery: ['agent guide', 'agent inspect [project-id] [--full] [--limit <n>] [--cursor <n>] [--no-guide]', 'projects list', 'projects get <id>', 'media health <project-id>', 'backups list <project-id>', 'jobs list', 'settings get'],
    projects: ['projects create [name] [--preset shorts]', 'projects edit <id> (--file <plan> | --stdin | --data <json>) [--dry-run]', 'projects apply <id> (--file <json> | --stdin | --data <json>)', 'projects duplicate <id>', 'projects bundle <id> --out <file>', 'projects import <file>', 'projects delete <id>'],
    keyframes: ['keyframes list <project-id> <clip-id> [--property <name>]', 'keyframes set <project-id> <clip-id> <property> --time <seconds> --value <number> [--easing <name>]', 'keyframes remove <project-id> <clip-id> <keyframe-id>', 'keyframes clear <project-id> <clip-id> [--property <name>]'],
    media: ['media add <project-id> <file> [--wait]', 'media add-many <project-id> <files...> [--wait]', 'media relink <project-id> <asset-id> <file>', 'media rebuild <project-id> <asset-id>', 'media stock <project-id> <stock-id>', 'media remove <project-id> <asset-id>'],
    recovery: ['backups restore <project-id> <file-name>', 'trash list', 'trash restore <trash-id>', 'trash delete <trash-id>'],
    export: ['export preflight <project-id> [--file <options.json>]', 'export start <project-id> [--file <options.json>]', 'jobs wait <job-id>', 'jobs watch <job-id>', 'jobs cancel <job-id>', 'jobs download <job-id> --out <file>'],
    advanced: ['preview frame <project-id> --time <seconds> --out <png>', 'session <project-id>', 'api <method> <api-path> [--file <json> | --data <json> | --out <file>]', 'settings set (--file <json> | --stdin | --data <json>)'],
  },
  examples: [
    'status --json',
    'open',
    'agent inspect',
    'projects get <project-id> --out project.json',
    'projects apply <project-id> --file project.json',
    'keyframes set <project-id> <clip-id> x --time 0 --value -600 --easing ease-out',
    'keyframes set <project-id> <clip-id> x --time 0.6 --value 0 --easing ease-out',
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

function finiteNumber(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}

const args = process.argv.slice(2);
let compact = false;
let parsedBaseUrl!: URL;
let endpointWasExplicit = false;
let currentInstance: RuntimeInstance | null = null;
let serverEnsured = false;
const paths = runtimePaths();
const cliFile = fileURLToPath(import.meta.url);
const inferredAppRoot = path.resolve(path.dirname(cliFile), '../../..');
const requireFromRoot = createRequire(path.join(inferredAppRoot, 'package.json'));
const defaultBaseUrl = 'http://127.0.0.1:4173';
const appEnvironmentCache = new Map<string, NodeJS.ProcessEnv>();

type Health = {
  ok?: boolean;
  product?: string;
  version?: string;
  apiVersion?: number;
  port?: number;
  ffmpeg?: boolean;
  ffprobe?: boolean;
  textRendering?: boolean;
  dataDir?: string;
  activeJobs?: number;
  activeLeases?: number;
  activePreviews?: number;
  busy?: boolean;
};

function initialize() {
  const developmentEndpoint = process.env.CUTLOC_DEVELOPMENT_ENDPOINT === '1';
  const configuredHost = developmentEndpoint ? process.env.HOST?.trim() : undefined;
  const configuredPort = developmentEndpoint ? process.env.PORT?.trim() : undefined;
  if (configuredPort !== undefined) {
    const port = Number(configuredPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CutLoc CLI port must be an integer between 1 and 65535.');
  }
  const environmentUrl = configuredHost || configuredPort
    ? `http://${configuredHost === '::1' || configuredHost === '[::1]' ? '[::1]' : configuredHost || '127.0.0.1'}:${configuredPort || '4173'}`
    : undefined;
  const flagUrl = takeFlag(args, '--url');
  const configuredUrl = process.env.CUTLOC_URL?.trim();
  endpointWasExplicit = Boolean(flagUrl || configuredUrl || environmentUrl);
  const baseUrl = flagUrl ?? (configuredUrl || environmentUrl || defaultBaseUrl);
  compact = takeBooleanFlag(args, '--compact');
  parsedBaseUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) throw new Error('CutLoc CLI only connects to HTTP(S) loopback servers.');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedBaseUrl.hostname)) throw new Error('CutLoc CLI only connects to a loopback server.');
  const parsedPort = parsedBaseUrl.port ? Number(parsedBaseUrl.port) : undefined;
  if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) throw new Error('CutLoc CLI port must be an integer between 1 and 65535.');
}

async function probeHealth(baseUrl = parsedBaseUrl, timeoutMs = 1_500): Promise<Health | null> {
  try {
    const response = await fetch(new URL('/api/health', baseUrl), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const health = await response.json() as Health;
    return health.ok ? health : null;
  } catch {
    return null;
  }
}

async function discoverRuntimeEndpoint() {
  const discovered = await readRuntimeInstance(paths);
  if (endpointWasExplicit) {
    currentInstance = discovered && new URL(discovered.apiUrl).origin === parsedBaseUrl.origin ? discovered : null;
    return;
  }
  currentInstance = discovered;
  if (discovered) parsedBaseUrl = new URL(discovered.apiUrl);
}

function healthCompatibilityError(health: Health) {
  if (health.product !== 'CutLoc') return 'The loopback endpoint is not a CutLoc server.';
  if (!health.version?.trim()) return 'The CutLoc server did not report a product version.';
  if (!Number.isInteger(health.apiVersion)) return 'The CutLoc server did not report an API protocol version.';
  if (health.apiVersion !== API_PROTOCOL_VERSION) return `CutLoc CLI/API protocol mismatch: CLI ${API_PROTOCOL_VERSION}, server ${health.apiVersion}.`;
  return null;
}

function assertCompatibleHealth(health: Health) {
  const error = healthCompatibilityError(health);
  if (error) throw new Error(error);
}

function appEnvironment(appRoot: string) {
  const cached = appEnvironmentCache.get(appRoot);
  if (cached) return cached;
  const envFile = path.join(appRoot, '.env');
  let parsed: NodeJS.ProcessEnv = {};
  if (fs.existsSync(envFile)) parsed = parseEnv(fs.readFileSync(envFile, 'utf8'));
  appEnvironmentCache.set(appRoot, parsed);
  return parsed;
}

function configuredValue(name: string, appRoot: string) {
  return process.env[name]?.trim() || appEnvironment(appRoot)[name]?.trim() || undefined;
}

function configuredDataDirectory(appRoot: string) {
  const configured = configuredValue('DATA_DIR', appRoot);
  return path.resolve(appRoot, configured || paths.data);
}

async function configuredInstallation() {
  const installation = await readUserInstallation(paths);
  if (installation && fs.existsSync(installation.serverEntry)) return installation;
  return {
    product: 'CutLoc' as const,
    version: CUTLOC_VERSION,
    appRoot: inferredAppRoot,
    nodePath: process.execPath,
    cliEntry: cliFile,
    serverEntry: path.join(inferredAppRoot, 'apps', 'server', 'dist', 'start.js'),
    configuredAt: new Date(0).toISOString(),
  };
}

async function clearManagedRuntimeMetadata(instance: RuntimeInstance) {
  try {
    const stored = JSON.parse(await fsp.readFile(paths.instanceFile, 'utf8')) as RuntimeInstance;
    if (stored.instanceId === instance.instanceId) await fsp.rm(paths.instanceFile, { force: true });
  } catch { /* already removed or invalid */ }
  try {
    const lock = JSON.parse(await fsp.readFile(paths.lockFile, 'utf8')) as { pid?: number };
    if (lock.pid === instance.pid) await fsp.rm(paths.lockFile, { force: true });
  } catch { /* already removed or invalid */ }
}

async function inspectRuntimeActivity(health: Health) {
  if (Number.isInteger(health.activeJobs) && Number(health.activeJobs) >= 0
    && Number.isInteger(health.activeLeases) && Number(health.activeLeases) >= 0
    && Number.isInteger(health.activePreviews) && Number(health.activePreviews) >= 0) {
    return { known: true, activeJobs: Number(health.activeJobs), activeLeases: Number(health.activeLeases), activePreviews: Number(health.activePreviews) };
  }
  try {
    const jobsResponse = await fetch(new URL('/api/jobs', parsedBaseUrl), { signal: AbortSignal.timeout(1_500) });
    const projectsResponse = await fetch(new URL('/api/projects', parsedBaseUrl), { signal: AbortSignal.timeout(1_500) });
    if (!jobsResponse.ok || !projectsResponse.ok) return { known: false, activeJobs: 0, activeLeases: 0, activePreviews: 0 };
    const jobs = await jobsResponse.json() as Array<{ status?: string }>;
    const projects = await projectsResponse.json() as Array<{ id?: string }>;
    const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
    if (projects.length > 100 || projects.some((project) => typeof project.id !== 'string')) return { known: false, activeJobs, activeLeases: 0, activePreviews: 0 };
    const leases = await Promise.all(projects.map(async (project) => {
      const response = await fetch(new URL(`/api/projects/${encodeURIComponent(project.id!)}/access`, parsedBaseUrl), { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) throw new Error('access state unavailable');
      return await response.json() as { lease?: unknown };
    }));
    // Older servers expose neither preview activity nor a fallback endpoint
    // for it, so jobs and leases alone cannot prove shutdown is safe.
    return { known: false, activeJobs, activeLeases: leases.filter((entry) => entry.lease).length, activePreviews: 0 };
  } catch {
    return { known: false, activeJobs: 0, activeLeases: 0, activePreviews: 0 };
  }
}

async function stopServer(options: { force?: boolean } = {}) {
  await discoverRuntimeEndpoint();
  const health = endpointWasExplicit || currentInstance ? await probeHealth() : null;
  if (!health) {
    currentInstance = null;
    if (!endpointWasExplicit) parsedBaseUrl = new URL(defaultBaseUrl);
    return { ok: true, running: false, stopped: false, apiUrl: null };
  }
  const instance = currentInstance;
  const compatibilityError = healthCompatibilityError(health);
  if (compatibilityError && !(instance && health.product === 'CutLoc')) throw new Error(compatibilityError);
  const activity = await inspectRuntimeActivity(health);
  if (activity.activeJobs > 0) {
    throw new Error(`CutLoc has ${activity.activeJobs} active media job(s). Wait for them or cancel them before stopping.`);
  }
  if (activity.activePreviews > 0) {
    throw new Error(`CutLoc has ${activity.activePreviews} active preview render(s). Wait for them before stopping.`);
  }
  if (!activity.known && !options.force) {
    throw new Error('CutLoc could not verify that the server is idle. Retry with --force only after checking active work.');
  }
  if (activity.activeLeases > 0 && !options.force) {
    throw new Error(`CutLoc has ${activity.activeLeases} active editor session(s). Close them or retry with --force.`);
  }
  let graceful = false;
  try {
    const shutdownUrl = new URL('/api/runtime/shutdown', parsedBaseUrl);
    if (options.force) shutdownUrl.searchParams.set('force', '1');
    const response = await fetch(shutdownUrl, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status === 409) {
      const detail = await response.json().catch(() => null) as { error?: string } | null;
      throw Object.assign(new Error(detail?.error || 'CutLoc is busy and cannot stop safely.'), { code: 'CUTLOC_RUNTIME_BUSY' });
    }
    graceful = response.ok;
  } catch (error) {
    if ((error as { code?: string }).code === 'CUTLOC_RUNTIME_BUSY') throw error;
    /* older managed servers may not expose the shutdown route */
  }

  if (!graceful) {
    if (!instance) throw new Error('The explicit CutLoc server does not support managed shutdown.');
    try {
      process.kill(instance.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const responding = await probeHealth(parsedBaseUrl, 250);
    if (!responding && (!instance || !processExists(instance.pid))) break;
    if (attempt === 49) throw new Error('CutLoc server did not stop within 5 seconds.');
  }
  if (instance) await clearManagedRuntimeMetadata(instance);
  const apiUrl = parsedBaseUrl.origin;
  currentInstance = null;
  serverEnsured = false;
  if (!endpointWasExplicit) parsedBaseUrl = new URL(defaultBaseUrl);
  return { ok: true, running: false, stopped: true, graceful, apiUrl };
}

async function ensureServerAvailable() {
  await discoverRuntimeEndpoint();
  let health = endpointWasExplicit || currentInstance ? await probeHealth() : null;
  if (health) {
    const managedMismatch = !endpointWasExplicit
      && currentInstance
      && health.product === 'CutLoc'
      && (health.version !== CUTLOC_VERSION || health.apiVersion !== API_PROTOCOL_VERSION);
    if (managedMismatch) {
      await stopServer();
      health = null;
    } else {
      assertCompatibleHealth(health);
      serverEnsured = true;
      return { health, started: false };
    }
  }
  if (endpointWasExplicit) throw new Error(`CutLoc server is not reachable at ${parsedBaseUrl.origin}.`);

  const installation = await configuredInstallation();
  if (!fs.existsSync(installation.serverEntry)) {
    throw new Error('CutLoc server build is missing. Run npm.cmd run setup:user from the CutLoc checkout once.');
  }
  await ensureRuntimeFolders(paths);
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    CUTLOC_HOME: paths.home,
    HOST: '127.0.0.1',
    PORT: '0',
    NO_OPEN: '1',
  };
  if (!process.env.DATA_DIR?.trim()) delete childEnvironment.DATA_DIR;
  const logFile = path.join(paths.logs, 'server.log');
  await fsp.appendFile(logFile, `\n[${new Date().toISOString()}] CLI starting CutLoc ${CUTLOC_VERSION}\n`, 'utf8');
  const logHandle = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(installation.nodePath, [installation.serverEntry], {
      cwd: installation.appRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logHandle, logHandle],
      env: childEnvironment,
    });
  } finally {
    fs.closeSync(logHandle);
  }
  const startupState: { error?: Error } = {};
  child.once('error', (error) => { startupState.error = error; });
  child.unref();

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (startupState.error) throw new Error(`CutLoc server could not start: ${startupState.error.message}. See ${logFile}`);
    currentInstance = await readRuntimeInstance(paths);
    if (!currentInstance) continue;
    parsedBaseUrl = new URL(currentInstance.apiUrl);
    health = await probeHealth(parsedBaseUrl, 1_000);
    if (health) {
      assertCompatibleHealth(health);
      serverEnsured = true;
      return { health, started: true };
    }
  }
  throw new Error(`CutLoc server did not become ready within 20 seconds. See ${logFile} and run cutloc doctor --json.`);
}

function openBrowser(url: string) {
  if (process.env.CUTLOC_NO_OPEN === '1') return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
  spawn(command, commandArgs, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

async function runtimeStatus(options: { allowIncompatible?: boolean } = {}) {
  await discoverRuntimeEndpoint();
  const health = endpointWasExplicit || currentInstance ? await probeHealth() : null;
  const compatibilityError = health ? healthCompatibilityError(health) : null;
  if (compatibilityError && !options.allowIncompatible) throw new Error(compatibilityError);
  const installation = await configuredInstallation();
  const configuredDataDir = configuredDataDirectory(installation.appRoot);
  return {
    ok: true,
    running: Boolean(health),
    product: health?.product ?? null,
    version: health?.version ?? currentInstance?.version ?? CUTLOC_VERSION,
    cliVersion: CUTLOC_VERSION,
    apiVersion: health ? health.apiVersion ?? null : API_PROTOCOL_VERSION,
    apiUrl: health ? parsedBaseUrl.origin : null,
    pid: health ? currentInstance?.pid ?? null : null,
    startedAt: health ? currentInstance?.startedAt ?? null : null,
    dataDir: health && currentInstance ? currentInstance.dataDir : configuredDataDir,
    home: paths.home,
    logFile: path.join(paths.logs, 'server.log'),
    compatibilityError,
  };
}

async function runtimeDoctor() {
  await ensureRuntimeFolders(paths);
  const installation = await configuredInstallation();
  const status = await runtimeStatus({ allowIncompatible: true });
  const checks: Array<{ name: string; ok: boolean; severity: 'error' | 'warning'; detail: string }> = [];
  const add = (name: string, ok: boolean, detail: string, severity: 'error' | 'warning' = 'error') => checks.push({ name, ok, severity, detail });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor === 24, `${process.versions.node} (required: 24.x)`);
  add('installation', fs.existsSync(installation.serverEntry) && fs.existsSync(installation.cliEntry), installation.appRoot);

  const dataDirectory = path.resolve(status.dataDir);
  const permissionProbe = path.join(dataDirectory, `.doctor-${process.pid}-${Date.now()}`);
  try {
    await fsp.mkdir(dataDirectory, { recursive: true });
    await fsp.writeFile(permissionProbe, 'ok', 'utf8');
    await fsp.rm(permissionProbe, { force: true });
    add('storage', true, dataDirectory);
  } catch (error) {
    add('storage', false, error instanceof Error ? error.message : String(error));
  }

  function dependencyBinary(packageName: string) {
    try {
      const resolved = requireFromRoot(packageName) as string | { path?: string };
      const binary = typeof resolved === 'string' ? resolved : resolved.path;
      return binary && fs.existsSync(binary) ? binary : null;
    } catch {
      return null;
    }
  }
  function configuredBinary(environmentName: 'FFMPEG_PATH' | 'FFPROBE_PATH', packageName: string) {
    const configured = configuredValue(environmentName, installation.appRoot);
    if (configured) {
      const resolved = path.resolve(installation.appRoot, configured);
      return { path: fs.existsSync(resolved) ? resolved : null, detail: resolved };
    }
    const bundled = dependencyBinary(packageName);
    return { path: bundled, detail: bundled ?? 'unavailable' };
  }
  const ffmpeg = configuredBinary('FFMPEG_PATH', 'ffmpeg-static');
  const ffprobe = configuredBinary('FFPROBE_PATH', 'ffprobe-static');
  const health = status.running ? await probeHealth() : null;
  const textRendering = health
    ? health.textRendering === true
    : Boolean(ffmpeg.path && (() => {
      const result = spawnSync(ffmpeg.path, ['-hide_banner', '-filters'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      return result.status === 0 && /^\s*[.A-Z]+\s+drawtext\s/m.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    })());
  add('ffmpeg', health ? health.ffmpeg === true : Boolean(ffmpeg.path), health ? String(status.apiUrl) : ffmpeg.detail);
  add('ffprobe', health ? health.ffprobe === true : Boolean(ffprobe.path), health ? String(status.apiUrl) : ffprobe.detail);
  add('text-rendering', textRendering, health ? String(status.apiUrl) : ffmpeg.detail);
  add('server', status.running, status.running ? String(status.apiUrl) : 'not running; a live command or cutloc open will start it', 'warning');
  add('identity', !status.running || status.product === 'CutLoc', status.running ? String(status.product ?? 'missing product identity') : 'server not running');
  add('compatibility', !status.running || (!status.compatibilityError && status.apiVersion === API_PROTOCOL_VERSION), status.compatibilityError ?? `CLI ${API_PROTOCOL_VERSION}; server ${status.running ? status.apiVersion : 'not running'}`);
  add('version', !status.running || status.product !== 'CutLoc' || status.version === CUTLOC_VERSION, `CLI ${CUTLOC_VERSION}; server ${status.running ? status.version : 'not running'}`, 'warning');
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).map((entry) => path.resolve(entry.replace(/^"|"$/g, '')));
  add('path', pathEntries.some((entry) => entry.toLocaleLowerCase() === path.resolve(paths.bin).toLocaleLowerCase()), paths.bin, 'warning');
  return {
    ok: checks.every((check) => check.ok || check.severity === 'warning'),
    version: CUTLOC_VERSION,
    apiVersion: API_PROTOCOL_VERSION,
    status,
    checks,
  };
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
  const url = new URL(apiPath, parsedBaseUrl);
  if (url.origin !== parsedBaseUrl.origin || !url.pathname.startsWith('/api/')) throw new Error('API paths must stay on the configured server and start with /api/.');
  return url.toString();
}

function liveAgentGuide() {
  return { ...agentGuide, transport: { ...agentGuide.transport, baseUrl: serverEnsured ? parsedBaseUrl.origin : null } };
}

async function writeResponseFile(response: Response, fileName: string) {
  if (!response.body) throw new Error('The server returned an empty response body.');
  const absolute = path.resolve(fileName);
  const temporary = `${absolute}.cutloc-${process.pid}-${crypto.randomUUID()}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), createWriteStream(temporary, { flags: 'wx' }));
    await fsp.rm(absolute, { force: true });
    await fsp.rename(temporary, absolute);
    return absolute;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function request(apiPath: string, init: RequestInit = {}, token?: string) {
  if (!serverEnsured) await ensureServerAvailable();
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
  const form = new FormData();
  form.append('file', await openAsBlob(absolute), path.basename(absolute));
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
  for (const [operationIndex, operation] of plan.operations.entries()) {
    if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') throw new Error('Each edit operation requires an op value.');
    const operationPath = `operations[${operationIndex}]`;
    if (operation.op === 'setName') project.name = requireArg(operation.name, 'project name');
    else if (operation.op === 'setCanvas') project.canvas = { ...project.canvas, ...operation.canvas };
    else if (operation.op === 'addTrack') project.tracks.push(operation.track);
    else if (operation.op === 'removeTrack') {
      const trackId = requireArg(operation.trackId, `${operationPath}.trackId`);
      const trackIndex = project.tracks.findIndex((track) => track.id === trackId);
      if (trackIndex < 0) throw new Error(`Track not found for ${operationPath}: ${trackId}`);
      project.tracks.splice(trackIndex, 1);
    }
    else if (operation.op === 'addClip') {
      const trackId = requireArg(operation.trackId, `${operationPath}.trackId`);
      if (!operation.clip || typeof operation.clip !== 'object') throw new Error(`${operationPath}.clip is required.`);
      const track = project.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error(`Track not found for ${operationPath}: ${trackId}`);
      track.clips.push(operation.clip);
    } else if (operation.op === 'updateClip') {
      const trackId = requireArg(operation.trackId, `${operationPath}.trackId`);
      const clipId = requireArg(operation.clipId, `${operationPath}.clipId`);
      if (!operation.patch || typeof operation.patch !== 'object') throw new Error(`${operationPath}.patch is required.`);
      const track = project.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error(`Track not found for ${operationPath}: ${trackId}`);
      const clip = track.clips.find((item) => item.id === clipId);
      if (!clip) throw new Error(`Clip not found for ${operationPath}: ${trackId}/${clipId}`);
      Object.assign(clip, operation.patch, { id: clip.id });
    } else if (operation.op === 'removeClip') {
      const trackId = requireArg(operation.trackId, `${operationPath}.trackId`);
      const clipId = requireArg(operation.clipId, `${operationPath}.clipId`);
      const track = project.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error(`Track not found for ${operationPath}: ${trackId}`);
      const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
      if (clipIndex < 0) throw new Error(`Clip not found for ${operationPath}: ${trackId}/${clipId}`);
      track.clips.splice(clipIndex, 1);
    } else if (operation.op === 'addMarker') project.markers.push(operation.marker);
    else if (operation.op === 'removeMarker') {
      const markerId = requireArg(operation.markerId, `${operationPath}.markerId`);
      const markerIndex = project.markers.findIndex((marker) => marker.id === markerId);
      if (markerIndex < 0) throw new Error(`Marker not found for ${operationPath}: ${markerId}`);
      project.markers.splice(markerIndex, 1);
    }
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

const keyframeProperties = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const;
const keyframeEasings = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const;

function keyframeProperty(value: string | undefined): KeyframeProperty {
  const property = requireArg(value, 'keyframe property');
  if (!keyframeProperties.includes(property as KeyframeProperty)) throw new Error(`Keyframe property must be one of: ${keyframeProperties.join(', ')}.`);
  return property as KeyframeProperty;
}

function keyframeEasing(value: string | undefined): Keyframe['easing'] {
  const easing = value ?? 'linear';
  if (!keyframeEasings.includes(easing as Keyframe['easing'])) throw new Error(`Keyframe easing must be one of: ${keyframeEasings.join(', ')}.`);
  return easing as Keyframe['easing'];
}

function findProjectClip(project: Project, clipId: string) {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`Clip not found: ${clipId}`);
}

function sortedKeyframes(clip: Clip, property?: KeyframeProperty) {
  return clip.keyframes
    .filter((keyframe) => !property || keyframe.property === property)
    .slice()
    .sort((left, right) => left.time - right.time || left.property.localeCompare(right.property));
}

async function mutateClipKeyframes(projectId: string, clipId: string, mutation: (project: Project, clip: Clip) => Record<string, unknown>) {
  return withProjectAccess(projectId, async (token) => {
    const current = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`) as Project;
    const { clip } = findProjectClip(current, clipId);
    const detail = mutation(current, clip);
    const validated = ProjectSchema.parse(current);
    const saved = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', { ...validated, revision: current.revision }, token) as Project;
    const savedClip = findProjectClip(saved, clipId).clip;
    return { ok: true, projectId, clipId, revision: saved.revision, ...detail, keyframes: sortedKeyframes(savedClip) };
  });
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
        if (targetProject !== projectId) throw new Error('A session may only access its locked project.');
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

  if (group === 'status') {
    takeBooleanFlag(args, '--json');
    ensureNoArgs(args);
    return print(await runtimeStatus());
  }

  if (group === 'doctor') {
    takeBooleanFlag(args, '--json');
    ensureNoArgs(args);
    const diagnosis = await runtimeDoctor();
    print(diagnosis);
    if (!diagnosis.ok) process.exitCode = 1;
    return;
  }

  if (group === 'stop') {
    const force = takeBooleanFlag(args, '--force');
    ensureNoArgs(args);
    return print(await stopServer({ force }));
  }

  if (group === 'restart') {
    const force = takeBooleanFlag(args, '--force');
    ensureNoArgs(args);
    if (endpointWasExplicit) throw new Error('restart is available only for the shared managed CutLoc server.');
    const stopped = await stopServer({ force });
    const runtime = await ensureServerAvailable();
    return print({
      ok: true,
      running: true,
      restarted: stopped.stopped,
      started: runtime.started,
      version: runtime.health.version,
      apiVersion: runtime.health.apiVersion,
      apiUrl: parsedBaseUrl.origin,
    });
  }

  if (group === 'open') {
    ensureNoArgs(args);
    const runtime = await ensureServerAvailable();
    openBrowser(parsedBaseUrl.origin);
    return print({
      ok: true,
      running: true,
      started: runtime.started,
      version: runtime.health.version ?? CUTLOC_VERSION,
      apiVersion: runtime.health.apiVersion ?? API_PROTOCOL_VERSION,
      apiUrl: parsedBaseUrl.origin,
      editorUrl: parsedBaseUrl.origin,
    });
  }

  if (group === 'agent' && args[0] === 'guide') {
    args.shift();
    ensureNoArgs(args);
    await discoverRuntimeEndpoint();
    const health = endpointWasExplicit || currentInstance ? await probeHealth() : null;
    if (health && !healthCompatibilityError(health)) serverEnsured = true;
    return print(liveAgentGuide());
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
        const absolute = await writeResponseFile(response, out);
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
        ...(!noGuide ? { guide: liveAgentGuide() } : {}),
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
      if (typeof body !== 'object' || body === null || !('revision' in body) || !Number.isInteger((body as { revision?: unknown }).revision)) throw new Error('projects apply requires the revision from projects get.');
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
      const absolute = await writeResponseFile(response, out);
      return print({ ok: true, file: absolute });
    }
    if (action === 'import') {
      const file = path.resolve(requireArg(args.shift(), 'project bundle file'));
      ensureNoArgs(args);
      const isJson = file.toLocaleLowerCase().endsWith('.json');
      const response = await request('/api/projects/import', {
        method: 'POST',
        headers: { 'content-type': isJson ? 'application/json' : 'application/zip' },
        body: isJson ? await fsp.readFile(file, 'utf8') : await openAsBlob(file),
      });
      return print(await response.json());
    }
  }

  if (group === 'keyframes') {
    const projectId = requireArg(args.shift(), 'project ID');
    const clipId = requireArg(args.shift(), 'clip ID');
    const propertyFlag = takeFlag(args, '--property');
    const propertyFilter = propertyFlag ? keyframeProperty(propertyFlag) : undefined;

    if (action === 'list') {
      ensureNoArgs(args);
      const project = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`) as Project;
      const { track, clip } = findProjectClip(project, clipId);
      const keyframes = sortedKeyframes(clip, propertyFilter);
      return print({ ok: true, projectId, trackId: track.id, clipId, clipStart: clip.start, clipDuration: clip.duration, timeMode: 'clip-local-seconds', property: propertyFilter ?? null, count: keyframes.length, keyframes });
    }

    if (action === 'set') {
      if (propertyFilter) throw new Error('Pass the keyframe property as the third positional argument, not --property.');
      const property = keyframeProperty(args.shift());
      const timeRaw = takeFlag(args, '--time');
      const valueRaw = takeFlag(args, '--value');
      const easingRaw = takeFlag(args, '--easing');
      ensureNoArgs(args);
      const time = finiteNumber(timeRaw, '--time');
      const value = finiteNumber(valueRaw, '--value');
      if (time < 0) throw new Error('--time must be a non-negative clip-local time.');
      if (property === 'scale' && value <= 0) throw new Error('scale keyframes must be greater than 0.');
      if (property === 'opacity' && (value < 0 || value > 1)) throw new Error('opacity keyframes must be between 0 and 1.');
      if (property === 'volume' && (value < 0 || value > 2)) throw new Error('volume keyframes must be between 0 and 2.');
      const easing = easingRaw ? keyframeEasing(easingRaw) : undefined;
      return print(await mutateClipKeyframes(projectId, clipId, (project, clip) => {
        if (time > clip.duration) throw new Error(`Keyframe time ${time} exceeds clip duration ${clip.duration}.`);
        const tolerance = 0.5 / Math.max(1, project.canvas.fps);
        const existing = clip.keyframes.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - time) <= tolerance);
        const created = !existing;
        const keyframe: Keyframe = existing ?? { id: `key_${crypto.randomUUID().slice(0, 8)}`, property, time, value, easing: easing ?? 'linear' };
        keyframe.time = time;
        keyframe.value = value;
        if (easing) keyframe.easing = easing;
        if (created) clip.keyframes.push(keyframe);
        return { created, keyframeId: keyframe.id, property, time, value, easing: keyframe.easing };
      }));
    }

    if (action === 'remove') {
      if (propertyFilter) throw new Error('--property is not used by keyframes remove; pass a keyframe ID.');
      const keyframeId = requireArg(args.shift(), 'keyframe ID');
      ensureNoArgs(args);
      return print(await mutateClipKeyframes(projectId, clipId, (_project, clip) => {
        const index = clip.keyframes.findIndex((keyframe) => keyframe.id === keyframeId);
        if (index < 0) throw new Error(`Keyframe not found: ${keyframeId}`);
        const [removed] = clip.keyframes.splice(index, 1);
        return { removed };
      }));
    }

    if (action === 'clear') {
      ensureNoArgs(args);
      return print(await mutateClipKeyframes(projectId, clipId, (_project, clip) => {
        const before = clip.keyframes.length;
        clip.keyframes = clip.keyframes.filter((keyframe) => propertyFilter && keyframe.property !== propertyFilter);
        return { property: propertyFilter ?? null, removedCount: before - clip.keyframes.length };
      }));
    }

    throw new Error('keyframes action must be list, set, remove, or clear.');
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
      await writeResponseFile(response, absolute);
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
    await writeResponseFile(response, absolute);
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

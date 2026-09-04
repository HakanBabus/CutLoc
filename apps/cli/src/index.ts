#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import type { ProjectAccessLease } from '@cutloc/shared';

type JsonObject = Record<string, unknown>;
type LeaseHandle = { lease: ProjectAccessLease; token: string };

const help = `CutLoc CLI — local editor control for people and AI tools

Usage:
  cutloc [--url http://127.0.0.1:4173] <command>

Projects:
  projects list | create [name] | get <id> [--out <json>] | apply <id> (--file <json> | --stdin)
  projects duplicate <id> | delete <id> | bundle <id> --out <file>
  projects import <file>

Media and recovery:
  media add <project-id> <file> | remove <project-id> <asset-id>
  media relink <project-id> <asset-id> <file> | rebuild <project-id> <asset-id>
  media health <project-id> | stock <project-id> <stock-id>
  backups list <project-id> | restore <project-id> <file-name>
  trash list | restore <trash-id> | delete <trash-id>

Export and settings:
  export preflight|start <project-id> [--file <options.json>]
  jobs list | get <job-id> | cancel <job-id> | download <job-id> --out <file>
  settings get | set (--file <json> | --stdin)

Agent access:
  session <project-id>
    Holds exclusive project access until stdin closes. Send one JSON request per
    line: {"method":"PATCH","path":"/api/projects/<id>","body":{...}}
  api <method> <api-path> [--file <json>] [--data <json>] [--out <file>]
    Low-level JSON API access. Project paths are locked automatically for
    mutating methods. Use the dedicated media/import commands for uploads.

All successful structured output is JSON. Use --compact for one-line output.`;

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
  if (group === 'projects') {
    if (action === 'list') { ensureNoArgs(args); return print(await jsonRequest('/api/projects')); }
    if (action === 'create') { ensureNoOptionArgs(args); return print(await jsonRequest('/api/projects', 'POST', { name: args.join(' ') || undefined })); }
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
    if (action === 'add') { const file = requireArg(args.shift(), 'media file'); ensureNoArgs(args); return print(await withProjectAccess(projectId, (token) => upload(`/api/projects/${encodeURIComponent(projectId)}/media`, file, token))); }
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

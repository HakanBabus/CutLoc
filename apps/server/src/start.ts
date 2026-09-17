import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRuntimeLock,
  API_PROTOCOL_VERSION,
  CUTLOC_VERSION,
  ensureRuntimeFolders,
  runtimePaths,
  writeJsonAtomic,
} from '@cutloc/runtime';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST?.trim() || '127.0.0.1';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (!loopbackHosts.has(host.toLowerCase())) {
  throw new Error('CutLoc is local-only and only accepts loopback HOST values.');
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('CutLoc PORT must be an integer between 0 and 65535.');
}
const paths = await ensureRuntimeFolders(runtimePaths());
const releaseRuntimeLock = await acquireRuntimeLock(paths);
const { createServer, setRuntimePort } = await import('./index.js');
const app = await createServer();

let cleanupStarted = false;
async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await fs.promises.rm(paths.instanceFile, { force: true }).catch(() => undefined);
  await releaseRuntimeLock().catch(() => undefined);
}

let shutdownStarted = false;
async function shutdown(exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await app.close().catch(() => undefined);
  await cleanup();
  process.exit(exitCode);
}

app.post('/api/runtime/shutdown', async (_request, reply) => {
  reply.send({ ok: true });
  setTimeout(() => { void shutdown(); }, 25).unref();
});

try {
  await app.listen({ port, host });
  const address = app.server.address();
  const activePort = typeof address === 'object' && address ? address.port : port;
  setRuntimePort(activePort);
  const browserHost = host === '::1' || host === '[::1]' ? '[::1]' : host;
  const apiUrl = `http://${browserHost}:${activePort}`;
  const configuredDataDir = process.env.DATA_DIR?.trim();
  await writeJsonAtomic(paths.instanceFile, {
    product: 'CutLoc',
    version: CUTLOC_VERSION,
    apiVersion: API_PROTOCOL_VERSION,
    apiUrl,
    pid: process.pid,
    instanceId: crypto.randomUUID(),
    dataDir: path.resolve(configuredDataDir || paths.data),
    startedAt: new Date().toISOString(),
  });
  console.log(`CutLoc ready: ${apiUrl}`);
  if (process.platform === 'win32' && process.env.NO_OPEN !== '1') {
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', apiUrl], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  }
} catch (error) {
  await app.close().catch(() => undefined);
  await cleanup();
  throw error;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}

process.once('beforeExit', () => { void cleanup(); });

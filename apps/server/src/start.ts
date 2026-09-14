import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST?.trim() || '127.0.0.1';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (!loopbackHosts.has(host.toLowerCase())) {
  throw new Error('CutLoc is local-only and only accepts loopback HOST values.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CutLoc PORT must be an integer between 1 and 65535.');
}
const { createServer } = await import('./index.js');
const app = await createServer();
await app.listen({ port, host });
const browserHost = host === '::1' || host === '[::1]' ? '[::1]' : host;
console.log(`CutLoc ready: http://${browserHost}:${port}`);
if (process.platform === 'win32' && process.env.NO_OPEN !== '1') {
  spawn('cmd.exe', ['/c', 'start', '', `http://${browserHost}:${port}`], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

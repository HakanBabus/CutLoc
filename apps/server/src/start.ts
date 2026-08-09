import { createServer } from './index.js';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST?.trim() || '127.0.0.1';
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (!loopbackHosts.has(host.toLowerCase())) {
  throw new Error('CutLoc is local-only and only accepts loopback HOST values.');
}
const app = await createServer();
await app.listen({ port, host });
const browserHost = host === '::1' || host === '[::1]' ? '[::1]' : host;
console.log(`CutLoc hazır: http://${browserHost}:${port}`);
if (process.platform === 'win32' && process.env.NO_OPEN !== '1') {
  spawn('cmd.exe', ['/c', 'start', '', `http://${browserHost}:${port}`], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

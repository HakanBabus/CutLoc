import { createServer } from './index.js';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT ?? 4173);
const app = await createServer();
await app.listen({ port, host: '127.0.0.1' });
console.log(`CutLoc hazır: http://127.0.0.1:${port}`);
if (process.platform === 'win32' && process.env.NO_OPEN !== '1') {
  spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

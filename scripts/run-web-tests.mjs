#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const testDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-playwright-'));
const testCutLocHome = path.join(testDataDir, 'home');
const apiPort = await availablePort();
let webPort = await availablePort();
while (webPort === apiPort) webPort = await availablePort();
const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm';
const commandArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm.cmd run test:web:direct']
  : ['run', 'test:web:direct'];

try {
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      WEB_PORT: String(webPort),
      DATA_DIR: testDataDir,
      CUTLOC_HOME: testCutLocHome,
      CUTLOC_E2E_DATA_DIR: testDataDir,
      NO_OPEN: '1',
    },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`Playwright was interrupted by ${signal}`)) : resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await fsp.rm(testDataDir, { recursive: true, force: true });
}

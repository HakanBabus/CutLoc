import { defineConfig } from '@playwright/test';
import path from 'node:path';

const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.PORT ?? 4173);
const testDataDir = process.env.CUTLOC_E2E_DATA_DIR;
if (!testDataDir) throw new Error('Use npm run test:web so browser tests receive an isolated DATA_DIR.');
if (![webPort, apiPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error('Browser test ports must be valid TCP ports.');
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './tests/web',
  // The local Fastify server and DATA_DIR are shared by browser workers.
  // Serialize the suite so project/settings fixtures cannot race each other.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), WEB_PORT: String(webPort), DATA_DIR: testDataDir, CUTLOC_HOME: path.join(testDataDir, 'home'), NO_OPEN: '1' },
  },
});

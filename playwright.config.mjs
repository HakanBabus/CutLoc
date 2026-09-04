import { defineConfig } from '@playwright/test';

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
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

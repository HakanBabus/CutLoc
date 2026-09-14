import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function resolveApiProxyTarget(environment = {}) {
  const host = String(environment.HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(environment.PORT ?? 4173);
  if (!loopbackHosts.has(host.toLowerCase())) throw new Error('CutLoc dev proxy only accepts loopback HOST values.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CutLoc PORT must be an integer between 1 and 65535.');
  const urlHost = host === '::1' || host === '[::1]' ? '[::1]' : host;
  return `http://${urlHost}:${port}`;
}

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: { '/api': resolveApiProxyTarget(environment) },
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('react-dom') || id.includes('/react/')) return 'react-vendor';
            if (id.includes('zustand') || id.includes('immer')) return 'state-vendor';
            return 'vendor';
          },
        },
      },
    },
  };
});

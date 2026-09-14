#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node.js', nodeMajor === 24, `${process.versions.node} (required: 24.x)`);
add('package-lock.json', fs.existsSync(path.join(repoRoot, 'package-lock.json')), 'locked dependency manifest');

for (const [name, packageName] of [['FFmpeg', 'ffmpeg-static'], ['ffprobe', 'ffprobe-static']]) {
  try {
    const value = require(packageName);
    const binary = typeof value === 'string' ? value : value.path;
    add(name, typeof binary === 'string' && fs.existsSync(binary), binary || 'binary path unavailable');
  } catch {
    add(name, false, `dependency unavailable; run npm ci`);
  }
}

const host = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
add('Local host', loopback.has(host.toLowerCase()), host);
add('API port', Number.isInteger(port) && port >= 1 && port <= 65535, String(process.env.PORT ?? 4173));

const dataDir = path.resolve(repoRoot, process.env.DATA_DIR || 'data');
const dataParent = fs.existsSync(dataDir) ? dataDir : path.dirname(dataDir);
try {
  fs.accessSync(dataParent, fs.constants.R_OK | fs.constants.W_OK);
  add('Data directory', true, dataDir);
} catch {
  add('Data directory', false, `${dataDir} is not readable and writable`);
}

const width = Math.max(...checks.map((check) => check.name.length));
for (const check of checks) {
  const marker = check.ok ? 'OK' : 'FAIL';
  process.stdout.write(`${marker.padEnd(4)} ${check.name.padEnd(width)}  ${check.detail}\n`);
}

if (checks.some((check) => !check.ok)) {
  process.stderr.write('\nCutLoc is not ready. Fix the failed checks, then run npm.cmd run doctor again.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('\nCutLoc prerequisites are ready. Start with npm.cmd run dev or npm.cmd start.\n');
}

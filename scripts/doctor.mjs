#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
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

function systemBinary(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
}

function packagedBinary(packageName) {
  try {
    const value = require(packageName);
    const binary = typeof value === 'string' ? value : value.path;
    return typeof binary === 'string' && fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

function hasFfmpegFilter(binary, filter) {
  if (!binary) return false;
  const result = spawnSync(binary, ['-hide_banner', '-filters'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 && new RegExp(`^\\s*[.A-Z]+\\s+${filter}\\s`, 'm').test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

const packagedFfmpeg = packagedBinary('ffmpeg-static');
const systemFfmpeg = systemBinary('ffmpeg');
const ffmpeg = process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)
  ? process.env.FFMPEG_PATH
  : [packagedFfmpeg, systemFfmpeg].find((candidate) => hasFfmpegFilter(candidate, 'drawtext')) ?? packagedFfmpeg ?? systemFfmpeg;
const packagedFfprobe = packagedBinary('ffprobe-static');
const ffprobe = process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)
  ? process.env.FFPROBE_PATH
  : packagedFfprobe ?? systemBinary('ffprobe');
add('FFmpeg', Boolean(ffmpeg), ffmpeg || 'binary unavailable; run npm ci or configure FFMPEG_PATH');
add('FFmpeg drawtext', hasFfmpegFilter(ffmpeg, 'drawtext'), ffmpeg ? 'text export capability' : 'FFmpeg unavailable');
add('ffprobe', Boolean(ffprobe), ffprobe || 'binary unavailable; run npm ci or configure FFPROBE_PATH');

const host = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
add('Local host', loopback.has(host.toLowerCase()), host);
add('API port', Number.isInteger(port) && port >= 1 && port <= 65535, String(process.env.PORT ?? 4173));

const cutlocHome = path.resolve(process.env.CUTLOC_HOME?.trim() || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA?.trim() || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'), 'CutLoc')
  : path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'), 'CutLoc')));
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || path.join(cutlocHome, 'data'));
let dataParent = dataDir;
while (!fs.existsSync(dataParent) && path.dirname(dataParent) !== dataParent) dataParent = path.dirname(dataParent);
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
  process.stdout.write('\nCutLoc prerequisites are ready. Run npm.cmd run setup:user once, then use cutloc open.\n');
}

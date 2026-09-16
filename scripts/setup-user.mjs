#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CUTLOC_VERSION,
  ensureRuntimeFolders,
  runtimePaths,
  writeJsonAtomic,
} from '../packages/runtime/dist/index.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = await ensureRuntimeFolders(runtimePaths());
const noPath = process.argv.includes('--no-path');
const noMigrate = process.argv.includes('--no-migrate');
const unknown = process.argv.slice(2).filter((argument) => !['--no-path', '--no-migrate'].includes(argument));
if (unknown.length) throw new Error(`Unknown setup argument: ${unknown[0]}`);
if (process.platform !== 'win32' && !noPath) throw new Error('setup:user currently configures the Windows user PATH. Use --no-path for isolated testing.');

const installation = {
  product: 'CutLoc',
  version: CUTLOC_VERSION,
  appRoot,
  nodePath: process.execPath,
  cliEntry: path.join(appRoot, 'apps', 'cli', 'dist', 'index.js'),
  serverEntry: path.join(appRoot, 'apps', 'server', 'dist', 'start.js'),
  configuredAt: new Date().toISOString(),
};

for (const required of [installation.cliEntry, installation.serverEntry]) {
  try {
    await fsp.access(required);
  } catch {
    throw new Error(`Required CutLoc build output is missing: ${required}`);
  }
}

function escapeCmdValue(value) {
  return value.replaceAll('%', '%%').replaceAll('^', '^^');
}

const shimFile = path.join(paths.bin, 'cutloc.cmd');
const shim = `@echo off\r\n"${escapeCmdValue(process.execPath)}" "${escapeCmdValue(installation.cliEntry)}" %*\r\n`;
await fsp.writeFile(shimFile, shim, 'utf8');
await writeJsonAtomic(paths.installFile, installation);

let legacyMigration = 'skipped';
const legacyData = path.join(appRoot, 'data');
if (!noMigrate) {
  const [legacyEntries, targetEntries] = await Promise.all([
    fsp.readdir(legacyData).catch(() => []),
    fsp.readdir(paths.data).catch(() => []),
  ]);
  if (legacyEntries.length && targetEntries.length === 0 && path.resolve(legacyData) !== path.resolve(paths.data)) {
    const staging = `${paths.data}.migration-${process.pid}-${Date.now()}`;
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (const entry of legacyEntries) {
        await fsp.cp(path.join(legacyData, entry), path.join(staging, entry), { recursive: true, force: false, errorOnExist: true });
      }
      await fsp.rm(paths.data, { recursive: true, force: true });
      await fsp.rename(staging, paths.data);
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw error;
    }
    legacyMigration = 'copied';
  } else if (legacyEntries.length && targetEntries.length) {
    legacyMigration = 'target-not-empty';
  } else {
    legacyMigration = 'nothing-to-copy';
  }
}

let pathUpdated = false;
if (!noPath) {
  const script = [
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$entries = @($current -split ';' | Where-Object { $_ })",
    "$target = $env:CUTLOC_BIN_TO_ADD",
    "if (-not ($entries | Where-Object { $_.TrimEnd('\\') -ieq $target.TrimEnd('\\') })) {",
    "  $next = (($entries + $target) -join ';')",
    "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    "  Write-Output 'UPDATED'",
    '} else {',
    "  Write-Output 'UNCHANGED'",
    '}',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CUTLOC_BIN_TO_ADD: paths.bin },
  });
  if (result.status !== 0) throw new Error(`Could not update the user PATH: ${result.stderr || result.stdout}`);
  pathUpdated = result.stdout.includes('UPDATED');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  version: CUTLOC_VERSION,
  home: paths.home,
  dataDir: paths.data,
  command: shimFile,
  pathUpdated,
  legacyMigration,
  next: pathUpdated ? 'Open a new terminal, then run: cutloc open' : 'Run: cutloc open',
}, null, 2)}\n`);

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
const setupTestMode = process.env.CUTLOC_SETUP_TEST_MODE === '1';
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

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeTextAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temporary, value, 'utf8');
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function directoryHasContent(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) return true;
    if (await directoryHasContent(path.join(directory, entry.name))) return true;
  }
  return false;
}

async function migrateLegacyData(legacyData) {
  const legacyEntries = await fsp.readdir(legacyData, { withFileTypes: true }).catch(() => []);
  if (!legacyEntries.length || path.resolve(legacyData) === path.resolve(paths.data)) {
    return { status: 'nothing-to-copy', copied: [], conflicts: [] };
  }

  if (!await directoryHasContent(paths.data)) {
    const staging = `${paths.data}.migration-${process.pid}-${Date.now()}`;
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (const entry of legacyEntries) {
        await fsp.cp(path.join(legacyData, entry.name), path.join(staging, entry.name), { recursive: true, force: false, errorOnExist: true });
      }
      await fsp.rm(paths.data, { recursive: true, force: true });
      await fsp.rename(staging, paths.data);
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return { status: 'copied', copied: legacyEntries.map((entry) => entry.name), conflicts: [] };
  }

  const copied = [];
  const conflicts = [];
  for (const entry of legacyEntries) {
    const source = path.join(legacyData, entry.name);
    const target = path.join(paths.data, entry.name);
    if (!await exists(target)) {
      await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true });
      copied.push(entry.name);
      continue;
    }

    const targetStat = await fsp.lstat(target);
    if (entry.isDirectory() && targetStat.isDirectory() && ['projects', 'trash'].includes(entry.name)) {
      for (const child of await fsp.readdir(source, { withFileTypes: true })) {
        const relative = path.join(entry.name, child.name);
        const childTarget = path.join(target, child.name);
        if (await exists(childTarget)) {
          conflicts.push(relative);
        } else {
          await fsp.cp(path.join(source, child.name), childTarget, { recursive: true, force: false, errorOnExist: true });
          copied.push(relative);
        }
      }
      continue;
    }
    conflicts.push(entry.name);
  }

  const status = conflicts.length
    ? copied.length ? 'merged-with-conflicts' : 'conflicts-retained'
    : copied.length ? 'merged' : 'already-present';
  return { status, copied, conflicts };
}

const shimFile = path.join(paths.bin, 'cutloc.cmd');
const shim = `@echo off\r\n"${escapeCmdValue(process.execPath)}" "${escapeCmdValue(installation.cliEntry)}" %*\r\n`;

let legacyMigration = { status: 'skipped', copied: [], conflicts: [] };
const legacyDataOverride = setupTestMode ? process.env.CUTLOC_LEGACY_DATA_DIR?.trim() : undefined;
const legacyData = path.resolve(legacyDataOverride || path.join(appRoot, 'data'));
if (!noMigrate) {
  legacyMigration = await migrateLegacyData(legacyData);
}

await writeTextAtomic(shimFile, shim);
await writeJsonAtomic(paths.installFile, installation);

let pathUpdated = false;
let pathVerified = false;
if (!noPath) {
  const script = [
    "$scope = if ($env:CUTLOC_SETUP_TEST_MODE -eq '1' -and $env:CUTLOC_SETUP_TEST_PATH_SCOPE -eq 'Process') { 'Process' } else { 'User' }",
    "$current = [Environment]::GetEnvironmentVariable('Path', $scope)",
    "$entries = @($current -split ';' | Where-Object { $_ })",
    "$target = $env:CUTLOC_BIN_TO_ADD",
    "$normalize = { param([string]$value) if ($null -eq $value) { return '' }; return [Environment]::ExpandEnvironmentVariables($value.Trim().Trim('\"')).TrimEnd('\\') }",
    "$targetNormalized = & $normalize $target",
    "if (-not ($entries | Where-Object { (& $normalize $_) -ieq $targetNormalized })) {",
    "  $next = (($entries + $target) -join ';')",
    "  [Environment]::SetEnvironmentVariable('Path', $next, $scope)",
    "  Write-Output 'UPDATED'",
    '} else {',
    "  Write-Output 'UNCHANGED'",
    '}',
    "$verified = @([Environment]::GetEnvironmentVariable('Path', $scope) -split ';' | Where-Object { $_ -and (& $normalize $_) -ieq $targetNormalized })",
    "if (-not $verified.Count) { throw 'CutLoc PATH update could not be verified.' }",
    "Write-Output 'VERIFIED'",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CUTLOC_BIN_TO_ADD: paths.bin },
  });
  if (result.status !== 0) throw new Error(`Could not update the user PATH: ${result.stderr || result.stdout}`);
  pathUpdated = result.stdout.includes('UPDATED');
  pathVerified = result.stdout.includes('VERIFIED');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  version: CUTLOC_VERSION,
  home: paths.home,
  dataDir: paths.data,
  command: shimFile,
  pathUpdated,
  pathVerified,
  legacyMigration: legacyMigration.status,
  legacyCopied: legacyMigration.copied,
  legacyConflicts: legacyMigration.conflicts,
  next: pathUpdated ? 'Open a new terminal, then run: cutloc open' : 'Run: cutloc open',
}, null, 2)}\n`);

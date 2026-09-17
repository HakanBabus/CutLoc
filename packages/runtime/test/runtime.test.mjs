import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureRuntimeFolders, readJsonFile, readRuntimeInstance, readUserInstallation, resolveCutLocHome, runtimePaths, writeJsonAtomic } from '../dist/index.js';

test('runtime paths use LOCALAPPDATA on Windows and support an isolated override', () => {
  assert.equal(resolveCutLocHome({ LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'win32', 'C:\\Users\\Test'), path.resolve('C:\\Users\\Test\\AppData\\Local', 'CutLoc'));
  assert.equal(resolveCutLocHome({ CUTLOC_HOME: 'D:\\CutLoc-Test' }, 'win32', 'C:\\Users\\Test'), path.resolve('D:\\CutLoc-Test'));
});

test('runtime readers reject incomplete, unsafe, and malformed persisted metadata', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-runtime-metadata-'));
  const paths = await ensureRuntimeFolders(runtimePaths({ CUTLOC_HOME: home }));
  const validInstallation = {
    product: 'CutLoc',
    version: '1.1.0',
    appRoot: path.resolve(home, 'app'),
    nodePath: process.execPath,
    cliEntry: path.resolve(home, 'app', 'apps', 'cli', 'dist', 'index.js'),
    serverEntry: path.resolve(home, 'app', 'apps', 'server', 'dist', 'start.js'),
    configuredAt: new Date().toISOString(),
  };
  const validInstance = {
    product: 'CutLoc',
    version: '1.1.0',
    apiVersion: 1,
    apiUrl: 'http://127.0.0.1:4173',
    pid: process.pid,
    instanceId: 'test-instance',
    dataDir: path.resolve(home, 'data'),
    startedAt: new Date().toISOString(),
  };
  try {
    await writeJsonAtomic(paths.installFile, { product: 'CutLoc' });
    assert.equal(await readUserInstallation(paths), null);
    await writeJsonAtomic(paths.installFile, { ...validInstallation, serverEntry: 'relative/server.js' });
    assert.equal(await readUserInstallation(paths), null);
    await writeJsonAtomic(paths.installFile, validInstallation);
    assert.deepEqual(await readUserInstallation(paths), validInstallation);

    await writeJsonAtomic(paths.instanceFile, { ...validInstance, apiUrl: 'http://example.com:4173' });
    assert.equal(await readRuntimeInstance(paths), null);
    await writeJsonAtomic(paths.instanceFile, { ...validInstance, apiUrl: 'http://user:password@127.0.0.1:4173' });
    assert.equal(await readRuntimeInstance(paths), null);
    await writeJsonAtomic(paths.instanceFile, { ...validInstance, dataDir: 'relative-data' });
    assert.equal(await readRuntimeInstance(paths), null);
    await writeJsonAtomic(paths.instanceFile, validInstance);
    assert.deepEqual(await readRuntimeInstance(paths), validInstance);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('runtime folders and atomic JSON stay inside the configured CutLoc home', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutloc-runtime-'));
  const paths = runtimePaths({ CUTLOC_HOME: home });
  try {
    await ensureRuntimeFolders(paths);
    await writeJsonAtomic(paths.installFile, { ok: true });
    assert.deepEqual(await readJsonFile(paths.installFile), { ok: true });
    for (const directory of [paths.data, paths.runtime, paths.logs, paths.temp, paths.bin]) {
      assert.equal((await fsp.stat(directory)).isDirectory(), true);
    }
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

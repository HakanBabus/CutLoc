import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureRuntimeFolders, readJsonFile, resolveCutLocHome, runtimePaths, writeJsonAtomic } from '../dist/index.js';

test('runtime paths use LOCALAPPDATA on Windows and support an isolated override', () => {
  assert.equal(resolveCutLocHome({ LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'win32', 'C:\\Users\\Test'), path.resolve('C:\\Users\\Test\\AppData\\Local', 'CutLoc'));
  assert.equal(resolveCutLocHome({ CUTLOC_HOME: 'D:\\CutLoc-Test' }, 'win32', 'C:\\Users\\Test'), path.resolve('D:\\CutLoc-Test'));
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

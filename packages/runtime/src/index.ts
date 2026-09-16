import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CUTLOC_VERSION = '1.1.0';
export const API_PROTOCOL_VERSION = 1;

export type CutLocRuntimePaths = {
  home: string;
  data: string;
  runtime: string;
  logs: string;
  temp: string;
  bin: string;
  instanceFile: string;
  lockFile: string;
  installFile: string;
};

export type RuntimeInstance = {
  product: 'CutLoc';
  version: string;
  apiVersion: number;
  apiUrl: string;
  pid: number;
  instanceId: string;
  dataDir: string;
  startedAt: string;
};

export type UserInstallation = {
  product: 'CutLoc';
  version: string;
  appRoot: string;
  nodePath: string;
  cliEntry: string;
  serverEntry: string;
  configuredAt: string;
};

export function resolveCutLocHome(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
) {
  const override = environment.CUTLOC_HOME?.trim();
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA?.trim() || path.join(homeDirectory, 'AppData', 'Local');
    return path.resolve(localAppData, 'CutLoc');
  }
  const dataHome = environment.XDG_DATA_HOME?.trim() || path.join(homeDirectory, '.local', 'share');
  return path.resolve(dataHome, 'CutLoc');
}

export function runtimePaths(environment: NodeJS.ProcessEnv = process.env): CutLocRuntimePaths {
  const home = resolveCutLocHome(environment);
  const runtime = path.join(home, 'runtime');
  return {
    home,
    data: path.join(home, 'data'),
    runtime,
    logs: path.join(home, 'logs'),
    temp: path.join(home, 'temp'),
    bin: path.join(home, 'bin'),
    instanceFile: path.join(runtime, 'instance.json'),
    lockFile: path.join(runtime, 'server.lock'),
    installFile: path.join(home, 'install.json'),
  };
}

export async function ensureRuntimeFolders(paths = runtimePaths()) {
  await Promise.all([paths.home, paths.data, paths.runtime, paths.logs, paths.temp, paths.bin].map((directory) => fsp.mkdir(directory, { recursive: true })));
  return paths;
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, file);
}

export function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readRuntimeInstance(paths = runtimePaths()) {
  const instance = await readJsonFile<RuntimeInstance>(paths.instanceFile);
  if (!instance || instance.product !== 'CutLoc' || !processExists(instance.pid)) return null;
  try {
    const url = new URL(instance.apiUrl);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return null;
  } catch {
    return null;
  }
  return instance;
}

export async function readUserInstallation(paths = runtimePaths()) {
  const installation = await readJsonFile<UserInstallation>(paths.installFile);
  if (!installation || installation.product !== 'CutLoc') return null;
  return installation;
}

type RuntimeLock = { pid: number; createdAt: string };

export async function acquireRuntimeLock(paths = runtimePaths()) {
  await fsp.mkdir(paths.runtime, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(paths.lockFile, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies RuntimeLock)}\n`);
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const lock = await readJsonFile<RuntimeLock>(paths.lockFile);
        if (lock?.pid === process.pid) await fsp.rm(paths.lockFile, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await readJsonFile<RuntimeLock>(paths.lockFile);
      const createdAt = Date.parse(lock?.createdAt ?? '');
      const fresh = Number.isFinite(createdAt) && Date.now() - createdAt < 30_000;
      const instance = await readJsonFile<RuntimeInstance>(paths.instanceFile);
      let responding = false;
      if (lock && instance?.pid === lock.pid && processExists(lock.pid)) {
        try {
          const response = await fetch(new URL('/api/health', instance.apiUrl), { signal: AbortSignal.timeout(1_000) });
          const health = response.ok ? await response.json() as { product?: string; ok?: boolean } : null;
          responding = health?.ok === true && health.product === 'CutLoc';
        } catch { /* stale runtime metadata */ }
      }
      if (lock && processExists(lock.pid) && (fresh || responding)) {
        throw Object.assign(new Error('A CutLoc server is already running.'), { code: 'CUTLOC_ALREADY_RUNNING' });
      }
      await fsp.rm(paths.lockFile, { force: true });
      await fsp.rm(paths.instanceFile, { force: true });
    }
  }
  throw new Error('Could not acquire the CutLoc runtime lock.');
}

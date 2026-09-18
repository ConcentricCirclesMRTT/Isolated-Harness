import { cp, mkdir, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { RunnerValidationError } from './errors.mjs';
import { defaultStateRoot } from './run.mjs';

const runtimeName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const portableEntries = ['browsers', 'pillow', 'python', 'uv-arm', 'uv-wheel', 'venv'];

function reject(code, message) { throw new RunnerValidationError(code, message); }
async function directory(path, code, message) {
  try { if ((await stat(path)).isDirectory()) return; } catch {}
  reject(code, message);
}

export function runtimeDirectory(stateRoot = defaultStateRoot()) { return join(stateRoot, 'runtimes'); }
export function runtimePath(name, stateRoot = defaultStateRoot()) {
  if (!runtimeName.test(name)) reject('RUNTIME_NAME_INVALID', 'Runtime name must use lowercase letters, digits, dots, underscores, or dashes.');
  return join(runtimeDirectory(stateRoot), name);
}
export function runtimeManifestPath(name, stateRoot = defaultStateRoot()) { return join(runtimePath(name, stateRoot), 'runtime.json'); }

async function digestDirectory(path) {
  const hash = createHash('sha256');
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'cache') continue;
      const child = join(current, entry.name);
      const next = join(relative, entry.name);
      if (entry.isDirectory()) { hash.update(`directory\0${next}\0`); await visit(child, next); }
      else if (entry.isSymbolicLink()) { hash.update(`symlink\0${next}\0`); }
      else if (entry.isFile()) { const metadata = await stat(child); hash.update(`file\0${next}\0${metadata.size}\0`); }
    }
  }
  await visit(path);
  return hash.digest('hex');
}

export async function importRuntime({ name, source, includeCache = false, stateRoot = defaultStateRoot() } = {}) {
  if (!runtimeName.test(name ?? '')) reject('RUNTIME_NAME_INVALID', 'Runtime name must use lowercase letters, digits, dots, underscores, or dashes.');
  if (typeof source !== 'string' || !source) reject('RUNTIME_SOURCE_REQUIRED', 'A runtime source directory is required.');
  if (typeof includeCache !== 'boolean') reject('RUNTIME_CACHE_INVALID', 'includeCache must be a boolean.');
  const sourcePath = resolve(source);
  await directory(sourcePath, 'RUNTIME_SOURCE_MISSING', `Runtime source directory does not exist: ${sourcePath}`);
  for (const required of ['browsers', 'venv', 'python']) await directory(join(sourcePath, required), 'RUNTIME_SOURCE_INVALID', `Runtime source is missing ${required}/.`);
  const target = runtimePath(name, stateRoot);
  const parent = runtimeDirectory(stateRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.import-${name}-${randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    const entries = includeCache ? [...portableEntries, 'cache'] : portableEntries;
    const copied = [];
    for (const entry of entries) {
      try { await directory(join(sourcePath, entry), 'RUNTIME_SOURCE_INVALID', ''); }
      catch (error) { if (error.code === 'RUNTIME_SOURCE_INVALID') continue; throw error; }
      await cp(join(sourcePath, entry), join(staging, entry), { recursive: true, dereference: false });
      copied.push(entry);
    }
    const manifest = { version: 'v1', name, containerPath: '/workspace/runtime', digest: await digestDirectory(staging), entries: copied, cacheIncluded: includeCache, importedAt: new Date().toISOString() };
    await writeFile(join(staging, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return { ...manifest, path: target };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function resolveRuntime(name, { stateRoot = defaultStateRoot() } = {}) {
  const path = runtimePath(name, stateRoot);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(path, 'runtime.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') reject('RUNTIME_NOT_FOUND', `No managed runtime named "${name}" exists. Import it first with isolated-harness runtime import --name <name> --source <directory>.`); throw error; }
  if (manifest.version !== 'v1' || manifest.name !== name || manifest.containerPath !== '/workspace/runtime' || typeof manifest.digest !== 'string') reject('RUNTIME_MANIFEST_INVALID', `Runtime manifest is invalid: ${path}`);
  for (const required of ['browsers', 'venv', 'python']) await directory(join(path, required), 'RUNTIME_MANIFEST_INVALID', `Managed runtime is missing ${required}/.`);
  return { ...manifest, path };
}

export async function listRuntimes({ stateRoot = defaultStateRoot() } = {}) {
  try {
    const entries = await readdir(runtimeDirectory(stateRoot), { withFileTypes: true });
    const runtimes = await Promise.all(entries.filter(entry => entry.isDirectory() && runtimeName.test(entry.name)).map(entry => resolveRuntime(entry.name, { stateRoot }).catch(() => null)));
    return runtimes.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

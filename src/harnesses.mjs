import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateRoot } from './run.mjs';
import { codexVersionPattern, dockerOutput, inspectImage } from './images.mjs';
import { readMacOsTrustBundle, resolveHostProxy } from './network.mjs';
import { RunnerValidationError } from './errors.mjs';

const builtins = [
  { id: 'codex-cli', package: '@openai/codex', command: 'codex', seed: '/usr/local/lib/node_modules/@openai/codex' },
  { id: 'claude-code', package: '@anthropic-ai/claude-code', command: 'claude' },
];
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const programMount = '/opt/isolated-harness/program';
const controlMount = '/run/harness-control';
const checkInterval = 60 * 60 * 1000;
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path, value) {
  const staging = `${path}.${randomUUID()}.tmp`;
  await writeFile(staging, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(staging, path);
}

export function validateHarness(raw) {
  if (!identifier.test(raw?.id ?? '') || !identifier.test(raw?.command ?? '') || !packageName.test(raw?.package ?? '')) throw new RunnerValidationError('HARNESS_INVALID', 'A harness needs a safe id, npm package name, and executable command.');
  if (['node', 'npm', 'harness-update'].includes(raw.command)) throw new RunnerValidationError('HARNESS_INVALID', 'The harness executable conflicts with an updater command.');
  return { id: raw.id, package: raw.package, command: raw.command };
}
export async function listHarnesses({ stateRoot = defaultStateRoot() } = {}) {
  const extra = await readdir(join(stateRoot, 'harness-registry')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return [...builtins, ...await Promise.all(extra.filter(name => name.endsWith('.json')).map(async name => validateHarness(await json(join(stateRoot, 'harness-registry', name)))))];
}
export async function registerHarness(raw, { stateRoot = defaultStateRoot() } = {}) {
  const harness = validateHarness(raw);
  if (builtins.some(item => item.id === harness.id)) throw new RunnerValidationError('HARNESS_BUILTIN', 'Built-in harness registrations cannot be replaced.');
  await mkdir(join(stateRoot, 'harness-registry'), { recursive: true, mode: 0o700 });
  await save(join(stateRoot, 'harness-registry', `${harness.id}.json`), harness);
  return harness;
}
async function descriptor(id, stateRoot) {
  const harness = (await listHarnesses({ stateRoot })).find(item => item.id === id);
  if (!harness) throw new RunnerValidationError('HARNESS_NOT_REGISTERED', `Unknown harness: ${id}`);
  return harness;
}
export async function resolveHarnessVersion(harness, version = 'latest', { fetchMetadata = fetch } = {}) {
  if (version === 'latest') {
    const response = await fetchMetadata(`https://registry.npmjs.org/${encodeURIComponent(harness.package)}/latest`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Harness version check failed: HTTP ${response.status}`);
    version = (await response.json()).version;
  }
  if (!codexVersionPattern.test(version ?? '')) throw new RunnerValidationError('HARNESS_VERSION_INVALID', 'Use latest or an exact semantic version.');
  return version;
}

async function lock(root) {
  const path = join(root, '.update-lock');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (true) {
    try { await mkdir(path); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await json(join(path, 'owner.json')).catch(() => null);
      const metadata = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!metadata) continue;
      if (!owner && Date.now() - metadata.mtimeMs > 30_000) { await rm(path, { recursive: true, force: true }); continue; }
      if (owner?.pid) {
        try { process.kill(owner.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { await rm(path, { recursive: true, force: true }); continue; } }
      }
      if (Date.now() > deadline) throw new RunnerValidationError('HARNESS_UPDATE_BUSY', 'Another harness update is still running.');
      await pause(100);
    }
  }
  try { await save(join(path, 'owner.json'), { pid: process.pid }); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return () => rm(path, { recursive: true, force: true });
}

/** Program releases are separate from environment/runtime images. Only the
 * installer container sees a writable staging release; sessions see releases
 * read-only and can request an atomic upgrade through their private broker. */
export async function prepareHarness({ id = 'codex-cli', image = 'codex-cli:local', version = 'latest', autoUpdate = true, offline = false, force = false, stateRoot = defaultStateRoot(), fetchMetadata = fetch, docker = dockerOutput, inspect = inspectImage, resolveProxy = resolveHostProxy, readTrustBundle = readMacOsTrustBundle } = {}) {
  const harness = await descriptor(id, stateRoot);
  if (version !== 'latest' && !codexVersionPattern.test(version)) throw new RunnerValidationError('HARNESS_VERSION_INVALID', 'Use latest or an exact semantic version.');
  if (force && offline) throw new RunnerValidationError('HARNESS_OFFLINE', 'Harness updates are unavailable offline.');
  const base = await inspect(image);
  if (!/^linux\/[a-z0-9_]+$/.test(base.platform)) throw new RunnerValidationError('HARNESS_PLATFORM_INVALID', 'Harness programs require a supported Linux container platform.');
  const root = join(stateRoot, 'harness-programs', id, base.platform.replace('/', '-'));
  await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 });
  const releaseLock = await lock(root);
  try {
    let current = await json(join(root, 'current.json')).catch(() => null);
    if (current?.package !== harness.package || !/^[a-z0-9._-]+$/.test(current?.release ?? '')) current = null;
    if (current && !(await stat(join(root, 'releases', current.release, 'bin', harness.command)).catch(() => null))) current = null;
    if (version !== 'latest' && !force) {
      for (const entry of await readdir(join(root, 'releases'))) {
        if (!/^[a-z0-9._-]+$/.test(entry)) continue;
        const saved = await json(join(root, 'releases', entry, 'release.json')).catch(() => null);
        if (saved?.version === version && saved.package === harness.package && await stat(join(root, 'releases', entry, 'bin', harness.command)).catch(() => null)) return { ...saved, root, harness, reused: true };
      }
    }
    const cachedCheck = await json(join(root, 'check.json')).catch(() => null);
    let target = version === 'latest' ? current?.version : version;
    let updateError;
    if (!offline && (force || (autoUpdate && (!current || Date.now() - (cachedCheck?.checkedAt ?? 0) >= checkInterval)))) {
      try {
        target = await resolveHarnessVersion(harness, version, { fetchMetadata });
        if (version === 'latest' || force) await save(join(root, 'check.json'), { checkedAt: Date.now(), version: target });
      } catch (error) {
        if (force || version !== 'latest') throw error;
        updateError = error.message;
        await save(join(root, 'check.json'), { checkedAt: Date.now() - checkInterval + 60_000, error: updateError });
      }
    }
    if (current && (!target || current.version === target)) return { ...current, root, harness, updateError, reused: true };
    const seedVersion = harness.seed ? base.codexVersion ?? JSON.parse(await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, `${harness.seed}/package.json`])).version : null;
    if (!current && !target) target = seedVersion;
    if (!target) throw new RunnerValidationError('HARNESS_INSTALL_REQUIRED', `No cached ${id} is available. Open an online session to install it first.`);
    if (!codexVersionPattern.test(target)) throw new RunnerValidationError('HARNESS_VERSION_INVALID', 'The resolved harness version is invalid.');
    const seeded = Boolean(harness.seed && target === seedVersion);
    if (offline && !seeded) throw new RunnerValidationError('HARNESS_OFFLINE', 'The requested harness version is not cached and cannot be downloaded offline.');
    const release = `${target.toLowerCase().replaceAll('+', '-')}-${randomUUID()}`;
    const destination = join(root, 'releases', release);
    await mkdir(destination);
    try {
      const proxy = offline ? { environment: {} } : await resolveProxy();
      const certificate = offline ? undefined : await readTrustBundle();
      const trustPath = join(root, `.trust-${randomUUID()}.pem`);
      const cache = join(stateRoot, 'harness-download-cache', base.platform.replace('/', '-'));
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const args = ['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--user=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--network', offline ? 'none' : 'bridge', '--entrypoint', 'sh', '--tmpfs', '/tmp:rw,nosuid,size=256m', '--env', 'HOME=/tmp', '--mount', `type=bind,src=${destination},dst=/program`, '--mount', `type=bind,src=${cache},dst=/npm-cache`, '--env', 'npm_config_cache=/npm-cache'];
      for (const [key, value] of Object.entries(proxy.environment)) args.push('--env', `${key}=${value}`);
      if (certificate) {
        await writeFile(trustPath, certificate, { mode: 0o600 });
        args.push('--mount', `type=bind,src=${trustPath},dst=/run/harness-trust.pem,readonly`, '--env', 'NODE_EXTRA_CA_CERTS=/run/harness-trust.pem');
      }
      const command = seeded
        ? `mkdir -p /program/lib/node_modules/@openai /program/bin && cp -a ${harness.seed} /program/lib/node_modules/@openai/codex && ln -s ../lib/node_modules/@openai/codex/bin/codex.js /program/bin/codex`
        : `npm install --global --prefix /program --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 '${harness.package}@${target}'`;
      try { await docker([...args, image, '-c', command]); }
      finally { await rm(trustPath, { force: true }); }
      const packagePath = join(destination, 'lib/node_modules', harness.package, 'package.json');
      const installed = await json(packagePath);
      if (installed.version !== target) throw new Error('Installed harness version does not match the requested version.');
      await docker(['run', '--rm', '--read-only', '--network', 'none', '--entrypoint', `/program/bin/${harness.command}`, '--mount', `type=bind,src=${destination},dst=/program,readonly`, '--tmpfs', '/tmp:rw,nosuid,size=64m', '--env', 'HOME=/tmp', image, '--version']);
      const installedRelease = { id, package: harness.package, command: harness.command, version: target, release, platform: base.platform, installedAt: new Date().toISOString() };
      await save(join(destination, 'release.json'), installedRelease);
      if (version === 'latest' || force) await save(join(root, 'current.json'), installedRelease);
      return { ...installedRelease, root, harness, seeded };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      if (current && !force && version === 'latest') return { ...current, root, harness, updateError: error.message, reused: true };
      throw error;
    }
  } finally { await releaseLock(); }
}

export async function createHarnessSession({ id = 'codex-cli', image, stateRoot = defaultStateRoot(), offline = false, autoUpdate = true, version = 'latest', prepare = prepareHarness } = {}) {
  const options = { id, image, stateRoot, offline, autoUpdate, version };
  const program = await prepare(options);
  const parent = join(stateRoot, 'harness-controls');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'session-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await copyFile(fileURLToPath(new URL('./harness-client.mjs', import.meta.url)), join(directory, 'client.mjs'));
  await save(join(directory, 'session.json'), { id, command: program.command, package: program.package, release: version === 'latest' ? null : program.release, offline, programRoot: programMount });
  for (const command of [program.command, 'harness-update', 'npm']) await writeFile(join(bin, command), `#!/bin/sh\nexec node ${controlMount}/client.mjs ${command} "$@"\n`, { mode: 0o755 });
  let busy;
  let stopped = false;
  const poll = async () => {
    if (stopped || busy) return;
    const request = (await readdir(directory)).find(name => /^[a-f0-9-]{36}\.request\.json$/.test(name));
    if (!request) return;
    busy = (async () => {
      const requestPath = join(directory, request);
      const responsePath = join(directory, request.replace('.request.', '.response.'));
      try {
        const file = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let message;
        try {
          if (!(await file.stat()).isFile()) throw new Error('Update requests must be regular files.');
          const buffer = Buffer.alloc(4097);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 4096) throw new Error('Update request is too large.');
          message = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        } finally { await file.close(); }
        if (message.action !== 'update' || Object.keys(message).some(key => !['action', 'version'].includes(key))) throw new Error('Unsupported harness update request.');
        if (offline) throw new RunnerValidationError('HARNESS_OFFLINE', 'Updates are unavailable in an offline session.');
        if (version !== 'latest') throw new RunnerValidationError('HARNESS_VERSION_PINNED', 'This session is pinned to an exact harness version.');
        const updated = await prepare({ ...options, version: message.version ?? 'latest', force: true });
        await save(responsePath, { ok: true, version: updated.version });
      } catch (error) { await save(responsePath, { ok: false, error: error.message }); }
      finally { await rm(requestPath, { recursive: true, force: true }); }
    })().finally(() => { busy = null; });
    await busy;
  };
  const timer = setInterval(() => { poll().catch(() => {}); }, 100);
  let refreshing;
  const refreshTimer = !offline && autoUpdate && version === 'latest' ? setInterval(() => {
    if (!refreshing) refreshing = prepare(options).catch(() => {}).finally(() => { refreshing = null; });
  }, checkInterval) : null;
  return {
    program, directory,
    dockerArgs: ['--mount', `type=bind,src=${program.root},dst=${programMount},readonly`, '--mount', `type=bind,src=${directory},dst=${controlMount}`],
    command: ['node', `${controlMount}/client.mjs`, program.command],
    async close() { stopped = true; clearInterval(timer); clearInterval(refreshTimer); await Promise.allSettled([busy, refreshing]); await rm(directory, { recursive: true, force: true }); },
  };
}

import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerValidationError } from './errors.mjs';
import { defaultStateRoot } from './run.mjs';
import { readMacOsTrustBundle, resolveHostProxy } from './network.mjs';
import { dockerOutput, inspectImage } from './images.mjs';

const environmentName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const imageName = /^[a-z0-9][a-z0-9._/@:+-]{0,255}$/i;
const aptPackage = /^[a-z0-9][a-z0-9+._-]{0,127}$/;
const pipRequirement = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:==[A-Za-z0-9.*+!._-]+)?$/;
const playwrightBrowser = new Set(['chromium', 'firefox', 'webkit']);
const pythonVersions = new Set(['3.12']);
const packageMirrors = new Set(['tuna']);
// Bump this whenever the `/workspace/runtime` linkage changes. It prevents a
// stale local image with the same dependency spec from silently retaining an
// older runtime contract.
const runtimeContractVersion = 'v3';
const waitForExit = child => new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)); });

function reject(code, message) { throw new RunnerValidationError(code, message); }
function normalizeStringList(value, name, matcher) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !matcher.test(item))) reject('ENVIRONMENT_SPEC_INVALID', `${name} must contain safe package identifiers.`);
  return [...new Set(value)].sort();
}

export function parseEnvironmentSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('ENVIRONMENT_SPEC_INVALID', 'Environment spec must be a JSON object.');
  const allowed = new Set(['version', 'name', 'baseImage', 'apt', 'pip', 'playwright', 'pythonVersion', 'packageMirror', 'workspaceRuntime', 'trustedCaFile', 'bundledRuntimeDigest']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) reject('ENVIRONMENT_SPEC_UNKNOWN_FIELD', `Unknown environment field: ${key}`);
  if (raw.version !== 'v1') reject('ENVIRONMENT_SPEC_VERSION', 'Environment spec version must be "v1".');
  if (typeof raw.name !== 'string' || !environmentName.test(raw.name)) reject('ENVIRONMENT_NAME_INVALID', 'Environment name must use lowercase letters, digits, dots, underscores, or dashes.');
  if (typeof raw.baseImage !== 'string' || !imageName.test(raw.baseImage)) reject('ENVIRONMENT_BASE_IMAGE_INVALID', 'baseImage must be a safe Docker image reference.');
  if (raw.pythonVersion !== undefined && (typeof raw.pythonVersion !== 'string' || !pythonVersions.has(raw.pythonVersion))) reject('ENVIRONMENT_PYTHON_VERSION_INVALID', 'pythonVersion must be a supported image runtime version.');
  if (raw.packageMirror !== undefined && (typeof raw.packageMirror !== 'string' || !packageMirrors.has(raw.packageMirror))) reject('ENVIRONMENT_MIRROR_INVALID', 'packageMirror must name a supported package mirror.');
  if (raw.workspaceRuntime !== undefined && typeof raw.workspaceRuntime !== 'boolean') reject('ENVIRONMENT_RUNTIME_INVALID', 'workspaceRuntime must be a boolean.');
  if (raw.trustedCaFile !== undefined && (typeof raw.trustedCaFile !== 'string' || !raw.trustedCaFile.startsWith('/'))) reject('ENVIRONMENT_CA_INVALID', 'trustedCaFile must be an absolute PEM file path.');
  if (raw.bundledRuntimeDigest !== undefined && (typeof raw.bundledRuntimeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bundledRuntimeDigest))) reject('ENVIRONMENT_RUNTIME_DIGEST_INVALID', 'bundledRuntimeDigest must be a sha256 digest.');
  const apt = normalizeStringList(raw.apt, 'apt', aptPackage);
  const playwright = raw.playwright === undefined ? [] : raw.playwright;
  if (!Array.isArray(playwright) || playwright.some(browser => typeof browser !== 'string' || !playwrightBrowser.has(browser))) reject('ENVIRONMENT_PLAYWRIGHT_INVALID', 'playwright may contain only chromium, firefox, or webkit.');
  const pip = normalizeStringList(raw.pip, 'pip', pipRequirement);
  if (playwright.length && !pip.some(requirement => requirement.split('==')[0] === 'playwright')) pip.push('playwright');
  return { version: 'v1', name: raw.name, baseImage: raw.baseImage, apt, pip: pip.sort(), playwright: [...new Set(playwright)].sort(), pythonVersion: raw.pythonVersion, packageMirror: raw.packageMirror, workspaceRuntime: raw.workspaceRuntime ?? Boolean(pip.length || playwright.length), trustedCaFile: raw.trustedCaFile, bundledRuntimeDigest: raw.bundledRuntimeDigest };
}

export async function loadEnvironmentSpec(path) {
  const source = resolve(path);
  let raw;
  try { raw = JSON.parse(await readFile(source, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) reject('ENVIRONMENT_SPEC_JSON_INVALID', `Environment spec is not valid JSON: ${source}`); throw error; }
  const spec = parseEnvironmentSpec(raw);
  return { ...spec, source };
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Runtime dependencies have their own identity. Neither an environment's name
// nor the Codex version should invalidate several GB of Python/browser layers.
export function dependencyDigest(spec) {
  return hash({ base: spec.baseImage === 'codex-cli:local' ? 'node:22-bookworm-slim' : spec.baseImage, apt: spec.apt, pip: spec.pip, playwright: spec.playwright, pythonVersion: spec.pythonVersion ?? null, packageMirror: spec.packageMirror ?? null, bundledRuntimeDigest: spec.bundledRuntimeDigest ?? null });
}
export function environmentDigest(spec, identity = {}) {
  return hash({ version: spec.version, runtimeContractVersion, dependencies: dependencyDigest(spec), workspaceRuntime: spec.workspaceRuntime, ...identity });
}
export function environmentImage(spec, identity) { return `isolated-harness-env-${spec.name}:${environmentDigest(spec, identity).slice(0, 12)}`; }
export function environmentDirectory(stateRoot = defaultStateRoot()) { return join(stateRoot, 'environments'); }
export function environmentManifestPath(name, stateRoot = defaultStateRoot()) {
  if (!environmentName.test(name)) reject('ENVIRONMENT_NAME_INVALID', 'Environment name is invalid.');
  return join(environmentDirectory(stateRoot), `${name}.json`);
}

export function renderEnvironmentDockerfile(spec, { includeTrustedCa = Boolean(spec.trustedCaFile), bundledRuntime = false, runtimeImage, repairBrowsers = false, baseImage = spec.baseImage } = {}) {
  const apt = [...spec.apt, ...(spec.pip.length && !spec.pythonVersion ? ['python3', 'python3-venv'] : []), ...(spec.pip.length || includeTrustedCa ? ['ca-certificates'] : [])];
  const separateCodex = spec.baseImage === 'codex-cli:local';
  const lines = [...(separateCodex ? [`FROM ${baseImage} AS isolated-harness-codex`] : []), ...(!runtimeImage && spec.pythonVersion ? [`FROM python:${spec.pythonVersion}-slim-bookworm AS isolated-harness-python`] : []), `FROM ${runtimeImage ?? (separateCodex ? 'node:22-bookworm-slim' : baseImage)} AS isolated-harness-dependencies`, 'USER root', 'ARG TARGETOS', 'ARG TARGETARCH'];
  if (!runtimeImage) {
    if (spec.packageMirror === 'tuna' && apt.length) lines.push('RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*');
    if (includeTrustedCa && spec.packageMirror === 'tuna') lines.push('COPY trusted-ca.pem /usr/local/share/ca-certificates/isolated-harness.crt', 'RUN update-ca-certificates');
    if (spec.packageMirror === 'tuna') lines.push("RUN for source in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do [ -f \"$source\" ] || continue; sed -i -E 's#https?://deb.debian.org/debian([[:space:]]|$)#https://mirrors.tuna.tsinghua.edu.cn/debian\\1#g' \"$source\"; done", 'ENV PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple');
    if (spec.pythonVersion) lines.push('COPY --from=isolated-harness-python /usr/local /usr/local');
    const packages = spec.packageMirror === 'tuna' ? apt.filter(item => item !== 'ca-certificates') : apt;
    if (packages.length) lines.push(`RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ${[...new Set(packages)].join(' ')} && rm -rf /var/lib/apt/lists/*`);
    if (includeTrustedCa && spec.packageMirror !== 'tuna') lines.push('COPY trusted-ca.pem /usr/local/share/ca-certificates/isolated-harness.crt', 'RUN update-ca-certificates');
    if (spec.pip.length) lines.push('RUN --mount=type=cache,id=isolated-harness-pip,target=/root/.cache/pip,sharing=locked python3 -m venv /opt/isolated-harness/python && /opt/isolated-harness/python/bin/pip install --disable-pip-version-check ' + spec.pip.join(' '));
    if (spec.playwright.length) {
      if (bundledRuntime) lines.push('COPY bundled-runtime/browsers /opt/ms-playwright');
      // This cache is build-only. Sessions use immutable image layers.
      lines.push(`RUN --mount=type=cache,id=isolated-harness-browsers-\${TARGETOS}-\${TARGETARCH},target=/var/cache/isolated-harness-browsers,sharing=locked ${bundledRuntime ? 'cp -a /opt/ms-playwright/. /var/cache/isolated-harness-browsers/ && ' : ''}PLAYWRIGHT_SKIP_BROWSER_GC=1 NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt PLAYWRIGHT_BROWSERS_PATH=/var/cache/isolated-harness-browsers /opt/isolated-harness/python/bin/python -m playwright install --with-deps ${spec.playwright.join(' ')} && mkdir -p /opt/ms-playwright && cp -a /var/cache/isolated-harness-browsers/. /opt/ms-playwright/`);
      lines.push('ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright');
    }
  }
  if (runtimeImage) {
    // Trust is local configuration, not a Python/browser dependency. A CA
    // change must not cause the whole runtime to be downloaded again.
    lines.push('RUN rm -f /usr/local/share/ca-certificates/isolated-harness.crt');
    if (includeTrustedCa) lines.push('COPY trusted-ca.pem /usr/local/share/ca-certificates/isolated-harness.crt');
    lines.push('RUN if command -v update-ca-certificates >/dev/null; then update-ca-certificates --fresh; fi');
    if (repairBrowsers && spec.playwright.length) lines.push(`RUN --mount=type=cache,id=isolated-harness-browsers-\${TARGETOS}-\${TARGETARCH},target=/var/cache/isolated-harness-browsers,sharing=locked cp -a /opt/ms-playwright/. /var/cache/isolated-harness-browsers/ && PLAYWRIGHT_SKIP_BROWSER_GC=1 NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt PLAYWRIGHT_BROWSERS_PATH=/var/cache/isolated-harness-browsers /opt/isolated-harness/python/bin/python -m playwright install ${spec.playwright.join(' ')} && cp -a /var/cache/isolated-harness-browsers/. /opt/ms-playwright/`);
  }
  if (spec.pip.length) lines.push('ENV VIRTUAL_ENV=/opt/isolated-harness/python', 'ENV PATH=/opt/isolated-harness/python/bin:${PATH}', 'ENV UV_SYSTEM_CERTS=true');
  if (spec.playwright.length) lines.push('ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright');
  lines.push('FROM isolated-harness-dependencies AS isolated-harness-environment');
  if (separateCodex) lines.push('COPY --from=isolated-harness-codex /usr/local/lib/node_modules/@openai/codex /usr/local/lib/node_modules/@openai/codex', 'RUN ln -sf /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex');
  if (spec.workspaceRuntime) lines.push('COPY runtime-entrypoint.sh /usr/local/bin/isolated-harness-runtime', 'RUN chmod 0755 /usr/local/bin/isolated-harness-runtime', 'ENTRYPOINT ["/usr/local/bin/isolated-harness-runtime"]');
  else lines.push('ENTRYPOINT []');
  lines.push('USER node', 'CMD ["codex"]', '');
  return lines.join('\n');
}

function savedSpec(manifest) {
  const { source: _source, trustedCaFile: _ca, ...raw } = manifest.spec ?? {};
  return parseEnvironmentSpec(raw);
}

export async function buildEnvironment(specPath, { runtimeSource, stateRoot = defaultStateRoot(), spawnProcess = spawn, resolveProxy = resolveHostProxy, readTrustBundle = readMacOsTrustBundle } = {}) {
  let spec = await loadEnvironmentSpec(specPath);
  const existing = await listEnvironments({ stateRoot });
  const previous = existing.find(item => item.name === spec.name);
  // Preserve an existing browser seed across ordinary rebuilds. The final
  // image uses its declared Python packages, never the seed's older virtualenv.
  if (!runtimeSource && previous?.spec?.bundledRuntimeDigest) spec.bundledRuntimeDigest = previous.spec.bundledRuntimeDigest;
  if (runtimeSource) {
    const source = resolve(runtimeSource);
    for (const required of ['browsers', 'venv', 'python']) {
      try { if (!(await stat(join(source, required))).isDirectory()) throw new Error(); }
      catch { reject('ENVIRONMENT_RUNTIME_SOURCE_INVALID', `Bundled runtime is missing ${required}/: ${source}`); }
    }
    const manifest = JSON.parse(await readFile(join(source, 'runtime.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(manifest.digest ?? '')) reject('ENVIRONMENT_RUNTIME_SOURCE_INVALID', 'Bundled runtime manifest has no valid digest.');
    spec.bundledRuntimeDigest = manifest.digest;
    runtimeSource = source;
  }
  const base = await inspectImage(spec.baseImage, { spawnProcess });
  const context = await mkdtemp(join(tmpdir(), 'isolated-harness-environment-'));
  try {
    const proxy = await resolveProxy();
    const trustBundle = spec.trustedCaFile ? await readFile(spec.trustedCaFile, 'utf8') : proxy.status === 'configured' ? await readTrustBundle() : undefined;
    const trust = trustBundle ? (spec.trustedCaFile ? 'explicit-file' : 'host-keychain') : 'none';
    const trustDigest = trustBundle ? createHash('sha256').update(trustBundle).digest('hex') : null;
    const dependencies = dependencyDigest(spec);
    const runtimeDigest = hash({ dependencies, platform: base.platform });
    const identity = { baseImageId: base.id, platform: base.platform, trustDigest };
    // A failed replacement must never overwrite the tag selected by an older
    // manifest, even when inputs are identical (e.g. an unpinned rebuild).
    const image = `${environmentImage(spec, identity)}-${randomUUID().slice(0, 8)}`;
    const digest = environmentDigest(spec, identity);
    if (previous?.digest === digest && previous.runtimeImage) {
      const available = await inspectImage(previous.image, { spawnProcess }).catch(() => null);
      if (available && (!previous.imageId || available.id === previous.imageId)) return { ...previous, reused: true };
    }
    let runtimeImage;
    let repairBrowsers = false;
    for (const candidate of existing) {
      let candidateSpec;
      try { candidateSpec = savedSpec(candidate); } catch { continue; }
      if (dependencyDigest(candidateSpec) !== dependencies) continue;
      if (spec.baseImage !== 'codex-cli:local' && candidate.baseImageId !== base.id) continue;
      // Reuse the dependency snapshot, never stack a previous final Codex
      // image on every upgrade. Legacy snapshots are accepted for migration.
      const legacySnapshot = `isolated-harness-runtime:${runtimeDigest.slice(0, 24)}`;
      const source = candidate.runtimeImage ?? legacySnapshot;
      let available = await inspectImage(source, { spawnProcess }).catch(() => null);
      if (available && candidate.runtimeImageId && candidate.runtimeImageId !== available.id) continue;
      if (!available) {
        available = await inspectImage(candidate.image, { spawnProcess }).catch(() => null);
        if (available && candidate.imageId && candidate.imageId !== available.id) continue;
      }
      if (!available || available.platform !== base.platform) continue;
      runtimeImage = `isolated-harness-runtime-source:${available.id.replace('sha256:', '')}`;
      repairBrowsers = !candidate.runtimeImage || candidate.runtimeContractVersion !== runtimeContractVersion;
      await dockerOutput(['tag', available.id, runtimeImage], { spawnProcess });
      break;
    }
    if (!runtimeImage && spec.bundledRuntimeDigest && !runtimeSource) {
      // Locate a previously imported seed only if a fresh dependency build is
      // necessary. Never silently drop a declared artifact.
      const { listRuntimes } = await import('./runtimes.mjs');
      runtimeSource = (await listRuntimes({ stateRoot })).find(item => item.digest === spec.bundledRuntimeDigest)?.path;
      if (!runtimeSource) reject('ENVIRONMENT_RUNTIME_SOURCE_MISSING', 'The previous browser seed is unavailable. Supply --runtime-source, or reset this environment and build again to stop using that seed.');
    }
    const baseImage = `isolated-harness-base:${base.id.replace('sha256:', '')}`;
    await dockerOutput(['tag', base.id, baseImage], { spawnProcess });
    if (trustBundle) await writeFile(join(context, 'trusted-ca.pem'), trustBundle, { mode: 0o600 });
    if (runtimeSource && !runtimeImage && spec.playwright.length) await cp(join(runtimeSource, 'browsers'), join(context, 'bundled-runtime/browsers'), { recursive: true, dereference: false });
    await copyFile(fileURLToPath(new URL('./runtime-entrypoint.sh', import.meta.url)), join(context, 'runtime-entrypoint.sh'));
    await writeFile(join(context, 'Dockerfile'), renderEnvironmentDockerfile(spec, { includeTrustedCa: Boolean(trustBundle), bundledRuntime: Boolean(runtimeSource), runtimeImage, repairBrowsers, baseImage }), { mode: 0o600 });
    const runtimeBuildTag = `isolated-harness-runtime-build:${randomUUID()}`;
    const build = async (tag, target) => {
      const args = ['build', '--tag', tag];
      if (target) args.push('--target', target);
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (proxy.environment[key]) args.push('--build-arg', `${key}=${proxy.environment[key]}`);
      args.push('.');
      const child = spawnProcess('docker', args, { cwd: context, env: { ...process.env, DOCKER_BUILDKIT: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
      const exitCode = await waitForExit(child);
      if (exitCode !== 0) throw new Error(`Docker environment build exited ${exitCode}`);
    };
    await build(runtimeBuildTag, 'isolated-harness-dependencies');
    const snapshot = await inspectImage(runtimeBuildTag, { spawnProcess });
    const runtimeSnapshot = `isolated-harness-runtime:${snapshot.id.replace('sha256:', '')}`;
    await dockerOutput(['tag', snapshot.id, runtimeSnapshot], { spawnProcess });
    await dockerOutput(['image', 'rm', runtimeBuildTag], { spawnProcess });
    await build(image);
    const built = await inspectImage(image, { spawnProcess });
    const { source: _source, ...manifestSpec } = spec;
    const manifest = { version: 'v1', name: spec.name, image, imageId: built.id, digest, runtimeContractVersion, runtimeDigest, runtimeImage: runtimeSnapshot, runtimeImageId: snapshot.id, dependencies, baseImageId: base.id, codexVersion: base.codexVersion, platform: base.platform, trustDigest, runtimeReused: Boolean(runtimeImage), spec: { ...manifestSpec, trustedCaFile: spec.trustedCaFile ? basename(spec.trustedCaFile) : null }, builtAt: new Date().toISOString(), proxy: proxy.status, trust };
    // Publish only after the new image passes the no-network runtime proof.
    await verifyEnvironmentImage(manifest, { spawnProcess });
    await mkdir(environmentDirectory(stateRoot), { recursive: true, mode: 0o700 });
    const destination = environmentManifestPath(spec.name, stateRoot);
    const staging = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(staging, destination);
    return manifest;
  } finally { await rm(context, { recursive: true, force: true }); }
}

export async function resolveEnvironment(name, { stateRoot = defaultStateRoot() } = {}) {
  const path = environmentManifestPath(name, stateRoot);
  let manifest;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') reject('ENVIRONMENT_NOT_FOUND', `No built environment named "${name}" exists. Build it first with isolated-harness environment build --spec <file>.`); throw error; }
  if (manifest.version !== 'v1' || typeof manifest.image !== 'string' || !imageName.test(manifest.image)) reject('ENVIRONMENT_MANIFEST_INVALID', `Environment manifest is invalid: ${path}`);
  return manifest;
}

export async function listEnvironments({ stateRoot = defaultStateRoot() } = {}) {
  try {
    const files = await readdir(environmentDirectory(stateRoot));
    const manifests = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readFile(join(environmentDirectory(stateRoot), file), 'utf8').then(JSON.parse)));
    return manifests.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

const pythonImportName = requirement => ({ pymupdf: 'fitz', pillow: 'PIL' }[requirement.split('==')[0]] ?? requirement.split('==')[0]);

/** A no-network proof that the runtime links and declared dependencies are usable.
 * Keep this generated from the environment spec so the test cannot accidentally
 * drift from the image contract that the agent receives. */
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function environmentVerificationScript(spec, { codexVersion } = {}) {
  const python = spec.workspaceRuntime ? '/workspace/runtime/venv/bin/python' : '/opt/isolated-harness/python/bin/python';
  const code = spec.pip.map(pythonImportName).map(name => `import ${name}`);
  if (spec.playwright.length) {
    code.push('from playwright.sync_api import sync_playwright', 'with sync_playwright() as p:');
    for (const browser of spec.playwright) code.push(`    browser = p.${browser}.launch(headless=True)`, '    browser.close()');
  }
  const checks = ['mkdir -p /tmp/isolated-harness-home', 'export HOME=/tmp/isolated-harness-home'];
  if (spec.workspaceRuntime && spec.pip.length) checks.push('test -L /workspace/runtime/venv', 'test -L /workspace/runtime/python', `test -x ${python}`);
  if (code.length) checks.push(`${python} -c ${shellQuote(code.join('\n'))}`);
  if (codexVersion) checks.push(`test "$(codex --version)" = ${shellQuote(`codex-cli ${codexVersion}`)}`);
  return checks.join(' && ');
}

async function verifyEnvironmentImage(environment, { spawnProcess = spawn } = {}) {
  const spec = savedSpec(environment);
  const workspace = await mkdtemp(join(tmpdir(), 'isolated-harness-runtime-verify-'));
  await chmod(workspace, 0o777);
  const imports = spec.pip.map(pythonImportName).filter(Boolean);
  try {
    const args = [
      'run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network', 'none', '--user=1000:1000', '--workdir', '/workspace',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
    ];
    if (spec.workspaceRuntime) args.push('--tmpfs', '/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m', '--env', 'ISOLATED_HARNESS_RUNTIME_MODE=environment-image', '--env', 'ISOLATED_HARNESS_RUNTIME_PATH=/workspace/runtime', '--env', 'PLAYWRIGHT_BROWSERS_PATH=/workspace/runtime/browsers');
    args.push(environment.image, 'sh', '-c', environmentVerificationScript(spec, environment));
    const child = spawnProcess('docker', args, { stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', value => { stdout += value; });
    child.stderr?.on('data', value => { stderr += value; });
    const exitCode = await waitForExit(child);
    if (exitCode !== 0) throw new RunnerValidationError('ENVIRONMENT_VERIFY_FAILED', `Environment ${environment.name} is not ready: ${(stderr || stdout || `Docker exited ${exitCode}`).trim().slice(0, 2000)}`);
    return { verified: true, verifiedAt: new Date().toISOString(), name: environment.name, image: environment.image, digest: environment.digest, codexVersion: environment.codexVersion ?? null, runtimeContractVersion: environment.runtimeContractVersion ?? 'v1', imports, browsers: spec.playwright, network: 'none' };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function verifyEnvironment(name, { stateRoot = defaultStateRoot(), spawnProcess = spawn } = {}) {
  return verifyEnvironmentImage(await resolveEnvironment(name, { stateRoot }), { spawnProcess });
}

export async function resetEnvironment(name, { stateRoot = defaultStateRoot(), spawnProcess = spawn } = {}) {
  const manifest = await resolveEnvironment(name, { stateRoot });
  const child = spawnProcess('docker', ['image', 'rm', manifest.image], { stdio: 'inherit' });
  const exitCode = await waitForExit(child);
  if (exitCode !== 0) throw new Error(`Docker environment reset exited ${exitCode}`);
  await rm(environmentManifestPath(name, stateRoot), { force: true });
  return { name, image: manifest.image, reset: true };
}

export function presetDirectory() { return fileURLToPath(new URL('../presets/', import.meta.url)); }
export async function listEnvironmentPresets() {
  const files = await readdir(presetDirectory());
  return files.filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort();
}
export async function presetEnvironmentSpec(name) {
  if (!environmentName.test(name)) reject('ENVIRONMENT_NAME_INVALID', 'Preset name is invalid.');
  const path = join(presetDirectory(), `${name}.json`);
  try { await stat(path); } catch { reject('ENVIRONMENT_PRESET_NOT_FOUND', `No bundled environment preset named "${name}" exists.`); }
  return path;
}

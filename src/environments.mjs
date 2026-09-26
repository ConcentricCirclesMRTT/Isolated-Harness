import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerValidationError } from './errors.mjs';
import { defaultStateRoot } from './run.mjs';
import { readMacOsTrustBundle, resolveHostProxy } from './network.mjs';

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
const runtimeContractVersion = 'v2';
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
  return { version: 'v1', name: raw.name, baseImage: raw.baseImage, apt, pip: pip.sort(), playwright: [...new Set(playwright)].sort(), pythonVersion: raw.pythonVersion, packageMirror: raw.packageMirror, workspaceRuntime: raw.workspaceRuntime ?? false, trustedCaFile: raw.trustedCaFile, bundledRuntimeDigest: raw.bundledRuntimeDigest };
}

export async function loadEnvironmentSpec(path) {
  const source = resolve(path);
  let raw;
  try { raw = JSON.parse(await readFile(source, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) reject('ENVIRONMENT_SPEC_JSON_INVALID', `Environment spec is not valid JSON: ${source}`); throw error; }
  const spec = parseEnvironmentSpec(raw);
  return { ...spec, source };
}

export function environmentDigest(spec) {
  return createHash('sha256').update(JSON.stringify({ version: spec.version, runtimeContractVersion, name: spec.name, baseImage: spec.baseImage, apt: spec.apt, pip: spec.pip, playwright: spec.playwright, pythonVersion: spec.pythonVersion ?? null, packageMirror: spec.packageMirror ?? null, workspaceRuntime: spec.workspaceRuntime, trustedCaFile: spec.trustedCaFile ? basename(spec.trustedCaFile) : null, bundledRuntimeDigest: spec.bundledRuntimeDigest ?? null })).digest('hex');
}
export function environmentImage(spec) { return `isolated-harness-env-${spec.name}:${environmentDigest(spec).slice(0, 12)}`; }
export function environmentDirectory(stateRoot = defaultStateRoot()) { return join(stateRoot, 'environments'); }
export function environmentManifestPath(name, stateRoot = defaultStateRoot()) {
  if (!environmentName.test(name)) reject('ENVIRONMENT_NAME_INVALID', 'Environment name is invalid.');
  return join(environmentDirectory(stateRoot), `${name}.json`);
}

export function renderEnvironmentDockerfile(spec, { includeTrustedCa = Boolean(spec.trustedCaFile), bundledRuntime = false } = {}) {
  const apt = [...spec.apt, ...(spec.pip.length && !spec.pythonVersion ? ['python3', 'python3-venv'] : []), ...(spec.pip.length || includeTrustedCa ? ['ca-certificates'] : [])];
  const lines = [...(spec.pythonVersion ? [`FROM python:${spec.pythonVersion}-slim-bookworm AS isolated-harness-python`] : []), `FROM ${spec.baseImage}`, 'USER root'];
  if (spec.packageMirror === 'tuna' && apt.length) lines.push('RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*');
  if (includeTrustedCa && spec.packageMirror === 'tuna') lines.push('COPY trusted-ca.pem /usr/local/share/ca-certificates/isolated-harness.crt', 'RUN update-ca-certificates');
  if (spec.packageMirror === 'tuna') lines.push("RUN for source in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do [ -f \"$source\" ] || continue; sed -i -E 's#https?://deb.debian.org/debian([[:space:]]|$)#https://mirrors.tuna.tsinghua.edu.cn/debian\\1#g' \"$source\"; done", 'ENV PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple');
  if (spec.pythonVersion) lines.push('COPY --from=isolated-harness-python /usr/local /usr/local');
  const packages = spec.packageMirror === 'tuna' ? apt.filter(item => item !== 'ca-certificates') : apt;
  if (packages.length) lines.push(`RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ${[...new Set(packages)].join(' ')} && rm -rf /var/lib/apt/lists/*`);
  if (includeTrustedCa && spec.packageMirror !== 'tuna') lines.push('COPY trusted-ca.pem /usr/local/share/ca-certificates/isolated-harness.crt', 'RUN update-ca-certificates');
  if (spec.pip.length) lines.push('RUN python3 -m venv /opt/isolated-harness/python && /opt/isolated-harness/python/bin/pip install --no-cache-dir --disable-pip-version-check ' + spec.pip.join(' '), 'ENV VIRTUAL_ENV=/opt/isolated-harness/python', 'ENV PATH=/opt/isolated-harness/python/bin:${PATH}', 'ENV UV_SYSTEM_CERTS=true');
  if (bundledRuntime) lines.push('COPY bundled-runtime /opt/isolated-harness/bundled-runtime');
  if (spec.playwright.length) {
    if (bundledRuntime) lines.push(`RUN mkdir -p /opt/ms-playwright && cp -a /opt/isolated-harness/bundled-runtime/browsers/. /opt/ms-playwright/ && /opt/isolated-harness/python/bin/python -m playwright install-deps ${spec.playwright.join(' ')}`);
    else lines.push(`RUN PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright /opt/isolated-harness/python/bin/python -m playwright install --with-deps ${spec.playwright.join(' ')}`);
    lines.push('ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright');
  }
  if (spec.workspaceRuntime) lines.push("RUN printf '%s\\n' '#!/bin/sh' 'set -eu' 'runtime=/workspace/runtime' 'managed=${ISOLATED_HARNESS_MANAGED_RUNTIME:-}' 'bundled=/opt/isolated-harness/bundled-runtime' 'image_python=/opt/isolated-harness/python' 'if [ -n \"$managed\" ]; then' '  ln -sfn \"$managed/python\" \"$runtime/python\"' '  ln -sfn \"$managed/venv\" \"$runtime/venv\"' '  [ -e \"$managed/pillow\" ] && ln -sfn \"$managed/pillow\" \"$runtime/pillow\" || true' '  browser_source=\"$managed/browsers\"' 'elif [ -d \"$image_python\" ]; then' '  # The environment image contains the declared dependency set. A bundled runtime may be older, so it is a fallback, never an implicit override.' '  ln -sfn \"$image_python\" \"$runtime/python\"' '  ln -sfn \"$image_python\" \"$runtime/venv\"' '  browser_source=/opt/ms-playwright' 'elif [ -d \"$bundled\" ]; then' '  ln -sfn \"$bundled/python\" \"$runtime/python\"' '  ln -sfn \"$bundled/venv\" \"$runtime/venv\"' '  [ -e \"$bundled/pillow\" ] && ln -sfn \"$bundled/pillow\" \"$runtime/pillow\" || true' '  browser_source=\"$bundled/browsers\"' 'else' '  browser_source=/opt/ms-playwright' 'fi' 'mkdir -p \"$runtime/browsers/.links\"' 'for component in \"$browser_source\"/*; do' '  [ -e \"$component\" ] || continue' '  ln -sfn \"$component\" \"$runtime/browsers/$(basename \"$component\")\"' 'done' 'exec \"$@\"' > /usr/local/bin/isolated-harness-runtime && chmod 0755 /usr/local/bin/isolated-harness-runtime", 'ENTRYPOINT ["/usr/local/bin/isolated-harness-runtime"]');
  lines.push('USER node', 'CMD ["codex"]', '');
  return lines.join('\n');
}

export async function buildEnvironment(specPath, { runtimeSource, stateRoot = defaultStateRoot(), spawnProcess = spawn, resolveProxy = resolveHostProxy, readTrustBundle = readMacOsTrustBundle } = {}) {
  let spec = await loadEnvironmentSpec(specPath);
  let bundledRuntime;
  if (runtimeSource) {
    const source = resolve(runtimeSource);
    for (const required of ['browsers', 'venv', 'python']) { try { if (!(await stat(join(source, required))).isDirectory()) throw new Error(); } catch { reject('ENVIRONMENT_RUNTIME_SOURCE_INVALID', `Bundled runtime is missing ${required}/: ${source}`); } }
    let runtimeManifest; try { runtimeManifest = JSON.parse(await readFile(join(source, 'runtime.json'), 'utf8')); } catch { reject('ENVIRONMENT_RUNTIME_SOURCE_INVALID', `Bundled runtime must contain runtime.json: ${source}`); }
    if (!/^[a-f0-9]{64}$/.test(runtimeManifest.digest ?? '')) reject('ENVIRONMENT_RUNTIME_SOURCE_INVALID', `Bundled runtime manifest has no valid digest: ${source}`);
    bundledRuntime = source;
    spec = { ...spec, bundledRuntimeDigest: runtimeManifest.digest };
  }
  if (spec.trustedCaFile) {
    let certificate;
    try { certificate = await stat(spec.trustedCaFile); } catch { reject('ENVIRONMENT_CA_MISSING', `Trusted CA file does not exist: ${spec.trustedCaFile}`); }
    if (!certificate.isFile()) reject('ENVIRONMENT_CA_INVALID', 'trustedCaFile must name a regular PEM file.');
  }
  const image = environmentImage(spec);
  const context = await mkdtemp(join(tmpdir(), 'isolated-harness-environment-'));
  try {
    const proxy = await resolveProxy();
    let trustSource = 'none';
    let trustBundle;
    if (spec.trustedCaFile) { await copyFile(spec.trustedCaFile, join(context, 'trusted-ca.pem')); trustSource = 'explicit-file'; }
    else if (proxy.status === 'configured') {
      trustBundle = await readTrustBundle();
      if (trustBundle) { await writeFile(join(context, 'trusted-ca.pem'), trustBundle, { mode: 0o600 }); trustSource = 'host-keychain'; }
    }
    if (bundledRuntime) await cp(bundledRuntime, join(context, 'bundled-runtime'), { recursive: true, dereference: false });
    await writeFile(join(context, 'Dockerfile'), renderEnvironmentDockerfile(spec, { includeTrustedCa: trustSource !== 'none', bundledRuntime: Boolean(bundledRuntime) }), { mode: 0o600 });
    const child = spawnProcess('docker', ['build', '--tag', image, '.'], { cwd: context, env: { ...process.env, ...proxy.environment }, stdio: 'inherit' });
    const exitCode = await waitForExit(child);
    if (exitCode !== 0) throw new Error(`Docker environment build exited ${exitCode}`);
    const { source: _source, ...manifestSpec } = spec;
    const manifest = { version: 'v1', name: spec.name, image, digest: environmentDigest(spec), runtimeContractVersion, spec: { ...manifestSpec, trustedCaFile: spec.trustedCaFile ? basename(spec.trustedCaFile) : null }, builtAt: new Date().toISOString(), proxy: proxy.status, trust: trustSource };
    await mkdir(environmentDirectory(stateRoot), { recursive: true, mode: 0o700 });
    await writeFile(environmentManifestPath(spec.name, stateRoot), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
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
export function environmentVerificationScript(spec) {
  const imports = (spec.pip ?? []).map(pythonImportName).filter(Boolean);
  const checks = [
    'test -L /workspace/runtime/venv',
    'test -L /workspace/runtime/python',
    'test -x /workspace/runtime/venv/bin/python',
    imports.length ? `/workspace/runtime/venv/bin/python -c ${JSON.stringify(`import ${imports.join(', ')}`)}` : 'true',
    (spec.playwright ?? []).length ? 'test -d "$PLAYWRIGHT_BROWSERS_PATH" && find "$PLAYWRIGHT_BROWSERS_PATH" -mindepth 1 -maxdepth 1 -type d | grep -q .' : 'true',
  ];
  return checks.join(' && ');
}

export async function verifyEnvironment(name, { stateRoot = defaultStateRoot(), spawnProcess = spawn } = {}) {
  const environment = await resolveEnvironment(name, { stateRoot });
  // Older manifests recorded the local source path alongside the normalized
  // spec. It is metadata, never container input; strip it while accepting the
  // old records so users do not need to rebuild just to verify an environment.
  const { source: _source, trustedCaFile: _trustedCaFile, ...manifestSpec } = environment.spec ?? {};
  const spec = parseEnvironmentSpec(manifestSpec);
  const workspace = await mkdtemp(join(tmpdir(), 'isolated-harness-runtime-verify-'));
  await chmod(workspace, 0o777);
  const imports = spec.pip.map(pythonImportName).filter(Boolean);
  try {
    const args = [
      'run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network', 'none', '--user=1000:1000', '--workdir', '/workspace',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m',
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
      '--env', 'ISOLATED_HARNESS_RUNTIME_MODE=environment-image', '--env', 'ISOLATED_HARNESS_RUNTIME_PATH=/workspace/runtime', '--env', 'PLAYWRIGHT_BROWSERS_PATH=/workspace/runtime/browsers',
      environment.image, 'sh', '-lc', environmentVerificationScript(spec),
    ];
    const child = spawnProcess('docker', args, { stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', value => { stdout += value; });
    child.stderr?.on('data', value => { stderr += value; });
    const exitCode = await waitForExit(child);
    if (exitCode !== 0) throw new RunnerValidationError('ENVIRONMENT_VERIFY_FAILED', `Environment ${name} is not ready: ${(stderr || stdout || `Docker exited ${exitCode}`).trim().slice(0, 1000)}`);
    return { verified: true, verifiedAt: new Date().toISOString(), name: environment.name, image: environment.image, digest: environment.digest, runtimeContractVersion: environment.runtimeContractVersion ?? 'v1', imports, browsers: spec.playwright, network: 'none' };
  } finally { await rm(workspace, { recursive: true, force: true }); }
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

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const waitForExit = child => new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)); });

function reject(code, message) { throw new RunnerValidationError(code, message); }
function normalizeStringList(value, name, matcher) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !matcher.test(item))) reject('ENVIRONMENT_SPEC_INVALID', `${name} must contain safe package identifiers.`);
  return [...new Set(value)].sort();
}

export function parseEnvironmentSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('ENVIRONMENT_SPEC_INVALID', 'Environment spec must be a JSON object.');
  const allowed = new Set(['version', 'name', 'baseImage', 'apt', 'pip', 'playwright', 'workspaceRuntime', 'trustedCaFile']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) reject('ENVIRONMENT_SPEC_UNKNOWN_FIELD', `Unknown environment field: ${key}`);
  if (raw.version !== 'v1') reject('ENVIRONMENT_SPEC_VERSION', 'Environment spec version must be "v1".');
  if (typeof raw.name !== 'string' || !environmentName.test(raw.name)) reject('ENVIRONMENT_NAME_INVALID', 'Environment name must use lowercase letters, digits, dots, underscores, or dashes.');
  if (typeof raw.baseImage !== 'string' || !imageName.test(raw.baseImage)) reject('ENVIRONMENT_BASE_IMAGE_INVALID', 'baseImage must be a safe Docker image reference.');
  if (raw.workspaceRuntime !== undefined && typeof raw.workspaceRuntime !== 'boolean') reject('ENVIRONMENT_RUNTIME_INVALID', 'workspaceRuntime must be a boolean.');
  if (raw.trustedCaFile !== undefined && (typeof raw.trustedCaFile !== 'string' || !raw.trustedCaFile.startsWith('/'))) reject('ENVIRONMENT_CA_INVALID', 'trustedCaFile must be an absolute PEM file path.');
  const apt = normalizeStringList(raw.apt, 'apt', aptPackage);
  const playwright = raw.playwright === undefined ? [] : raw.playwright;
  if (!Array.isArray(playwright) || playwright.some(browser => typeof browser !== 'string' || !playwrightBrowser.has(browser))) reject('ENVIRONMENT_PLAYWRIGHT_INVALID', 'playwright may contain only chromium, firefox, or webkit.');
  const pip = normalizeStringList(raw.pip, 'pip', pipRequirement);
  if (playwright.length && !pip.some(requirement => requirement.split('==')[0] === 'playwright')) pip.push('playwright');
  return { version: 'v1', name: raw.name, baseImage: raw.baseImage, apt, pip: pip.sort(), playwright: [...new Set(playwright)].sort(), workspaceRuntime: raw.workspaceRuntime ?? false, trustedCaFile: raw.trustedCaFile };
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
  return createHash('sha256').update(JSON.stringify({ version: spec.version, name: spec.name, baseImage: spec.baseImage, apt: spec.apt, pip: spec.pip, playwright: spec.playwright, workspaceRuntime: spec.workspaceRuntime, trustedCaFile: spec.trustedCaFile ? basename(spec.trustedCaFile) : null })).digest('hex');
}
export function environmentImage(spec) { return `isolated-harness-env-${spec.name}:${environmentDigest(spec).slice(0, 12)}`; }
export function environmentDirectory(stateRoot = defaultStateRoot()) { return join(stateRoot, 'environments'); }
export function environmentManifestPath(name, stateRoot = defaultStateRoot()) {
  if (!environmentName.test(name)) reject('ENVIRONMENT_NAME_INVALID', 'Environment name is invalid.');
  return join(environmentDirectory(stateRoot), `${name}.json`);
}

export function renderEnvironmentDockerfile(spec, { includeTrustedCa = Boolean(spec.trustedCaFile) } = {}) {
  const apt = [...spec.apt, ...(spec.pip.length ? ['python3', 'python3-venv', 'ca-certificates'] : []), ...(includeTrustedCa ? ['ca-certificates'] : [])];
  const lines = [`FROM ${spec.baseImage}`, 'USER root'];
  if (apt.length) lines.push(`RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ${[...new Set(apt)].join(' ')} && rm -rf /var/lib/apt/lists/*`);
  if (includeTrustedCa) lines.push('COPY trusted-ca.pem /usr/local/share/ca-certificates/isolated-harness.crt', 'RUN update-ca-certificates');
  if (spec.pip.length) lines.push('RUN python3 -m venv /opt/isolated-harness/python && /opt/isolated-harness/python/bin/pip install --no-cache-dir --disable-pip-version-check ' + spec.pip.join(' '), 'ENV VIRTUAL_ENV=/opt/isolated-harness/python', 'ENV PATH=/opt/isolated-harness/python/bin:${PATH}', 'ENV UV_SYSTEM_CERTS=true');
  if (spec.playwright.length) lines.push(`RUN PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright /opt/isolated-harness/python/bin/python -m playwright install --with-deps ${spec.playwright.join(' ')}`, 'ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright');
  if (spec.workspaceRuntime) lines.push("RUN printf '%s\\n' '#!/bin/sh' 'set -eu' 'runtime=/workspace/runtime' 'managed=${ISOLATED_HARNESS_MANAGED_RUNTIME:-}' 'if [ -n \"$managed\" ]; then' '  ln -sfn \"$managed/python\" \"$runtime/python\"' '  ln -sfn \"$managed/venv\" \"$runtime/venv\"' '  [ -e \"$managed/pillow\" ] && ln -sfn \"$managed/pillow\" \"$runtime/pillow\" || true' '  browser_source=\"$managed/browsers\"' 'else' '  ln -sfn /opt/isolated-harness/python \"$runtime/venv\"' '  browser_source=/opt/ms-playwright' 'fi' 'mkdir -p \"$runtime/browsers/.links\"' 'for component in \"$browser_source\"/*; do' '  [ -e \"$component\" ] || continue' '  ln -sfn \"$component\" \"$runtime/browsers/$(basename \"$component\")\"' 'done' 'exec \"$@\"' > /usr/local/bin/isolated-harness-runtime && chmod 0755 /usr/local/bin/isolated-harness-runtime", 'ENTRYPOINT ["/usr/local/bin/isolated-harness-runtime"]');
  lines.push('USER node', 'CMD ["codex"]', '');
  return lines.join('\n');
}

export async function buildEnvironment(specPath, { stateRoot = defaultStateRoot(), spawnProcess = spawn, resolveProxy = resolveHostProxy, readTrustBundle = readMacOsTrustBundle } = {}) {
  const spec = await loadEnvironmentSpec(specPath);
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
    await writeFile(join(context, 'Dockerfile'), renderEnvironmentDockerfile(spec, { includeTrustedCa: trustSource !== 'none' }), { mode: 0o600 });
    const child = spawnProcess('docker', ['build', '--tag', image, '.'], { cwd: context, env: { ...process.env, ...proxy.environment }, stdio: 'inherit' });
    const exitCode = await waitForExit(child);
    if (exitCode !== 0) throw new Error(`Docker environment build exited ${exitCode}`);
    const manifest = { version: 'v1', name: spec.name, image, digest: environmentDigest(spec), spec: { ...spec, trustedCaFile: spec.trustedCaFile ? basename(spec.trustedCaFile) : null }, builtAt: new Date().toISOString(), proxy: proxy.status, trust: trustSource };
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

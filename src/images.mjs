import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunnerValidationError } from './errors.mjs';
import { resolveHostProxy } from './network.mjs';

export const codexVersionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;

export async function dockerOutput(args, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Docker exited ${code}`)));
  });
}

export async function inspectImage(image, options) {
  const output = await dockerOutput(['image', 'inspect', '--format', '{{json .}}', image], options);
  const info = JSON.parse(output);
  return { id: info.Id, platform: `${info.Os}/${info.Architecture}`, codexVersion: info.Config?.Labels?.['org.openai.codex.version'] ?? null };
}

// Resolve latest before building: a literal @latest inside a cached Docker RUN
// would otherwise keep serving an old binary indefinitely.
export async function resolveCodexVersion(version = 'latest', { fetchMetadata = fetch } = {}) {
  if (version === 'latest') {
    const response = await fetchMetadata('https://registry.npmjs.org/@openai%2fcodex/latest', { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Could not resolve latest Codex CLI: HTTP ${response.status}`);
    version = (await response.json()).version;
  }
  if (!codexVersionPattern.test(version ?? '')) throw new RunnerValidationError('CODEX_VERSION_INVALID', 'Use latest or an exact semantic Codex CLI version.');
  return version;
}

export async function buildImage({ image = 'codex-cli:local', version = 'latest', spawnProcess = spawn, fetchMetadata = fetch, resolveProxy = resolveHostProxy } = {}) {
  const resolvedVersion = await resolveCodexVersion(version, { fetchMetadata });
  const proxy = await resolveProxy();
  const args = ['build', '--tag', image, '--build-arg', `CODEX_VERSION=${resolvedVersion}`];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (proxy.environment[key]) args.push('--build-arg', `${key}=${proxy.environment[key]}`);
  args.push('.');
  await new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, DOCKER_BUILDKIT: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Docker image build exited ${code}`)));
  });
  const actual = await dockerOutput(['run', '--rm', '--network', 'none', image, 'codex', '--version'], { spawnProcess });
  if (actual !== `codex-cli ${resolvedVersion}`) throw new Error(`Built Codex version mismatch: ${actual}`);
  return { image, ...(await inspectImage(image, { spawnProcess })), codexVersion: resolvedVersion };
}

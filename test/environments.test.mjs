import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentDigest, environmentImage, environmentManifestPath, environmentVerificationScript, parseEnvironmentSpec, renderEnvironmentDockerfile, verifyEnvironment } from '../src/environments.mjs';

test('renders a reproducible custom environment image with apt and Python dependencies', () => {
  const spec = parseEnvironmentSpec({ version: 'v1', name: 'drawing-review-v1', baseImage: 'codex-cli:local', apt: ['poppler-utils', 'libnss3'], pip: ['pymupdf', 'playwright==1.52.0'], playwright: ['chromium'], pythonVersion: '3.12', packageMirror: 'tuna', workspaceRuntime: true });
  const dockerfile = renderEnvironmentDockerfile(spec);
  assert.match(dockerfile, /^FROM python:3\.12-slim-bookworm AS isolated-harness-python/m);
  assert.match(dockerfile, /^FROM codex-cli:local/m);
  assert.match(dockerfile, /COPY --from=isolated-harness-python \/usr\/local \/usr\/local/m);
  assert.match(dockerfile, /mirrors\.tuna\.tsinghua\.edu\.cn\/debian/m);
  assert.match(dockerfile, /PIP_INDEX_URL=https:\/\/mirrors\.tuna\.tsinghua\.edu\.cn\/pypi\/web\/simple/m);
  assert.match(dockerfile, /apt-get install --yes --no-install-recommends ca-certificates/);
  assert.match(dockerfile, /deb\.debian\.org\/debian\(\[\[:space:\]\]\|\$\)/);
  assert.match(dockerfile, /apt-get install .*libnss3 poppler-utils/m);
  assert.match(dockerfile, /python3 -m venv \/opt\/isolated-harness\/python/m);
  assert.match(dockerfile, /ENV UV_SYSTEM_CERTS=true/m);
  assert.match(dockerfile, /playwright install --with-deps chromium/m);
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright/m);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/isolated-harness-runtime"\]/m);
  assert.match(dockerfile, /managed=\$\{ISOLATED_HARNESS_MANAGED_RUNTIME:-\}/m);
  assert.match(dockerfile, /mkdir -p "\$runtime\/browsers\/.links"/m);
  assert.match(environmentImage(spec), /^isolated-harness-env-drawing-review-v1:[a-f0-9]{12}$/);
  assert.equal(environmentDigest(spec).length, 64);
  const reusedBrowserDockerfile = renderEnvironmentDockerfile(spec, { bundledRuntime: true });
  assert.match(reusedBrowserDockerfile, /cp -a \/opt\/isolated-harness\/bundled-runtime\/browsers/);
  assert.match(reusedBrowserDockerfile, /playwright install-deps chromium/);
});

test('verification script proves the image runtime imports and browser path without network', () => {
  const spec = parseEnvironmentSpec({ version: 'v1', name: 'drawing-review-v1', baseImage: 'codex-cli:local', pip: ['pymupdf', 'pillow', 'numpy', 'playwright'], playwright: ['chromium'], workspaceRuntime: true });
  const script = environmentVerificationScript(spec);
  assert.match(script, /test -L \/workspace\/runtime\/venv/);
  for (const module of ['fitz', 'numpy', 'PIL', 'playwright']) assert.match(script, new RegExp(`(?:import |, )${module}(?:,|\\")`));
  assert.match(script, /PLAYWRIGHT_BROWSERS_PATH/);
});

test('verification accepts legacy manifest metadata without treating it as runtime input', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'isolated-harness-environment-test-'));
  const spec = parseEnvironmentSpec({ version: 'v1', name: 'drawing-review-v1', baseImage: 'codex-cli:local', pip: ['numpy'], workspaceRuntime: true });
  await mkdir(join(stateRoot, 'environments'));
  await writeFile(environmentManifestPath(spec.name, stateRoot), JSON.stringify({ version: 'v1', name: spec.name, image: 'isolated-harness-env-drawing-review-v1:abcdef123456', digest: environmentDigest(spec), spec: { ...spec, source: '/host/spec.json', trustedCaFile: 'host-trust.pem' } }));
  const commands = [];
  const spawnProcess = (_command, args) => {
    commands.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('exit', 0)); return child;
  };
  try {
    const receipt = await verifyEnvironment(spec.name, { stateRoot, spawnProcess });
    assert.equal(receipt.verified, true); assert.deepEqual(receipt.imports, ['numpy']);
    assert.ok(commands[0].includes('--network')); assert.ok(commands[0].includes('none'));
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('rejects environment values that could be interpreted as Dockerfile shell input', () => {
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'Bad Name', baseImage: 'codex-cli:local' }), { code: 'ENVIRONMENT_NAME_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', apt: ['poppler-utils;rm'] }), { code: 'ENVIRONMENT_SPEC_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', pip: ['playwright @ https://example.test'] }), { code: 'ENVIRONMENT_SPEC_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', playwright: ['chrome'] }), { code: 'ENVIRONMENT_PLAYWRIGHT_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', pythonVersion: '3.13' }), { code: 'ENVIRONMENT_PYTHON_VERSION_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', packageMirror: 'https://untrusted.example' }), { code: 'ENVIRONMENT_MIRROR_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', workspaceRuntime: 'yes' }), { code: 'ENVIRONMENT_RUNTIME_INVALID' });
});

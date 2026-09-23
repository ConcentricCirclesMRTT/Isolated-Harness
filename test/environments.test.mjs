import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentDigest, environmentImage, environmentVerificationScript, parseEnvironmentSpec, renderEnvironmentDockerfile } from '../src/environments.mjs';

test('renders a reproducible custom environment image with apt and Python dependencies', () => {
  const spec = parseEnvironmentSpec({ version: 'v1', name: 'drawing-review-v1', baseImage: 'codex-cli:local', apt: ['poppler-utils', 'libnss3'], pip: ['pymupdf', 'playwright==1.52.0'], playwright: ['chromium'], workspaceRuntime: true });
  const dockerfile = renderEnvironmentDockerfile(spec);
  assert.match(dockerfile, /^FROM codex-cli:local/m);
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
});

test('verification script proves the image runtime imports and browser path without network', () => {
  const spec = parseEnvironmentSpec({ version: 'v1', name: 'drawing-review-v1', baseImage: 'codex-cli:local', pip: ['pymupdf', 'pillow', 'numpy', 'playwright'], playwright: ['chromium'], workspaceRuntime: true });
  const script = environmentVerificationScript(spec);
  assert.match(script, /test -L \/workspace\/runtime\/venv/);
  for (const module of ['fitz', 'numpy', 'PIL', 'playwright']) assert.match(script, new RegExp(`(?:import |, )${module}(?:,|\\")`));
  assert.match(script, /PLAYWRIGHT_BROWSERS_PATH/);
});

test('rejects environment values that could be interpreted as Dockerfile shell input', () => {
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'Bad Name', baseImage: 'codex-cli:local' }), { code: 'ENVIRONMENT_NAME_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', apt: ['poppler-utils;rm'] }), { code: 'ENVIRONMENT_SPEC_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', pip: ['playwright @ https://example.test'] }), { code: 'ENVIRONMENT_SPEC_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', playwright: ['chrome'] }), { code: 'ENVIRONMENT_PLAYWRIGHT_INVALID' });
  assert.throws(() => parseEnvironmentSpec({ version: 'v1', name: 'safe', baseImage: 'codex-cli:local', workspaceRuntime: 'yes' }), { code: 'ENVIRONMENT_RUNTIME_INVALID' });
});

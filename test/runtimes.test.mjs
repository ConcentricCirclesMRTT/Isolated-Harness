import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importRuntime, resolveRuntime } from '../src/runtimes.mjs';

test('imports a workspace runtime as a managed read-only-compatible artifact without its cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-harness-runtime-test-'));
  const source = join(root, 'source');
  await Promise.all(['browsers', 'python/bin', 'venv/bin', 'cache'].map(path => mkdir(join(source, path), { recursive: true })));
  await writeFile(join(source, 'python/bin/python3.12'), 'binary placeholder');
  await symlink('/workspace/runtime/python/bin/python3.12', join(source, 'venv/bin/python'));
  await writeFile(join(source, 'browsers/INSTALLATION_COMPLETE'), 'ready');
  await writeFile(join(source, 'cache/transient-download'), 'discard me');
  const imported = await importRuntime({ name: 'drawing-runtime', source, stateRoot: join(root, 'state') });
  assert.equal(imported.cacheIncluded, false);
  assert.deepEqual(imported.entries, ['browsers', 'python', 'venv']);
  assert.equal(await readlink(join(imported.path, 'venv/bin/python')), '/workspace/runtime/python/bin/python3.12');
  const resolved = await resolveRuntime('drawing-runtime', { stateRoot: join(root, 'state') });
  assert.equal(resolved.containerPath, '/workspace/runtime');
});

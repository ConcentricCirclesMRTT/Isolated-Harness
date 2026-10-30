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

test('runtime identity detects same-size edits and never replaces an existing shared artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-harness-runtime-content-'));
  const source = join(root, 'source');
  await Promise.all(['browsers', 'python', 'venv'].map(path => mkdir(join(source, path), { recursive: true })));
  const file = join(source, 'python/binary');
  await writeFile(file, 'first');
  const options = { name: 'version-one', source, stateRoot: join(root, 'state') };
  const first = await importRuntime(options);
  assert.equal((await importRuntime(options)).reused, true);
  await writeFile(file, 'other');
  await assert.rejects(importRuntime(options), { code: 'RUNTIME_ALREADY_EXISTS' });
  const second = await importRuntime({ ...options, name: 'version-two' });
  assert.notEqual(first.digest, second.digest);
  assert.equal((await resolveRuntime(options.name, options)).digest, first.digest);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectHostCodexLogin, materializeHostCodexLogin } from '../src/credentials/hostCodex.mjs';

test('materializes only auth into a fresh session-local Codex home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chr-auth-test-')); const host = join(root, 'host-codex'); const session = join(root, 'session-codex');
  await mkdir(host); await writeFile(join(host, 'auth.json'), '{"auth":"fixture"}'); await writeFile(join(host, 'history.jsonl'), 'must not copy');
  const status = await inspectHostCodexLogin({ authPath: join(host, 'auth.json') });
  assert.equal(status.status, 'available');
  const result = await materializeHostCodexLogin({ sessionCodexHome: session, authPath: status.authPath });
  assert.deepEqual({ provider: result.provider, status: result.status }, { provider: 'host-codex', status: 'available' });
  assert.equal(await readFile(join(session, 'auth.json'), 'utf8'), '{"auth":"fixture"}');
  await assert.rejects(() => readFile(join(session, 'history.jsonl')));
});
test('does not report an absent host login as usable', async () => {
  const status = await inspectHostCodexLogin({ authPath: join(tmpdir(), 'missing-chr-auth.json') });
  assert.equal(status.status, 'unavailable');
});

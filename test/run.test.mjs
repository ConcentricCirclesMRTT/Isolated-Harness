import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodexRun } from '../src/run.mjs';

test('persists redacted receipt and removes the run-scoped Codex home after exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chr-run-test-')); const workspace = join(root, 'workspace'); const hostCodex = join(root, 'host-codex');
  await mkdir(workspace); await mkdir(hostCodex); await writeFile(join(hostCodex, 'auth.json'), '{"fixture":"secret"}');
  const original = process.env.CODEX_HOME; process.env.CODEX_HOME = hostCodex;
  try {
    const fakeSpawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setTimeout(() => { child.stdout.end('runner output\n'); child.emit('exit', 0, null); }, 10); return child;
    };
    const result = await startCodexRun({ version: 'v1', harness: { id: 'codex-cli', image: 'fixture' }, workingDirectory: '/workspace', mounts: [{ hostPath: workspace, containerPath: '/workspace', mode: 'rw' }], task: 'fixture task', isolation: { profile: 'contained' } }, { stateRoot: join(root, 'state'), spawnProcess: fakeSpawn });
    assert.equal(result.state, 'completed');
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    assert.equal(receipt.credential.provider, 'host-codex'); assert.equal(receipt.credential.status, 'available');
    assert.equal(receipt.state, 'completed'); assert.equal(JSON.stringify(receipt).includes('fixture":"secret'), false);
    await assert.rejects(() => access(join(root, 'state', 'runs', result.runId, 'codex-home')));
  } finally { if (original === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original; }
});

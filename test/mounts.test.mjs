import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMounts } from '../src/mounts.mjs';

async function fixture() { const root = await mkdtemp(join(tmpdir(), 'chr-mount-test-')); await mkdir(join(root, 'workspace')); await mkdir(join(root, 'reference')); await mkdir(join(root, 'state')); return root; }
test('plans direct rw and ro directory mounts', async () => {
  const root = await fixture();
  const plan = await planMounts([{ hostPath: join(root, 'workspace'), containerPath: '/workspace', mode: 'rw' }, { hostPath: join(root, 'reference'), containerPath: '/references', mode: 'ro' }], { runnerStateRoot: join(root, 'state'), userHome: join(root, 'not-home') });
  assert.deepEqual(plan.map(item => [item.containerPath, item.mode]), [['/workspace', 'rw'], ['/references', 'ro']]);
});
test('rejects overlapping container destinations', async () => {
  const root = await fixture();
  await assert.rejects(() => planMounts([{ hostPath: join(root, 'workspace'), containerPath: '/workspace', mode: 'rw' }, { hostPath: join(root, 'reference'), containerPath: '/workspace/ref', mode: 'ro' }], { runnerStateRoot: join(root, 'state'), userHome: join(root, 'not-home') }), { code: 'MOUNT_DESTINATION_OVERLAP' });
});
test('rejects runner state and forbidden container roots', async () => {
  const root = await fixture();
  await assert.rejects(() => planMounts([{ hostPath: join(root, 'state'), containerPath: '/workspace', mode: 'rw' }], { runnerStateRoot: join(root, 'state'), userHome: join(root, 'not-home') }), { code: 'MOUNT_RUNNER_STATE_FORBIDDEN' });
  await assert.rejects(() => planMounts([{ hostPath: join(root, 'workspace'), containerPath: '/run/escape', mode: 'rw' }], { runnerStateRoot: join(root, 'state'), userHome: join(root, 'not-home') }), { code: 'MOUNT_CONTAINER_PATH_FORBIDDEN' });
});
test('rejects the host temporary-directory root but permits a named project beneath it', async () => {
  const root = await fixture();
  await assert.rejects(() => planMounts([{ hostPath: tmpdir(), containerPath: '/workspace', mode: 'rw' }], { runnerStateRoot: join(root, 'state'), userHome: join(root, 'not-home') }), { code: 'MOUNT_FORBIDDEN_HOST_PATH' });
  const plan = await planMounts([{ hostPath: join(root, 'workspace'), containerPath: '/workspace', mode: 'rw' }], { runnerStateRoot: join(root, 'state'), userHome: join(root, 'not-home') });
  assert.match(plan[0].hostPath, /\/workspace$/);
});

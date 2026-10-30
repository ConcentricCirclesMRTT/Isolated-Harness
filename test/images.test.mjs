import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexVersion } from '../src/images.mjs';

test('resolves latest before building and rejects invalid registry responses', async () => {
  let requests = 0;
  const fetchMetadata = async () => { requests++; return { ok: true, json: async () => ({ version: '0.165.0' }) }; };
  assert.equal(await resolveCodexVersion('latest', { fetchMetadata }), '0.165.0');
  assert.equal(await resolveCodexVersion('0.155.0', { fetchMetadata }), '0.155.0');
  assert.equal(requests, 1);
  await assert.rejects(resolveCodexVersion('latest', { fetchMetadata: async () => ({ ok: true, json: async () => ({ version: 'latest' }) }) }), { code: 'CODEX_VERSION_INVALID' });
  await assert.rejects(resolveCodexVersion('--invalid'), { code: 'CODEX_VERSION_INVALID' });
});

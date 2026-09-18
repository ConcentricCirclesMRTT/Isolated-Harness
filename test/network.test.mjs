import test from 'node:test';
import assert from 'node:assert/strict';
import { readMacOsTrustBundle, resolveHostProxy } from '../src/network.mjs';

test('maps the macOS loopback proxy to Docker Desktop host routing', async () => {
  const result = await resolveHostProxy({ exec: async () => ({ stdout: 'HTTPEnable : 1\nHTTPPort : 10808\nHTTPProxy : 127.0.0.1\nHTTPSEnable : 1\nHTTPSPort : 10808\nHTTPSProxy : 127.0.0.1\nExceptionsList : <array> {\n  0 : localhost\n}' }) });
  assert.equal(result.status, 'configured'); assert.equal(result.environment.HTTPS_PROXY, 'http://host.docker.internal:10808'); assert.match(result.environment.NO_PROXY, /localhost/);
});

test('uses only public macOS keychain certificates for a proxy trust bundle', async () => {
  const calls = [];
  const bundle = await readMacOsTrustBundle({
    platform: 'darwin',
    home: '/Users/fixture',
    exec: async (_command, args) => {
      calls.push(args.at(-1));
      return { stdout: `-----BEGIN CERTIFICATE-----\nfixture-${args.at(-1)}\n-----END CERTIFICATE-----` };
    }
  });
  assert.equal(calls.length, 2);
  assert.match(bundle, /System\.keychain/);
  assert.match(bundle, /login\.keychain-db/);
});

test('does not read a macOS keychain on another platform', async () => {
  const bundle = await readMacOsTrustBundle({ platform: 'linux', exec: async () => { throw new Error('should not execute'); } });
  assert.equal(bundle, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeCapabilities, resolveCapabilities, renderMcpConfig } from '../src/capabilities.mjs';

test('snapshots a selected skill and emits explicit MCP config without inheriting host state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chr-capability-test-'));
  const skill = join(root, 'skill'); await mkdir(skill); await writeFile(join(skill, 'SKILL.md'), '# Test skill\n');
  const resolved = await resolveCapabilities({ skills: [{ id: 'test-skill', source: skill, version: '1.0.0' }], mcps: [{ id: 'local', transport: 'stdio', command: '/bin/echo', args: ['hello'], env: { TEST_FLAG: '1' } }] });
  assert.equal(resolved.inherit.skills, false); assert.equal(resolved.skills[0].digest.length, 64);
  const home = join(root, 'session'); const registered = await materializeCapabilities(resolved, { stateRoot: join(root, 'state'), sessionCodexHome: home });
  assert.match(await readFile(join(home, 'skills', 'test-skill', 'SKILL.md'), 'utf8'), /Test skill/);
  assert.equal(registered.skills[0].source, 'session://skills/test-skill');
  assert.match(await readFile(join(home, 'config.toml'), 'utf8'), /\[mcp_servers.local\]/);
});

test('renders remote MCP declarations without serializing a token', () => {
  const config = renderMcpConfig([{ id: 'review', transport: 'http', url: 'https://review.example/mcp', bearerTokenEnvVar: 'REVIEW_TOKEN' }]);
  assert.match(config, /bearer_token_env_var = "REVIEW_TOKEN"/); assert.equal(config.includes('token-value'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexContainerPlan, buildCodexInteractivePlan } from '../src/adapters/codex.mjs';

test('builds a contained direct-mount Codex plan with isolated CODEX_HOME', () => {
  const plan = buildCodexContainerPlan({ image: 'codex-cli:local', workingDirectory: '/workspace', sessionCodexHome: '/runner/runs/a/codex-home', profile: 'contained', task: 'say hello', mounts: [{ hostPath: '/host/project', containerPath: '/workspace', mode: 'rw' }, { hostPath: '/host/ref', containerPath: '/references', mode: 'ro' }] });
  assert.ok(plan.dockerArgs.includes('--network')); assert.ok(plan.dockerArgs.includes('bridge'));
  assert.ok(plan.dockerArgs.includes('CODEX_HOME=/run/codex-home'));
  assert.ok(plan.dockerArgs.includes('HOME=/run/codex-home'));
  assert.equal(plan.dockerArgs.includes('--ignore-user-config'), false);
  assert.ok(plan.dockerArgs.includes('--ephemeral'));
  assert.ok(plan.dockerArgs.includes('--json'));
  assert.ok(plan.dockerArgs.includes('type=bind,src=/host/project,dst=/workspace'));
  assert.ok(plan.dockerArgs.includes('type=bind,src=/host/ref,dst=/references,readonly'));
  assert.ok(plan.dockerArgs.includes('say hello'));
  assert.equal(plan.dockerArgs.some(value => value.includes('/Users/') || value.includes('/home/')), false);
});

test('uses no network only for the explicit offline profile', () => {
  const plan = buildCodexContainerPlan({ image: 'codex-cli:local', workingDirectory: '/workspace', sessionCodexHome: '/runner/runs/a/codex-home', profile: 'offline', mounts: [{ hostPath: '/host/project', containerPath: '/workspace', mode: 'rw' }] });
  assert.ok(plan.dockerArgs.includes('none'));
});

test('opens the complete Codex CLI and forwards its arguments unchanged', () => {
  const plan = buildCodexInteractivePlan({ image: 'codex-cli:local', workingDirectory: '/workspace', codexHomePath: '/workspace/.contained-harness/codex', authProjectionPath: '/runner/private/auth.json', profile: 'contained', workspaceRuntime: true, mounts: [{ hostPath: '/host/project', containerPath: '/workspace', mode: 'rw' }], codexArgs: ['--model', 'gpt-5.6-luna', '--search'] });
  assert.ok(plan.dockerArgs.includes('--interactive'));
  assert.ok(plan.dockerArgs.includes('--tty'));
  const codexIndex = plan.dockerArgs.lastIndexOf('codex');
  assert.deepEqual(plan.dockerArgs.slice(codexIndex), ['codex', '--cd', '/workspace', '--model', 'gpt-5.6-luna', '--search']);
  assert.equal(plan.dockerArgs.includes('--ephemeral'), false);
  assert.equal(plan.dockerArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.ok(plan.dockerArgs.includes('CODEX_HOME=/workspace/.contained-harness/codex'));
  assert.ok(plan.dockerArgs.includes('type=bind,src=/runner/private/auth.json,dst=/workspace/.contained-harness/codex/auth.json'));
  assert.ok(plan.dockerArgs.includes('/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m'));
  assert.equal(plan.environment.workspaceRuntime, 'prebuilt');
});

test('mounts a deliberately imported runtime read-only ahead of a prebuilt compatibility tmpfs', () => {
  const plan = buildCodexInteractivePlan({ image: 'codex-cli:local', workingDirectory: '/workspace', codexHomePath: '/workspace/.contained-harness/codex', authProjectionPath: '/runner/private/auth.json', profile: 'contained', workspaceRuntime: true, runtimePath: '/runner/runtimes/drawing-runtime', mounts: [{ hostPath: '/host/project', containerPath: '/workspace', mode: 'rw' }] });
  assert.ok(plan.dockerArgs.includes('type=bind,src=/runner/runtimes/drawing-runtime,dst=/run/managed-runtime,readonly'));
  assert.ok(plan.dockerArgs.includes('ISOLATED_HARNESS_MANAGED_RUNTIME=/run/managed-runtime'));
  assert.ok(plan.dockerArgs.includes('/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m'));
  assert.equal(plan.environment.workspaceRuntime, 'managed-readonly');
});

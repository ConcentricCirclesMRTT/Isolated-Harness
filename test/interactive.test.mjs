import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInteractiveSkills, projectCodexHome, renderRuntimeAgentGuide } from '../src/interactive.mjs';

test('selects no Skills by default and supports a deliberate inherited Skill snapshot', () => {
  assert.deepEqual(normalizeInteractiveSkills(), { mode: 'none', paths: [] });
  assert.deepEqual(normalizeInteractiveSkills(['inherited']), { mode: 'inherited', paths: [] });
  assert.deepEqual(normalizeInteractiveSkills(['/tmp/skill-a', '/tmp/skill-b']), { mode: 'explicit', paths: ['/tmp/skill-a', '/tmp/skill-b'] });
});

test('stores a project Codex home inside the workspace, with optional separate named sessions', () => {
  assert.equal(projectCodexHome('/tmp/tower'), '/tmp/tower/.contained-harness/codex');
  assert.equal(projectCodexHome('/tmp/tower', 'review-a'), '/tmp/tower/.contained-harness/sessions/review-a/codex');
});

test('does not combine inherited Skills with arbitrary sources', () => {
  assert.throws(() => normalizeInteractiveSkills(['inherited', '/tmp/skill-a']), { code: 'INTERACTIVE_SKILLS_INVALID' });
  assert.throws(() => normalizeInteractiveSkills(['none', '/tmp/skill-a']), { code: 'INTERACTIVE_SKILLS_INVALID' });
});

test('tells Codex to reuse a prepared environment runtime rather than download it into the workspace', () => {
  const guide = renderRuntimeAgentGuide({ environment: { name: 'drawing-review-v1', image: 'isolated-harness-env-drawing-review-v1:abc', digest: 'abc' }, runtime: null, runtimeWritable: false, workspaceRuntime: true, existing: '# Project instruction\nKeep sources.' });
  assert.match(guide, /Runtime mode: \*\*environment-image\*\*/);
  assert.match(guide, /Runtime path: \*\*\/workspace\/runtime\*\*/);
  assert.match(guide, /Prefer the prepared runtime for Python, virtualenv, Playwright, browsers, and image\/PDF dependencies/);
  assert.match(guide, /Do not recreate the environment unless the user explicitly requests it/);
  assert.match(guide, /Existing project instructions:[\s\S]*Keep sources/);
});

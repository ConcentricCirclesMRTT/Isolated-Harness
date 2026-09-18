import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInteractiveSkills, projectCodexHome } from '../src/interactive.mjs';

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

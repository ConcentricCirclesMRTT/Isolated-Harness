import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexJsonLine } from '../src/events.mjs';

test('normalizes Codex JSON event types while retaining their raw payload', () => {
  const cases = [
    ['{"type":"thread.started","thread_id":"thread-1"}', 'thread_started'],
    ['{"type":"turn.started"}', 'turn_started'],
    ['{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}', 'assistant_message'],
    ['{"type":"item.completed","item":{"type":"command_execution","status":"completed","command":"pwd"}}', 'command_completed'],
    ['{"type":"turn.completed","usage":{"input_tokens":12}}', 'turn_completed']
  ];
  for (const [line, kind] of cases) {
    const event = parseCodexJsonLine(line);
    assert.equal(event.kind, kind);
    assert.equal(event.raw.type, JSON.parse(line).type);
  }
});

test('ignores non-JSON stdout without making terminal output unsafe for consumers', () => {
  assert.equal(parseCodexJsonLine('plain terminal line'), null);
});

// Codex `exec --json` event lines are preserved verbatim so a UI can show all
// information without scraping terminal text. `kind` gives common events a
// stable presentation name while `raw` retains the full provider payload.
export function parseCodexJsonLine(line) {
  try {
    const raw = JSON.parse(line);
    const itemType = raw.item?.type;
    const kind = raw.type === 'thread.started' ? 'thread_started'
      : raw.type === 'turn.started' ? 'turn_started'
      : raw.type === 'turn.completed' ? 'turn_completed'
      : itemType === 'agent_message' ? 'assistant_message'
      : itemType === 'command_execution' ? raw.item.status === 'completed' ? 'command_completed' : 'command_started'
      : itemType ? `item_${itemType}` : raw.type.replaceAll('.', '_');
    return { kind, raw };
  } catch { return null; }
}

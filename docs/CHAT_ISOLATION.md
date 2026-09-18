# Chat-scoped isolation

A `chat.id` defines the only continuity boundary.

- Repeated `run` calls with the **same** `chat.id` resume that chat's private
  Codex thread and retain its conversation context.
- A different `chat.id` receives a different runner-owned `CODEX_HOME` and a
  different Codex thread. It cannot resume, read, or inherit another chat's
  conversation state.
- Host `CODEX_HOME`, unrelated chats, and unselected Skills remain unavailable.

Example:

```json
{
  "chat": { "id": "tower-review-42" },
  "task": "Continue the current review."
}
```

Omit `chat` for a one-shot ephemeral task. A product UI should assign a stable,
project-scoped chat ID for each user-visible conversation.

## Live acceptance

On 2026-09-18, a real three-turn test used two IDs:

1. `chat-a` stored `cedar-lantern-482`.
2. A second `chat-a` turn resumed the exact same Codex thread and returned
   `cedar-lantern-482`.
3. `chat-b` started a distinct thread and returned `no prior chat context.`

The two thread IDs were distinct: chat-a
`01a0b2f2-f092-7662-8f13-53f320a7ddf6`; chat-b
`01a0b2f4-c215-7050-9f3d-5b5595b1c6dc`.

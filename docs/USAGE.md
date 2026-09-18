# Use Codex through the runner

The runner is a small backend component: your application supplies a chat ID,
a directory the chat can use, and a user message. It starts Codex in the
container and streams JSON Lines on standard output. Your UI can render those
events directly; it never has to parse a terminal transcript to find an
assistant answer or command.

## Full interactive Codex CLI

`isolated-harness codex` opens the actual Codex terminal interface inside the
container. It does not replace Codex with a limited chat UI: model selection,
approval flow, slash commands, `mcp`, `plugin`, `review`, `resume`, and every
other CLI command in the pinned image remain Codex CLI functionality.

```sh
# Install the local binary name once from this repository.
npm link

# Open normal interactive Codex in a directly mounted workspace.
isolated-harness codex --workspace /path/to/project

# Deliberately snapshot the host Skills into this isolated Codex home.
isolated-harness codex --workspace /path/to/project --skills inherited

# Or select only named local Skill folders and an explicit Codex config file.
isolated-harness codex --workspace /path/to/project \
  --skills /Users/me/skills/tower-review \
  --skills /Users/me/skills/tower-exchange \
  --config /Users/me/codex-tower.toml
```

The Isolated Harness options configure isolation. Put ordinary Codex CLI
arguments after `--`, and they are passed to `codex` unchanged:

```sh
isolated-harness codex --workspace /path/to/project --skills inherited -- \
  --model gpt-5.6-luna --search
```

`--config` copies the chosen TOML file into the isolated `CODEX_HOME` as
`config.toml`; it does not mount or read your host configuration by default.
Codex's own `--config key=value` override therefore belongs after `--`.

The default launch stores its Codex state under
`<workspace>/.contained-harness/codex`. Later launches in the same workspace
can use Codex's own `resume`, plugin, MCP and config state without any runner
session lookup. The workspace state includes the Codex sessions, thread
history, SQLite files, logs, Skills and config; the host login remains a
temporary private file mount and is not written into this directory.

```sh
isolated-harness codex --workspace /path/to/project --skills inherited
isolated-harness codex --workspace /path/to/project -- resume --last
```

Use `--session tower-a-review` when a single workspace needs a second isolated
Codex home. It will live at
`<workspace>/.contained-harness/sessions/tower-a-review/codex`. A project
Codex home fixes its Skills and config at first launch; use a different session
name to change those capabilities.

The workspace remains the only host directory mounted into the container. The
host login is mounted narrowly over `auth.json` only while Codex runs, so no
second login is needed and host conversation history is never mounted.

## Shortest chat command

Build the image once, then send a message:

```sh
node bin/harness-runner.mjs image build
node bin/harness-runner.mjs chat send tower-review-42 /path/to/project "List the files in this workspace."
```

The chosen directory is mounted at `/workspace` with read/write access. The
first command for `tower-review-42` creates one private Codex thread. A later
command with the same chat ID resumes that thread:

```sh
node bin/harness-runner.mjs chat send tower-review-42 /path/to/project "Now summarize what you found."
```

Use a new ID for a new chat. Its thread and runner-owned Codex home are
separate, so it does not receive the previous chat's conversation.

On macOS, when the host has a configured HTTP(S) proxy, the runner reads the
public certificates in the System and login Keychains and writes a temporary
trust bundle into the private chat home. This provides the same public trust
anchors where they are available; it never copies Keychain private keys. A
proxy certificate unavailable from those Keychains can still make Codex fall
back from WebSockets to HTTPS.
Pass `network.trustedCaFile` in an advanced RunSpec when a specific PEM bundle
must be used instead.

```sh
node bin/harness-runner.mjs chat inspect tower-review-42
```

`inspect` emits the stable chat metadata: chat ID, private Codex thread ID,
registered capabilities, and timestamps. It does not expose login data,
prompts, or another chat's state.

## Events for a chat UI

Every line is JSON. Lifecycle events are followed by `codex_event` records
that contain the untouched Codex event in `raw`, plus a stable `kind` that a
frontend can switch on:

| `kind` | What the interface can show |
| --- | --- |
| `thread_started` | Save the runner-owned Codex thread ID. |
| `turn_started` / `turn_completed` | A running indicator and final token usage from `raw.usage`. |
| `assistant_message` | Message body in `raw.item.text`. |
| `command_started` / `command_completed` | Command, output, exit status, and duration from `raw.item`. |

The stream also retains `stdout` and `stderr` events for a diagnostic drawer,
and ends with a `result` event containing the run ID, receipt path, state, and
exit status. Receipts are redacted: credentials never appear in them.

A typical frontend flow is: append the user's message locally, call `chat
send`, render `assistant_message` and command events as they arrive, show
`turn_completed.raw.usage` in the task record, then use the same chat ID for
the next user message.

## Advanced RunSpec API

Use `run <run-spec.json>` when the host application needs multiple mounts,
read-only reference folders, explicit Skills or MCPs, offline mode, or a PEM
bundle for a corporate proxy. See [examples.run-spec.json](../examples.run-spec.json)
and [the chat isolation demo](CHAT_ISOLATION_DEMO.md). The simple `chat send`
command intentionally only mounts one read/write workspace.

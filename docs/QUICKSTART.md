# Isolated Harness — Quick Start

Use `isolated-harness` to open the full Codex CLI in a selected project directory. Codex sessions, Skills, configuration, plugins and MCP state remain in the project's `.contained-harness/` directory. The host authorization is mounted privately only while the container is running.

## Requirements

- Node.js 20 or later
- Docker Desktop running
- An active Codex login on the host (`codex login`)

## Run from a checkout — no npm installation

The package has no third-party runtime dependencies. Clone the repository and
run its CLI with Node.js directly:

```sh
git clone https://github.com/ConcentricCirclesMRTT/Isolated-Harness.git
cd Isolated-Harness
node bin/contained-harness.mjs image build
node bin/contained-harness.mjs codex --workspace /path/to/project --skills inherited
```

This is the recommended option for trying the project before the npm release,
or when you prefer not to install a global command.

## Install globally from npm

```sh
npm install --global isolated-harness
isolated-harness image build
```

The package contains the Dockerfile, so the image build works from any current directory. Docker caches the image; build it again only when the package or its Codex CLI version changes.

## Automatic harness upgrades

Codex and other registered harnesses check for a new stable program version on
startup by default. Checks are shared per harness/CPU platform and cached for
one hour; an open online session also rechecks hourly. Only the program is upgraded; prepared Python/browser dependencies
are reused. A failed automatic update keeps the existing program usable.

Inside the container these commands also work:

```sh
codex update
# Or use the tool-independent entry point:
harness-update
# Codex's npm upgrade prompt uses this route too:
npm install -g @openai/codex@latest
```

The runner installs a new program release in a separate directory, verifies it,
and switches the shared selection atomically. New invocations use the new
version; an already-running process can finish using its previous release.
Program releases are shared read-only, while each chat retains its own state.

To skip startup checks or run a fixed version:

```sh
isolated-harness codex --workspace /path/to/project --no-auto-update
isolated-harness codex --workspace /path/to/project --harness-version 0.165.0
```

Offline sessions use a cached program or initialize Codex from the existing
image without downloading. Pinned sessions do not change the shared selection.
Updating the packaged base image is a separate maintenance operation:

```sh
isolated-harness image update
```

## Other harnesses

Claude Code uses the same automatic program updater and its own project home:

```sh
isolated-harness harness run claude-code --workspace /path/to/project
```

Complete that harness's official login in its isolated home. This launcher does
not inherit the host's Claude configuration or credentials.

Register another npm-distributed harness using its package and executable name:

```sh
isolated-harness harness register --id my-agent --package my-agent-cli --command my-agent
isolated-harness harness run my-agent --workspace /path/to/project
isolated-harness harness update my-agent
```

The generic launcher forwards arguments after `--` to the selected CLI. Both
Codex's specialized interactive/batch adapters and generic launchers use the
same update protocol. Non-npm distributions need an installer adapter.

## Reuse a prepared environment

Build a bundled environment once for durable system packages, Python libraries,
and browser binaries. Each later workspace reuses the resulting local Docker
image instead of downloading tools into `.tools/`:

```sh
isolated-harness environment prebuild drawing-review
isolated-harness codex --workspace /path/to/project --environment drawing-review-v1
```

`browser-review` includes Chromium; `python-analysis` and `document-review`
cover smaller analysis and document tasks. See [Custom environments](ENVIRONMENTS.md)
for all presets, custom specifications, TLS certificates, and reset workflow.

## Reuse a runtime that an agent built

If an earlier workspace already contains a compatible Linux runtime at
`runtime/`, import it into Isolated Harness once. The managed copy is stored
outside both projects, mounted read-only for later runs, and does not bring its
mutable download cache unless requested.

```sh
isolated-harness runtime import --name drawing-runtime \
  --source /path/to/earlier-project/runtime

isolated-harness codex --workspace /path/to/new-project \
  --environment drawing-review-v1 --runtime drawing-runtime
```

Use `isolated-harness runtime list` to inspect available imports. This is for
Linux-container assets such as an agent-created Python environment and
Playwright browser bundle; it does not turn them into macOS-native tools. The
new container sees the runtime at `/workspace/runtime`, while the original
managed artifact stays read-only.

## Open Codex in a project

```sh
isolated-harness codex \
  --workspace /path/to/project \
  --skills inherited
```

This opens the native Codex terminal UI. The project is mounted as `/workspace` in the container, so edits are written directly to the project. The first launch creates:

```text
<project>/
└── .contained-harness/
    └── codex/
        ├── thread_history_1.sqlite
        ├── logs_2.sqlite
        ├── shell_snapshots/
        └── contained-harness.json
```

Codex creates additional session, log, Skill, plugin and configuration files as it needs them. `auth.json` is only an empty placeholder in the project; a usable host authorization is never written there.

## Resume a session

Exit, then use the same workspace to open Codex's native picker of prior chats
stored for that workspace:

```sh
isolated-harness codex \
  --workspace /path/to/project \
  -- resume
```

To resume the most recent Codex thread without opening the picker:

```sh
isolated-harness codex \
  --workspace /path/to/project \
  -- resume --last
```

You can also open the normal Codex UI and use its native resume workflow.

## Common variants

Pass a model and web-search setting through to Codex:

```sh
isolated-harness codex --workspace /path/to/project --skills inherited -- \
  --model gpt-5.6-luna --search
```

Load only named local Skills:

```sh
isolated-harness codex --workspace /path/to/project \
  --skills /path/to/skills/review-skill \
  --skills /path/to/skills/exchange-skill
```

Keep separate state for an audit session in the same project:

```sh
isolated-harness codex --workspace /path/to/project \
  --session audit --skills inherited
```

That state is saved at `<workspace>/.contained-harness/sessions/audit/codex`.

`contained-harness` remains an alias for compatibility.

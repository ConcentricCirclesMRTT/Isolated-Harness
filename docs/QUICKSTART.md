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

## Upgrade Codex in the harness

Do not select the interactive update option inside a running harness. The
container is disposable, so that change would not update the local base image
or any prepared environment. Rebuild the local base image with an explicit
version, then rebuild the environments that use it:

```sh
isolated-harness image build --codex-version 0.155.0
isolated-harness environment prebuild drawing-review
```

The next `isolated-harness codex --environment drawing-review-v1` then runs
the rebuilt image. Omit `--codex-version` to use the version pinned by this
package's Dockerfile.

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

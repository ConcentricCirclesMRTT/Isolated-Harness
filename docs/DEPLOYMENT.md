# Deploying Isolated Harness

Isolated Harness runs beside the service or desktop application that starts
agent work. It is not a remote model gateway: the host retains its existing
provider login, Docker performs the filesystem boundary, and the selected
workspace remains the only project directory mounted into a run.

## Host requirements

- Node.js 20 or later
- Docker Desktop (or a compatible Docker daemon) available to the service user
- A host login for the selected harness, such as `codex login`
- Read/write access to each workspace that users are allowed to select

Build the immutable base image and any environment presets during deployment,
not when a user starts a chat:

```sh
git clone https://github.com/ConcentricCirclesMRTT/Isolated-Harness.git
cd Isolated-Harness
node bin/contained-harness.mjs image build --codex-version 0.155.0
node bin/contained-harness.mjs environment prebuild drawing-review
```

The Docker layer cache keeps these system packages, Python libraries and
browser binaries local to the host. A later chat does not reinstall them into
its workspace.

## Service integration

Start the command as the same operating-system user that owns the Codex login
and Docker access. A service can call the checked-out CLI directly; publishing
to npm is not required:

```sh
node /opt/isolated-harness/bin/contained-harness.mjs codex \
  --workspace /srv/engineering/project-a \
  --environment drawing-review-v1 \
  -- --model gpt-5.6-luna
```

For a deployment that exposes an app-server over stdio, forward its native
arguments in the same way:

```sh
node /opt/isolated-harness/bin/contained-harness.mjs codex \
  --workspace /srv/engineering/project-a \
  --session cowork-thread-1 \
  --environment drawing-review-v1 \
  -- app-server --stdio
```

The parent service owns the stdio protocol and must terminate the child when
the chat ends. Isolated Harness keeps the chat state inside the mounted
workspace under `.contained-harness/`; the host authorization is projected
only for the lifetime of the container and is removed afterward.

## Configuration

Set an explicit executable path when the integrating service cannot discover
the command on `PATH`:

```sh
export TOWER_ISOLATED_HARNESS_BIN=/opt/isolated-harness/bin/contained-harness.mjs
```

The Tower Digital Twin integration accepts either that `.mjs` path or a normal
`isolated-harness` executable. It treats the Container Harness selection as a
project setting, so existing projects continue to use their local Cowork
runtime until switched deliberately.

Keep the Docker daemon and the host login private to the service account. Do
not bind-mount a shared home directory, another project's workspace, or a
host-wide agent-state directory into a user run.

## Operations

Use these checks before enabling the UI option:

```sh
node bin/contained-harness.mjs runtime list
node bin/contained-harness.mjs codex --workspace /srv/engineering/project-a -- --version
```

To reuse a compatible runtime built by an earlier workspace, import it once:

```sh
node bin/contained-harness.mjs runtime import \
  --name drawing-runtime \
  --source /srv/engineering/previous-project/runtime
```

Then select it per run with `--runtime drawing-runtime`. The managed copy is
read-only and lives outside the new project workspace. See
[Custom environments](ENVIRONMENTS.md) for the runtime content contract and
the cache policy.

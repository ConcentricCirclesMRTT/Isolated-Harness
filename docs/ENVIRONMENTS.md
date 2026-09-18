# Custom environments

An environment is a versioned, local Docker image for one class of agent work.
It keeps system packages and Python dependencies outside the mounted workspace.
The base Codex image remains immutable; a selected environment adds declared
dependencies in a Docker build layer.

## Environment specification

Environment specifications use JSON so the package requires no YAML parser.
Only safe Debian package names and pinned-or-unpinned Python package names are
accepted; arbitrary shell commands, URLs, and Dockerfile fragments are not.

```json
{
  "version": "v1",
  "name": "drawing-review-v1",
  "baseImage": "codex-cli:local",
  "apt": ["poppler-utils", "libnss3"],
  "pip": ["jsonschema", "pymupdf"],
  "playwright": ["chromium"]
}
```

`examples/drawing-review.environment.json` is a working starting point. The
resulting image contains Debian dependencies and an isolated Python virtual
environment at `/opt/isolated-harness/python`; its `python` and `pip` are added
to `PATH` for the agent.

`playwright` accepts `chromium`, `firefox`, and `webkit`. It installs the
selected browser binaries and their Linux runtime dependencies into the image
at build time. Selecting a browser also adds the Python `playwright` package.

Browser-oriented presets also expose a disposable compatibility path at
`/workspace/runtime`: `venv` links to the image's Python environment and
`browsers` links to the preinstalled Playwright browser directory. It is a
tmpfs mount for the current container, so it does not create or retain a
`runtime/` directory in the host workspace. This supports Skills that expect
`/workspace/runtime/venv/bin/python` and
`PLAYWRIGHT_BROWSERS_PATH=/workspace/runtime/browsers`.

## Reuse a runtime produced by a workspace

When an agent has already assembled a Linux runtime in a workspace, import it
once as a managed artifact and mount it read-only into later workspaces. The
artifact keeps the compatible `/workspace/runtime` container path, which also
preserves virtual-environment symlinks that use that absolute path.

```sh
isolated-harness runtime import --name drawing-runtime --source /path/to/workspace/runtime
isolated-harness codex --workspace /path/to/new-project --environment drawing-review-v1 --runtime drawing-runtime
```

The default import retains executable runtime entries such as `browsers`,
`python`, `venv`, `uv-arm`, and `uv-wheel`, but deliberately omits a mutable
download `cache/`. Pass `--with-cache` only when that cache is needed for a
separate build workflow. Managed runtime artifacts are Linux-container assets,
not macOS executables; they are mounted read-only and are never copied into the
new project's workspace. A small tmpfs overlay records Playwright's local
installation link while the imported browser binaries remain read-only; an
idempotent `playwright install chromium` therefore reuses the browser without
redownloading it.

## Bundled environments

The package includes four reviewed presets. They are ordinary local Docker
images: build each one once, then select it by name for any number of isolated
workspaces. No subsequent chat downloads those dependencies into its
workspace.

| Preset | Includes |
| --- | --- |
| `python-analysis` | Python, `jsonschema`, `numpy`, and `sympy` |
| `document-review` | Poppler, NSS, Pillow, and PyMuPDF |
| `browser-review` | Python Playwright and Chromium |
| `drawing-review` | Document-review tools, numerical libraries, Playwright, and Chromium |

```sh
isolated-harness environment presets
isolated-harness environment prebuild python-analysis document-review browser-review drawing-review

# Or build just one preset.
isolated-harness environment build --preset drawing-review
```

`environment prebuild` is idempotent from a dependency perspective: Docker
reuses matching layers and a completed image. It is safe to run again after an
image update. Docker images are platform-specific and are therefore built on
the user's machine rather than shipped as large binaries in the npm package.

When the base Codex image changes, rebuild every environment you use. An
environment is derived from the base image at its build time, so updating only
`codex-cli:local` does not alter an already-built `drawing-review-v1` image.
For example:

```sh
isolated-harness image build --codex-version 0.155.0
isolated-harness environment prebuild drawing-review
```

## Build and select

```sh
isolated-harness environment build --spec examples/drawing-review.environment.json
isolated-harness environment list
isolated-harness codex --workspace /path/to/project --environment drawing-review-v1
```

The build record is stored under `~/.isolated-harness/environments/`. It records
the resolved image tag and a digest of the specification. The workspace keeps
only project data and project-owned Codex state; environment dependencies never
need to be downloaded into `.tools/`.

## Reset or rebuild

```sh
isolated-harness environment reset drawing-review-v1
isolated-harness environment build --spec examples/drawing-review.environment.json
```

`reset` removes the named local Docker image and its environment record. It
fails while Docker considers the image in use, rather than forcibly disrupting
a running agent.

## TLS and package indexes

For a proxy whose certificate is not trusted by the Linux base image, add an
explicit machine-local PEM file to the specification:

```json
{
  "version": "v1",
  "name": "drawing-review-with-proxy-ca",
  "baseImage": "codex-cli:local",
  "trustedCaFile": "/absolute/path/to/proxy-ca.pem",
  "pip": ["pymupdf"]
}
```

The certificate is copied into the **local environment image** and registered
with Debian's CA store during the build. When macOS proxy settings are detected
and no explicit file is supplied, Isolated Harness uses the host's public trust
bundle for this local build. Do not publish or share an image that contains an
organization-private certificate. The image enables
`UV_SYSTEM_CERTS=true`, so uv reads the Linux system store. uv can alternatively
use an explicit `SSL_CERT_FILE` PEM bundle for a single run.

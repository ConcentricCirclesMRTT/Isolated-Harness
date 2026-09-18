# Isolated Harness — Implementation Status

Status: **Active implementation record**  
Last updated: **2026-09-18**

## Implemented

- Versioned JSON `RunSpec`, preflight, non-mutating Docker plan, image build,
  and streamed `run` lifecycle for the `codex-cli` adapter.
- Direct directory mounts with canonical-path checks, independent `rw`/`ro`
  modes, overlap rejection, runner-state rejection, and protected
  container-path rejection.
- Container hardening: read-only root, non-root process, dropped capabilities,
  no-new-privileges, tmpfs `/tmp`, a fresh run-local `CODEX_HOME`, and explicit
  `offline` mode with `--network none`.
- `host-codex` login projection: only `auth.json` is copied into the fresh
  session home; history, memory, logs, plugins, and host configuration are not.
  The home is deleted after every completed or failed run.
- Docker Desktop proxy integration on macOS: system HTTP(S) proxy settings are
  mapped to `host.docker.internal` for contained runs. A caller may provide an
  explicit public CA PEM file; the runner copies it into the session home and
  records only that a trust bundle was provided.
- Explicit local Skill snapshots, content digests, and run-local registration.
- Explicit stdio/HTTPS MCP declarations rendered into the fresh Codex config;
  credentials remain external environment-variable references.
- JSONL lifecycle events, stdout/stderr capture, redacted receipts, and unit
  tests for mount, login, capability, proxy, plan, and cleanup behavior.
- `isolated-harness codex`: an interactive direct-mount launcher for the real
  Codex CLI. It forwards Codex arguments without wrapping or limiting the TUI,
  snapshots explicitly selected Skills or a deliberate host Skill inheritance
  into the workspace-owned Codex home, and supports Codex `resume`, MCP, and
  plugin state directly from that workspace. The host auth projection remains
  a private temporary file mount.

## Live acceptance evidence

Docker Desktop `28.2.2` and an isolated image containing `codex-cli 0.155.0`
were used for an end-to-end run. The agent received a host-login projection,
ran as uid `501:20` with a single temporary `rw` mount, wrote only the requested
`runner-proof.txt` into that mount, exited with code zero, and had its session
home removed. The receipt records the direct mount, fresh-session state, proxy
status, and no secret values.

The current host network intercepts Codex WebSockets with a certificate chain
not accepted by the Linux client. The runner transparently fell back to HTTPS
and completed the run. This degradation is visible in captured events; it is
not reported as a clean WebSocket connection.

## Remaining work

- Install selected plugins from a run-local marketplace snapshot.
- Add a runner-managed capability catalog and controlled inheritance profiles.
- Add a loopback API, durable runner database, cancellation API, and application
  integration.
- Add Claude and DeepSeek adapters against the same RunSpec and receipt contracts.

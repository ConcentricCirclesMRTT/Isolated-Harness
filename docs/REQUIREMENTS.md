# Isolated Harness — Requirements

This document describes what an isolated harness run needs and what an adapter
must preserve. It applies to Codex CLI now and to future Claude Code, DeepSeek,
or other harness adapters.

## Runtime requirements

- A supported OCI-compatible container runtime. The current implementation uses
  Docker Desktop.
- A built harness image that contains the requested agent CLI. Custom environments build a local, versioned image from that base; they do not install packages into the workspace at run time.
- A selected host directory that can be mounted as the workspace. A writable
  mount is intentionally edited in place; it is not copied to a temporary clone.
  The host filesystem root, home directory, and temporary-directory root are
  rejected; a named project directory beneath the temporary directory remains
  valid when explicitly selected.
- For hosted models, bridge-network access to the provider endpoint and any
  required proxy trust configuration. The `offline` profile disables network
  access and therefore needs an offline-compatible harness or task.

## Authorization requirements

Isolated Harness does not create a second account, transfer billing, or replace
provider authorization. The adapter must use one explicit authorization source:

1. **Existing subscription login.** The Codex adapter currently reads the host's
   active Codex authorization, creates a narrow temporary projection for the
   container, and removes that projection after the run. It never mounts the
   host's complete Codex home.
2. **Official provider API.** An adapter can be configured with the official API
   flow and endpoint supported by its harness.
3. **Approved alternative provider.** An organization may choose a managed
   gateway, self-hosted endpoint, or another provider only when its adapter
   declares the endpoint and authorization behavior explicitly.

The authorization source must be sufficient for the selected harness to reach
its model service. It must never become a way to mount host home directories,
read prior chat state, or persist a reusable secret in the project workspace.

## Isolation requirements

Every run must enforce the following rules:

- Only declared workspace and reference directories are mounted; the Docker
  socket, host home and unrelated projects are absent.
- Agent state belongs to the selected workspace and optional named session.
  State from another project or chat is not reused implicitly.
- Skills, plugins, MCP servers and configuration are selected explicitly or by
  a declared profile, then materialized into the isolated state.
- Receipts and logs record resolved mounts, selected capabilities, lifecycle and
  authorization outcome, while redacting credential values.
- The container runs without privileged mode, host networking or the host PID
  namespace. It uses a non-root process and a restricted container filesystem.

## Adapter requirements

A new harness adapter must:

1. Declare the harness image, command, supported authorization modes and
   network requirements.
2. Use the common mount planner and reject undeclared host paths.
3. Use a fresh project/session-local harness home and avoid importing global
   history or configuration.
4. Register only the resolved Skills, MCP servers, plugins and configuration.
5. Stream normalized lifecycle events and write a redacted run receipt.
6. Document how its subscription login, official API flow, and any approved
   alternative provider are projected into the isolated environment.

## Current support

Codex CLI is the implemented adapter. Claude Code and DeepSeek harness adapters
are planned; they must satisfy these same requirements before being presented as
available.

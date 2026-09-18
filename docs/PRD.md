# Isolated Harness — Product Requirements Document

Status: **Draft for implementation**  
Owner: Industrial AI  
Last updated: **2026-09-18**

## 1. Product decision

Isolated Harness is a local execution service and CLI for
running an agent harness inside an isolated container. It is not a chat product,
a Git-worktree manager, or a replacement for a harness such as Codex CLI.

Its job is to make a harness useful with broad authority **inside an explicitly
constructed execution filesystem**, while ensuring that host files, host agent
session state and host configuration outside that filesystem are not visible to
the process. The active host harness login is the explicit exception: it is
provided through a narrow credential bridge, not by exposing the host agent
home.

The first harness adapter is **Codex CLI**. The product must be able to add
other harnesses later without duplicating isolation, mount planning, Skill
selection, MCP/plugin policy, run recording, or lifecycle management.

## 2. Problem

A locally run coding agent normally inherits the user account's filesystem,
agent home directory, prior conversations, Skills, MCP servers, plugins and
often implicit credentials. Permission prompts reduce accidental actions but do
not create an enforceable filesystem boundary. Copying a project to a temporary
workspace helps isolation but makes large engineering datasets expensive and
breaks the user's expectation that the agent edits the supplied directory
itself.

Engineering applications need a middle ground:

- a user can give a harness ordinary read/write access to one or more selected
  project directories;
- every other host path is absent from the process view;
- each run starts without another run's transcript, memory, rollout or tool
  state while continuing to use the already logged-in host identity;
- Skills, MCP servers and plugins are selected as capabilities for this run,
  rather than accidentally inherited from a developer's global configuration;
- the same contract works for Codex now and other harnesses later.

## 3. Goals

1. **Enforced mounted-directory boundary.** A harness can read or write only
   files exposed through declared container mounts and the runner image's own
   runtime files. It cannot browse other host directories.
2. **Direct mounted workspaces.** Selected host directories are bind-mounted
   directly. A writable mount is writable in place by default; Isolated Harness must not
   silently copy it to a disposable workspace.
3. **Fresh session, shared login.** Every run receives a fresh harness home and
   session store, but inherits the current host login through the credential
   bridge without asking the user to sign in again. No previous chat, rollout,
   memory, log, plugin state or history is inherited unless the RunSpec
   explicitly imports a named, runner-owned artifact.
4. **Granular capability selection.** Skills, MCP servers and plugins are
   resolved from explicit sources and a per-run allowlist. Global host
   configuration is never inherited merely because it exists.
5. **Harness-neutral control plane.** One RunSpec, capability model and receipt
   format serve many harness adapters. Codex CLI is the first supported adapter.
6. **Auditable execution.** Each run produces a durable receipt of the resolved
   image, mounts, selected capabilities, isolation policy, harness version,
   lifecycle events and output locations, without storing hidden model
   reasoning.

## 4. Non-goals

- Rebuilding Codex CLI, its model service, its interactive UX or its native
  sandbox implementation.
- Replacing Docker or claiming that containerization alone makes malicious code
  harmless.
- Copying a workspace, making a Git branch, committing changes, or synchronizing
  a repository automatically. Those may be future adapters or caller features;
  they are not the default work model.
- Automatically importing every user Skill, MCP server, plugin or prior
  session. The active host login is inherited only through the explicit,
  harness-specific credential bridge described below.
- Defining a Digital Twin, CAD, Tower IR or application-specific artifact
  protocol. Applications consume the generic run receipt and direct mounts.
- Supporting arbitrary Docker flags supplied by an untrusted caller.

## 5. Primary users and jobs

| User | Job | Success condition |
| --- | --- | --- |
| Engineer | Let Codex edit the selected project data directly. | Expected files change under declared mounts; no other host path is available. |
| Digital Twin application | Start a project-scoped agent run with known Skills and MCP tools. | The application receives observable state and a machine-readable receipt. |
| Skill author | Test a specific Skill release against a project. | The exact bundle, version and hash used by the run are recorded. |
| Platform maintainer | Add a second harness. | It implements an adapter without reimplementing container security or capability selection. |

## 6. Core product model

### 6.1 Run

A **run** is a new, isolated harness process inside one container. It has an
immutable RunSpec, one session-local harness home, explicit mounts and a
capability resolution result. A run is not a continuation of a previous run.

The runner persists its own metadata under a configured runner state root, for
example `~/.isolated-harness/runs/<run-id>/`. That state is not
mounted into the container as the harness home.

### 6.2 Direct mounts

A mount is a canonical host path, container path and access mode. A caller can
supply multiple mounts. The default for an application-selected work directory
is `rw`; `ro` is available for source libraries, reference data or generated
inputs.

```yaml
mounts:
  - hostPath: /projects/tower-a
    containerPath: /workspace/tower-a
    mode: rw
  - hostPath: /projects/tower-reference
    containerPath: /references/tower-reference
    mode: ro
```

Isolated Harness bind-mounts these paths directly. There is no default overlay clone, temp
copy or automatic Git handoff. A harness writes to `/workspace/tower-a`, and
those changes are immediately changes to `/projects/tower-a` on the host.

The mount planner must canonicalize paths, reject a mount of `/`, the runner
state root, the Docker socket, sensitive system paths, overlapping destinations
and a container path outside the runner's mount namespace. It must not expose a
host home directory by implication. The receipt records resolved paths and
modes.

### 6.3 Fresh session home and shared host login

Each adapter receives a new home under a container-only path such as
`/run/harness-home`. For Codex this is the run's `CODEX_HOME`.

It must contain only:

- adapter-generated configuration;
- selected capability registrations;
- an ephemeral minimum authentication projection from the approved host
  credential bridge;
- data produced during the current run.

The default Codex provider is `host-codex`: if Codex is already logged in on the
host, it provisions the session-local `CODEX_HOME` with the minimum current
authentication material needed by Codex. The user must not be asked to log in
again for each container run. The bridge never bind-mounts the host
`CODEX_HOME`, and never imports its history, memories, rollouts, logs, prior
sessions, marketplace state, global plugin state or arbitrary configuration.

The bridge is host-side and adapter-owned. It may refresh or replace the
ephemeral session projection when the host's valid login changes, but it may not
write back session state to the host login store. Receipts report only the
provider identity and authentication outcome (`available`, `expired`,
`unavailable` or `failed`); they never include credential values. A completed
run's home is retained or deleted according to a runner retention policy, but
is never made the next run's home.

### 6.4 Capability bundle

A **capability bundle** is the complete set of non-filesystem capabilities
provided to one run:

- Skills;
- MCP server declarations;
- plugins;
- optional adapter settings such as model and reasoning level.

Each item has an ID, source, version, content digest, type, enabled state,
configuration digest, dependency declaration and approval status. Resolution is
an explicit operation before container start.

```yaml
capabilities:
  inherit:
    skills: false
    mcps: false
    plugins: false
  skills:
    - id: tower-exchange
      source: /catalog/tower-exchange/5.3.0
      enabled: true
  mcps:
    - id: tower-review
      source: managed://tower-review/v1
      enabled: true
  plugins: []
```

`inherit: false` is the default for every category. “Inherit” means importing
from a named, runner-managed catalog or profile, never scanning the host agent
home. A profile can enable a curated set, but the resolved list must still be
recorded item by item.

### 6.5 Harness adapter

A harness adapter translates the generic RunSpec into a container image,
command, environment, session-home layout, capability registrations and parsed
lifecycle events.

```text
HarnessAdapter
  validate(spec, resolvedCapabilities)
  prepareSessionHome(run)
  buildContainerPlan(run)
  start(plan)
  streamEvents(handle)
  stop(handle)
  collectReceipt(handle)
```

The adapter is not allowed to add host mounts, unapproved network access or
undeclared capabilities. The control plane owns those decisions.

## 7. Functional requirements

### FR-1: Create and validate a RunSpec

Isolated Harness must accept a versioned RunSpec through a local CLI and a local API. Before
starting a container, it validates mount paths, access modes, chosen harness,
capability selectors, isolation profile and credential-provider references.

The runner rejects unknown fields in security-sensitive sections, unrecognized
harness IDs, duplicate mount destinations and missing capability sources.

### FR-2: Enforce filesystem isolation

The runtime must use a container runtime with no host filesystem mount except
those in the approved mount plan. It must not mount the Docker socket, host home
or runner state root. The container runs as a non-root user, drops unnecessary
Linux capabilities, has no privileged mode, and uses a read-only container root
filesystem except for explicit runtime temp paths and selected writable mounts.

A mount is a capability. The runner must display it before start and record it
after start. Symlink resolution, container-path traversal, mount shadowing and
nested mount ambiguity must be rejected or resolved deterministically.

### FR-3: Isolation profiles

Isolated Harness v1 supports these profiles:

| Profile | Network | Host mounts | Intended use |
| --- | --- | --- | --- |
| `contained` | Docker bridge egress; never host network | declared `rw`/`ro` paths | normal Codex project work |
| `offline` | disabled | declared `rw`/`ro` paths | local-model or no-network tasks |

`contained` deliberately permits ordinary bridge egress because Codex must
reach its model provider. On macOS, Isolated Harness detects the system HTTP(S) proxy and
passes it through Docker Desktop's `host.docker.internal` route. It does not
expose the host network namespace. Domain egress restrictions require an
approved proxy/firewall integration and are not claimed by the v1 Docker flags.
Future profiles may support GPU or remote execution, but none may weaken
filesystem mount validation.

### FR-4: Codex CLI adapter

The initial adapter must:

- run the installed/pinned Codex CLI in the selected container image;
- point `CODEX_HOME` to the new session-local home;
- use the default `host-codex` credential bridge so an already authenticated
  host Codex session is usable without a second login;
- start in a declared writable mount or reject the run if no writable working
  directory is selected;
- register only resolved Skills, MCP servers and plugins;
- support interactive and non-interactive (`exec`) runs;
- stream normalized lifecycle events: prepared, starting, running, waiting for
  input, completed, failed, cancelled;
- record the model, reasoning setting, CLI version and effective configuration
  that the adapter can observe.

Codex itself already exposes per-run permissions and writable-root inspection;
Isolated Harness complements this by making the host filesystem boundary independent of a
prompt or CLI approval choice. [Codex CLI documentation](https://developers.openai.com/ko-KR/docs/codex/cli)

### FR-5: Skill management

The Skill manager must provide:

1. **Catalogs:** system, organization, project and explicit local sources.
2. **Selection:** choose zero or more Skills by immutable version/digest or
   named release.
3. **Policy:** permit/deny a Skill, restrict implicit invocation where the
   harness supports it, and validate declared dependencies.
4. **Materialization:** make only selected immutable Skill bundles available in
   the container, preferably read-only under an adapter-defined catalog path.
5. **Receipts:** record requested, resolved, rejected and actually registered
   Skills.

A local source is not copied from the user's global Skill home by default.
Instead, the caller chooses a catalog entry or an explicit source path; Isolated Harness
snapshots it into a content-addressed runner cache before launch. This snapshot
is capability material, not a replacement for directly mounted work data.

### FR-6: MCP and plugin management

MCP servers and plugins use the same selection and receipt model. Their
configuration can refer only to mounted paths, runner-managed configuration,
approved environment variables and declared network access. Secret values are
resolved at launch and redacted from receipts and event logs.

MCP and plugins are disabled unless selected. Any interactive login, OAuth flow
or external data transmission is surfaced as an explicit harness/user request;
the runner must not silently reuse credentials from another **run**. The
host-login credential bridge is distinct: it deliberately shares the user's
current host Codex identity with a new session-local Codex auth projection, but
does not share any prior session memory or third-party MCP/plugin credentials.

### FR-7: Host-login credential bridge

Isolated Harness must provide a harness-specific credential provider interface. The initial
`host-codex` provider is enabled by default for the Codex CLI adapter and must:

1. detect whether the host has a currently usable Codex login without exposing
   login secrets in CLI output or application logs;
2. provision only the minimum authentication material into the run's
   session-local `CODEX_HOME` immediately before container start;
3. avoid bind-mounting the host Codex home, host keychain, general user home or
   other session files into the container;
4. avoid a per-run interactive login when the host credential is valid;
5. surface an actionable `host_login_unavailable` state when no usable host
   login exists, instead of silently falling back to a different account or
   API key;
6. erase the ephemeral projection during run cleanup when retention policy
   permits, and redact all values from records.

The generic provider interface also supports future sources such as a service
account or an explicit API-key broker. Those are not selected implicitly and do
not change the default host-login behavior.

### FR-8: Multiple harnesses

The registry must let applications list harnesses and their capabilities, then
select one in the RunSpec. V1 ships `codex-cli`; it must reserve stable adapter
IDs and schemas for future adapters such as Claude Code or a domain-specific
harness.

A harness does not change the mount, session, capability or receipt contracts.
A harness may declare unsupported features, which causes preflight rejection
rather than a silent fallback.

### FR-9: Run records, observability and recovery

A run record must include:

- RunSpec digest and runner version;
- selected adapter/image/harness version;
- resolved mount plan;
- session-isolation status;
- credential provider identity and redacted authentication outcome;
- selected and actual capabilities;
- network/isolation profile;
- timestamps, state transitions, exit status and human-readable failure reason;
- paths to allowed outputs or caller-provided artifact references;
- redacted event stream and structured request/approval events.

On crash or runner restart, Isolated Harness must report whether the container is still
running, exited or became unknown. It must never claim a run completed merely
because its controlling UI disconnected.

## 8. Interfaces

### 8.1 CLI, provisional

```bash
harness-runner harness list
harness-runner capability resolve --spec run.yaml
harness-runner run --spec run.yaml
harness-runner runs get <run-id>
harness-runner runs stop <run-id>
harness-runner runs logs <run-id>
```

`run` prints a run ID immediately and streams normalized events. It does not
implicitly create a Git branch or copy a workspace.

### 8.2 Local API, provisional

```text
POST   /v1/runs                 create/start a run
GET    /v1/runs/{runId}         state and receipt
GET    /v1/runs/{runId}/events  resumable event stream
POST   /v1/runs/{runId}/stop    request cancellation
POST   /v1/capabilities/resolve preview selected capabilities
GET    /v1/harnesses            adapters and supported features
```

The API binds to loopback by default. A caller such as Tower Cowork must pass a
project-scoped RunSpec and consume events/receipts; it must not write directly
to the runner state database.

## 9. Security and data policy

- Isolation is enforced by container mounts and runtime configuration, not only
  by system prompts or harness permission dialogs.
- Direct writable mounts are intentionally powerful: the harness can alter any
  file in those directories. The UI must show the exact directories before a
  run starts.
- Container escape, kernel vulnerabilities and malicious dependencies remain
  outside the guarantee of this product. Isolated Harness documents its threat model and
  keeps the container runtime patched.
- No Docker socket, privileged mode, host PID namespace, host network namespace
  or arbitrary `docker run` arguments in v1.
- Secrets never appear in RunSpecs, receipts, event logs or the container image.
- The runner never exports a previous run's memory/session by default. Explicit
  import/export is a later, named artifact feature with its own receipt.

## 10. Product experience

Applications should show a concise run review before launch:

```text
Harness: Codex CLI
Working directories: 2 mounted (1 read/write, 1 read-only)
Session: new; no prior session memory
Login: inherited from current host Codex session
Skills: 2 selected; global Skills not inherited
MCP: 1 selected; plugins: none
Network: disabled
```

During execution, they show container lifecycle, harness activity, user
requests and output references. They should not invent “complete” status when
the runner reports a crash, unknown state or unreconciled container.

## 11. Acceptance criteria

1. A Codex run with `/project-a` mounted at `/workspace` can create and edit
   files in `/project-a`; it cannot list an unmounted sibling directory or the
   host user home.
2. Two consecutive runs use distinct `CODEX_HOME` directories. A marker placed
   in the first run's session state is absent from the second run.
3. A host already logged in to Codex can start two isolated Codex runs without
   either run opening a second login flow. Each receipt reports `host-codex`
   and a redacted successful authentication outcome; no host `CODEX_HOME` is a
   container mount.
4. A default run has no host-global Skills, MCPs or plugins. A chosen Skill,
   MCP or plugin appears only after successful resolution and is listed in the
   receipt with a digest.
5. A RunSpec can declare at least two direct mounts with independent `rw` and
   `ro` modes; changes through an `rw` mount immediately appear on the host.
6. The Codex adapter accepts an interactive run and an `exec` run and emits the
   normalized lifecycle states.
7. A malformed mount, an undeclared capability, a host-home mount, a Docker
   socket mount, or an unsupported adapter feature is rejected before container
   creation.
8. Stopping a run or restarting the runner yields a truthful terminal or
   recovery state, never an assumed success.
9. A second adapter test double can implement the adapter interface and run
   through the same RunSpec/receipt pipeline without Codex-specific fields.

## 12. Delivery plan

### Milestone 0 — Contract and threat model

- Freeze the RunSpec, capability manifest and run receipt schemas.
- Document container-runtime requirements and non-goals.
- Build unit tests for mount validation and capability resolution.

### Milestone 1 — Codex contained runner

- Implement the local CLI, loopback API, Docker plan and Codex adapter.
- Implement fresh `CODEX_HOME`, the `host-codex` credential bridge, direct
  mount planner, provider-egress bridge networking and normalized lifecycle
  event stream.
- Add integration tests proving mounted and unmounted path behavior.

### Milestone 2 — Capability manager

- Implement content-addressed Skill snapshots, manifest validation, catalog
  selection and receipts.
- Add selected MCP/plugin materialization with deny-by-default policy.
- Add secret-provider boundary and redaction tests.

### Milestone 3 — Application integration and second adapter

- Integrate a Tower Cowork execution-profile selector and receipt projection.
- Add a lightweight second adapter/test harness to prove adapter neutrality.
- Evaluate explicit session-artifact import/export separately from default
  session isolation.

## 13. Open decisions

1. Which container runtime is required on macOS, Linux and Windows/WSL2, and
   how is its availability reported to the caller?
2. Which exact minimum host-login artifacts and renewal flow does the installed
   Codex CLI require, and can the bridge provision them through OS credential
   APIs rather than handling a long-lived secret file directly?
3. What proxy/firewall integration can enforce provider and approved-MCP egress
   without preventing Codex model access?
4. Should a Skill with executable dependencies receive a build-image extension,
   a prebuilt image, or fail resolution until a managed image exists?
5. How long should runner-owned run homes and redacted logs be retained, and
   who can inspect them?

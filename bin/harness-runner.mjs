#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRunSpec } from '../src/spec.mjs';
import { planMounts } from '../src/mounts.mjs';
import { inspectHostCodexLogin } from '../src/credentials/hostCodex.mjs';
import { buildCodexContainerPlan } from '../src/adapters/codex.mjs';
import { defaultStateRoot, startCodexRun } from '../src/run.mjs';
import { resolveCapabilities } from '../src/capabilities.mjs';
import { buildEnvironment, listEnvironmentPresets, listEnvironments, presetEnvironmentSpec, resetEnvironment, verifyEnvironment } from '../src/environments.mjs';
import { importRuntime, listRuntimes } from '../src/runtimes.mjs';
import { buildImage, codexVersionPattern } from '../src/images.mjs';
import { listHarnesses, prepareHarness, registerHarness } from '../src/harnesses.mjs';
import { runHarness } from '../src/generic-harness.mjs';

const [command, subcommand, ...arguments_] = process.argv.slice(2);
const usage = `Usage:
  harness-runner <preflight|plan|run> <run-spec.json>
  harness-runner image <build|update> [tag] [--codex-version <version|latest>]
  harness-runner environment build --spec <environment.json>
  harness-runner environment build --preset <name> [--runtime-source <directory>]
  harness-runner environment presets
  harness-runner environment prebuild [preset ...]
  harness-runner environment list
  harness-runner environment verify <name>
  harness-runner environment reset <name>
  harness-runner runtime import --name <name> --source <directory> [--with-cache]
  harness-runner runtime list
  harness-runner harness list
  harness-runner harness update <id> [--version <version>] [--image <image>]
  harness-runner harness register --id <id> --package <npm-package> --command <executable>
  harness-runner harness run <id> --workspace <directory> [--environment <name>] [--offline] [--no-auto-update] [--harness-version <version>] [-- <args...>]
  harness-runner chat send <chat-id> <workspace-directory> <message...>
  harness-runner chat inspect <chat-id>`;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
function imageBuildOptions(args) {
  let image = 'codex-cli:local';
  let version;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--codex-version' && args[index + 1]) version = args[++index];
    else if (!args[index].startsWith('-') && image === 'codex-cli:local') image = args[index];
    else throw new Error(usage);
  }
  if (version !== undefined && version !== 'latest' && !codexVersionPattern.test(version)) throw new Error('CODEX_VERSION_INVALID: use latest or an exact semantic Codex CLI version.');
  return { image, version };
}
function chatSpec(chatId, workspace, task) {
  return validateRunSpec({
    version: 'v1',
    harness: { id: 'codex-cli' },
    workingDirectory: '/workspace',
    mounts: [{ hostPath: workspace, containerPath: '/workspace', mode: 'rw' }],
    chat: { id: chatId },
    task
  });
}
async function environmentBuildOptions(args) {
  let spec;
  let runtimeSource;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--preset' && args[index + 1]) spec = await presetEnvironmentSpec(args[++index]);
    else if (args[index] === '--spec' && args[index + 1]) spec = args[++index];
    else if (args[index] === '--runtime-source' && args[index + 1]) runtimeSource = args[++index];
    else throw new Error(usage);
  }
  if (!spec) throw new Error(usage);
  return { spec, runtimeSource };
}
function runtimeImportOptions(args) {
  const options = { includeCache: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--name') options.name = args[++index];
    else if (args[index] === '--source') options.source = args[++index];
    else if (args[index] === '--with-cache') options.includeCache = true;
    else throw new Error(usage);
  }
  if (!options.name || !options.source) throw new Error(usage);
  return options;
}
function harnessOptions(args) {
  const options = { args: [] };
  if (args[0] && !args[0].startsWith('-')) options.id = args[0];
  for (let index = options.id ? 1 : 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') { options.args = args.slice(index + 1); break; }
    if (value === '--offline') options.offline = true;
    else if (value === '--no-auto-update') options.autoUpdate = false;
    else {
      const fields = { '--id': 'id', '--workspace': 'workspace', '--environment': 'environmentName', '--image': 'image', '--version': 'version', '--harness-version': 'version', '--package': 'package', '--command': 'command' };
      if (!fields[value] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(usage);
      options[fields[value]] = args[++index];
    }
  }
  if (!options.id) throw new Error(usage);
  return options;
}
try {
  if (command === 'harness' && subcommand === 'list') emit({ type: 'harnesses', harnesses: await listHarnesses() });
  else if (command === 'harness' && subcommand === 'register') emit({ type: 'harness_registered', ...(await registerHarness(harnessOptions(arguments_))) });
  else if (command === 'harness' && subcommand === 'update') {
    const program = await prepareHarness({ ...harnessOptions(arguments_), force: true });
    emit({ type: 'harness_updated', id: program.id, version: program.version, release: program.release });
  }
  else if (command === 'harness' && subcommand === 'run') {
    const options = harnessOptions(arguments_);
    if (!options.workspace) throw new Error(usage);
    const result = await runHarness(options);
    process.exitCode = result.exit.code ?? 1;
  }
  else if (command === 'image' && ['build', 'update'].includes(subcommand)) {
    const options = imageBuildOptions(arguments_);
    const base = await buildImage(options);
    emit({ type: 'image_built', ...base });
    if (subcommand === 'update') {
      for (const environment of await listEnvironments()) {
        if (environment.spec?.baseImage !== base.image) continue;
        const { source: _source, trustedCaFile: ca, ...spec } = environment.spec;
        if (environment.trust === 'explicit-file') throw new Error(`Environment ${environment.name} uses an explicit CA. Rebuild it with its original --spec file.`);
        // Legacy records store only a CA basename, not a usable host path.
        const directory = await mkdtemp(join(tmpdir(), 'isolated-harness-update-'));
        try {
          const path = join(directory, 'environment.json');
          await writeFile(path, JSON.stringify(spec), { mode: 0o600 });
          emit({ type: 'environment_built', ...(await buildEnvironment(path)) });
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }
  else if (command === 'environment' && subcommand === 'build') { const options = await environmentBuildOptions(arguments_); emit({ type: 'environment_built', ...(await buildEnvironment(options.spec, { runtimeSource: options.runtimeSource })) }); }
  else if (command === 'environment' && subcommand === 'presets') emit({ type: 'environment_presets', presets: await listEnvironmentPresets() });
  else if (command === 'environment' && subcommand === 'prebuild') {
    const presets = arguments_.length ? arguments_ : await listEnvironmentPresets();
    emit({ type: 'environment_prebuild_started', presets });
    for (const preset of presets) {
      const specPath = await presetEnvironmentSpec(preset);
      emit({ type: 'environment_built', ...(await buildEnvironment(specPath)) });
    }
  }
  else if (command === 'environment' && subcommand === 'list') emit({ type: 'environments', environments: await listEnvironments() });
  else if (command === 'environment' && subcommand === 'verify') {
    if (!arguments_[0] || arguments_.length !== 1) throw new Error(usage);
    emit({ type: 'environment_verified', ...(await verifyEnvironment(arguments_[0])) });
  }
  else if (command === 'environment' && subcommand === 'reset') {
    if (!arguments_[0] || arguments_.length !== 1) throw new Error(usage);
    emit({ type: 'environment_reset', ...(await resetEnvironment(arguments_[0])) });
  }
  else if (command === 'runtime' && subcommand === 'import') emit({ type: 'runtime_imported', ...(await importRuntime(runtimeImportOptions(arguments_))) });
  else if (command === 'runtime' && subcommand === 'list') emit({ type: 'runtimes', runtimes: await listRuntimes() });
  else if (command === 'chat' && subcommand === 'send') {
    const [chatId, workspace, ...messageParts] = arguments_;
    const task = messageParts.join(' ').trim();
    if (!chatId || !workspace || !task) throw new Error(usage);
    const result = await startCodexRun(chatSpec(chatId, workspace, task), { onEvent: emit });
    emit({ type: 'result', ...result });
  } else if (command === 'chat' && subcommand === 'inspect') {
    const [chatId] = arguments_;
    if (!chatId) throw new Error(usage);
    // validate the identifier without starting a container or touching a workspace.
    chatSpec(chatId, '/workspace', 'inspect');
    const statePath = join(defaultStateRoot(), 'chats', chatId, 'chat.json');
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`CHAT_NOT_FOUND: no private state exists for chat "${chatId}".`); throw error; }
    emit({ type: 'chat', ...state, statePath });
  } else if (['preflight', 'plan', 'run'].includes(command) && subcommand) {
    const specPath = subcommand;
    const spec = validateRunSpec(JSON.parse(await readFile(specPath, 'utf8')));
    if (command === 'run') {
      const result = await startCodexRun(spec, { onEvent: emit }); emit({ type: 'result', ...result });
    } else {
      const mounts = await planMounts(spec.mounts, { runnerStateRoot: defaultStateRoot() });
      const capabilities = await resolveCapabilities(spec.capabilities ?? {});
      const login = await inspectHostCodexLogin();
      if (command === 'preflight') emit({ valid: true, harness: spec.harness.id, mounts, login: { provider: login.provider, status: login.status }, capabilities });
      else {
        if (login.status !== 'available') throw new Error('HOST_LOGIN_UNAVAILABLE: log in to Codex on the host before generating a runnable plan.');
        const plan = buildCodexContainerPlan({ image: spec.harness.image ?? 'codex-cli:local', mounts, workingDirectory: spec.workingDirectory, sessionCodexHome: '<runner-managed-session-home>', profile: spec.isolation?.profile ?? 'contained', task: spec.task });
        emit({ ...plan, harnessProgram: { autoUpdate: spec.harness.autoUpdate ?? true, version: spec.harness.version ?? 'latest' }, credential: { provider: 'host-codex', status: 'available' }, capabilities });
      }
    }
  } else { throw new Error(usage); }
} catch (error) { console.error(`${error.code ?? 'RUNNER_ERROR'}: ${error.message}`); process.exitCode = 1; }

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRunSpec } from '../src/spec.mjs';
import { planMounts } from '../src/mounts.mjs';
import { inspectHostCodexLogin } from '../src/credentials/hostCodex.mjs';
import { buildCodexContainerPlan } from '../src/adapters/codex.mjs';
import { defaultStateRoot, startCodexRun } from '../src/run.mjs';
import { resolveCapabilities } from '../src/capabilities.mjs';
import { buildEnvironment, listEnvironmentPresets, listEnvironments, presetEnvironmentSpec, resetEnvironment } from '../src/environments.mjs';
import { importRuntime, listRuntimes } from '../src/runtimes.mjs';

const [command, subcommand, ...arguments_] = process.argv.slice(2);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const usage = `Usage:
  harness-runner <preflight|plan|run> <run-spec.json>
  harness-runner image build [tag] [--codex-version <version>]
  harness-runner environment build --spec <environment.json>
  harness-runner environment build --preset <name>
  harness-runner environment presets
  harness-runner environment prebuild [preset ...]
  harness-runner environment list
  harness-runner environment reset <name>
  harness-runner runtime import --name <name> --source <directory> [--with-cache]
  harness-runner runtime list
  harness-runner chat send <chat-id> <workspace-directory> <message...>
  harness-runner chat inspect <chat-id>`;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const codexVersion = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;
function imageBuildOptions(args) {
  let image = 'codex-cli:local';
  let version;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--codex-version') version = args[++index];
    else if (!args[index].startsWith('-') && image === 'codex-cli:local') image = args[index];
    else throw new Error(usage);
  }
  if (version && !codexVersion.test(version)) throw new Error('CODEX_VERSION_INVALID: use a semantic Codex CLI version such as 0.155.0.');
  return { image, version };
}
async function buildImage({ image = 'codex-cli:local', version } = {}) {
  const arguments_ = ['build', '--tag', image];
  if (version) arguments_.push('--build-arg', `CODEX_VERSION=${version}`);
  arguments_.push('.');
  await new Promise((resolve, reject) => { const child = spawn('docker', arguments_, { cwd: packageRoot, stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Docker image build exited ${code}`))); });
  emit({ type: 'image_built', image, codexVersion: version ?? 'Dockerfile default' });
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
async function environmentSpecPath(args) {
  if (args[0] === '--preset' && args[1] && args.length === 2) return presetEnvironmentSpec(args[1]);
  if (args[0] !== '--spec' || !args[1] || args.length !== 2) throw new Error(usage);
  return args[1];
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
try {
  if (command === 'image' && subcommand === 'build') await buildImage(imageBuildOptions(arguments_));
  else if (command === 'environment' && subcommand === 'build') emit({ type: 'environment_built', ...(await buildEnvironment(await environmentSpecPath(arguments_))) });
  else if (command === 'environment' && subcommand === 'presets') emit({ type: 'environment_presets', presets: await listEnvironmentPresets() });
  else if (command === 'environment' && subcommand === 'prebuild') {
    const presets = arguments_.length ? arguments_ : await listEnvironmentPresets();
    emit({ type: 'environment_prebuild_started', presets });
    for (const preset of presets) emit({ type: 'environment_built', ...(await buildEnvironment(await presetEnvironmentSpec(preset))) });
  }
  else if (command === 'environment' && subcommand === 'list') emit({ type: 'environments', environments: await listEnvironments() });
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
        emit({ ...plan, credential: { provider: 'host-codex', status: 'available' }, capabilities });
      }
    }
  } else { throw new Error(usage); }
} catch (error) { console.error(`${error.code ?? 'RUNNER_ERROR'}: ${error.message}`); process.exitCode = 1; }

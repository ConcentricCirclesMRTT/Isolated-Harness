#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startInteractiveCodex } from '../src/interactive.mjs';

const usage = `Usage:
  isolated-harness codex --workspace <directory> [--skills inherited|none|<skill-dir>]... [--config <config.toml>] [--session <id>] [--environment <name>] [--runtime <name>] [--offline] [--image <image>] [-- <codex CLI args...>]
  isolated-harness image build [tag]
  isolated-harness environment <build|list|reset> ...
  isolated-harness runtime <import|list> ...

Everything after -- is forwarded unchanged to the real Codex CLI in the container.`;
const runnerCommands = new Set(['image', 'environment', 'runtime', 'preflight', 'plan', 'run', 'chat']);

function parse(argv) {
  if (argv[0] !== 'codex') throw new Error(usage);
  const options = { skills: [], codexArgs: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') { options.codexArgs = argv.slice(index + 1); break; }
    if (value === '--workspace') options.workspace = argv[++index];
    else if (value === '--skills') options.skills.push(...(argv[++index] ?? '').split(',').filter(Boolean));
    else if (value === '--config') options.configPath = argv[++index];
    else if (value === '--session') options.sessionId = argv[++index];
    else if (value === '--environment') options.environmentName = argv[++index];
    else if (value === '--runtime') options.runtimeName = argv[++index];
    else if (value === '--image') options.image = argv[++index];
    else if (value === '--offline') options.profile = 'offline';
    else throw new Error(`Unknown isolated-harness option: ${value}\n\n${usage}`);
  }
  if (!options.workspace) throw new Error(usage);
  return options;
}

function delegateToRunner(argv) {
  return new Promise((resolve, reject) => {
    const runnerPath = fileURLToPath(new URL('./harness-runner.mjs', import.meta.url));
    const child = spawn(process.execPath, [runnerPath, ...argv], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

try {
  const argv = process.argv.slice(2);
  if (runnerCommands.has(argv[0])) process.exitCode = await delegateToRunner(argv);
  else {
    const result = await startInteractiveCodex(parse(argv));
    process.exitCode = result.exit.code ?? 1;
  }
} catch (error) {
  console.error(`${error.code ?? 'RUNNER_ERROR'}: ${error.message}`);
  process.exitCode = 1;
}

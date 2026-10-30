// Copied into a private session control mount; requires only Node built-ins.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
const [command, ...args] = process.argv.slice(2);
process.env.PATH = `${directory}/bin:${process.env.PATH}`;
async function update(version = 'latest') {
  if (session.offline) throw new Error('Harness updates are unavailable offline.');
  if (session.release) throw new Error('This session uses a pinned harness version.');
  const id = randomUUID();
  const request = join(directory, `${id}.request.json`);
  await writeFile(`${request}.tmp`, JSON.stringify({ action: 'update', version }));
  await rename(`${request}.tmp`, request);
  process.stderr.write('Checking for a harness update...\n');
  const response = join(directory, `${id}.response.json`);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    let result;
    try { result = JSON.parse(await readFile(response, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (result) {
      await rm(response, { force: true });
      if (!result.ok) throw new Error(result.error);
      process.stdout.write(`${session.command} is ready at ${result.version}. New invocations use this version; the current process can finish normally.\n`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the harness updater.');
}

function isNativeUpdate() {
  if (session.id !== 'codex-cli') return args[0] === 'update' && !args.includes('--help') && !args.includes('-h');
  const takesValue = new Set(['--cd', '-C', '--config', '-c', '--model', '-m', '--profile', '-p', '--sandbox', '-s', '--ask-for-approval', '-a', '--image', '-i', '--add-dir', '--enable', '--disable', '--remote', '--remote-auth-token-env']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return false;
    if (takesValue.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    return args[i] === 'update' && !args.includes('--help') && !args.includes('-h');
  }
  return false;
}

try {
  const npmGlobal = command === 'npm' && args.some(value => ['install', 'i', 'update', 'upgrade', 'add'].includes(value)) && args.some(value => ['-g', '--global'].includes(value));
  const npmTarget = npmGlobal && args.find(value => value === session.package || value.startsWith(`${session.package}@`));
  if (command === 'harness-update') await update(args[0] ?? 'latest');
  else if (npmTarget) await update(npmTarget === session.package ? 'latest' : npmTarget.slice(session.package.length + 1));
  else if (command === session.command && isNativeUpdate()) await update();
  else {
    const selected = session.release ? { release: session.release } : JSON.parse(await readFile(join(session.programRoot, 'current.json'), 'utf8'));
    if (!/^[a-z0-9._-]+$/.test(selected.release)) throw new Error('Invalid harness program release.');
    const executable = command === 'npm' ? '/usr/local/bin/npm' : join(session.programRoot, 'releases', selected.release, 'bin', session.command);
    const child = spawn(executable, args, { stdio: 'inherit', env: process.env });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
  }
} catch (error) { process.stderr.write(`HARNESS_UPDATE_ERROR: ${error.message}\n`); process.exitCode = 1; }

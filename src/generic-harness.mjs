import { mkdir, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { defaultStateRoot } from './run.mjs';
import { planMounts } from './mounts.mjs';
import { resolveEnvironment } from './environments.mjs';
import { resolveHostProxy } from './network.mjs';
import { createHarnessSession } from './harnesses.mjs';
import { startInteractiveCodex } from './interactive.mjs';

export async function runHarness({ id, workspace, environmentName, image = 'codex-cli:local', offline = false, autoUpdate = true, version = 'latest', args = [], stateRoot = defaultStateRoot(), spawnProcess = spawn, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) }) {
  if (id === 'codex-cli') return startInteractiveCodex({ workspace, environmentName, image, profile: offline ? 'offline' : 'contained', autoUpdate, harnessVersion: version, codexArgs: args, stateRoot, spawnProcess, tty });
  const mounts = await planMounts([{ hostPath: workspace, containerPath: '/workspace', mode: 'rw' }], { runnerStateRoot: stateRoot });
  const environment = environmentName ? await resolveEnvironment(environmentName, { stateRoot }) : null;
  const selectedImage = environment?.image ?? image;
  const session = await createHarnessSession({ id, image: selectedImage, stateRoot, offline, autoUpdate, version });
  let createdRuntime = false;
  try {
    const home = join(mounts[0].hostPath, '.contained-harness', 'harnesses', id, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const dockerArgs = ['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--user=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--workdir', '/workspace', '--interactive', '--network', offline ? 'none' : 'bridge', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--env', 'HOME=/run/harness-home', '--mount', `type=bind,src=${home},dst=/run/harness-home`, '--mount', `type=bind,src=${mounts[0].hostPath},dst=/workspace`];
    if (tty) dockerArgs.push('--tty');
    if (!offline) {
      const proxy = await resolveHostProxy();
      for (const [key, value] of Object.entries(proxy.environment)) dockerArgs.push('--env', `${key}=${value}`);
    }
    if (environment?.spec?.workspaceRuntime) {
      try { await mkdir(join(mounts[0].hostPath, 'runtime')); createdRuntime = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      dockerArgs.push('--tmpfs', '/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m', '--env', 'PLAYWRIGHT_BROWSERS_PATH=/workspace/runtime/browsers');
    }
    dockerArgs.push(...session.dockerArgs, selectedImage, ...session.command, ...args);
    const exit = await new Promise((resolve, reject) => {
      const child = spawnProcess('docker', dockerArgs, { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { id, version: session.program.version, exit, state: exit.code === 0 ? 'completed' : 'failed' };
  } finally {
    if (createdRuntime) await rmdir(join(mounts[0].hostPath, 'runtime')).catch(() => {});
    await session.close();
  }
}

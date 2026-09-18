import { RunnerValidationError } from '../errors.mjs';

export function buildCodexContainerPlan({ image, mounts, workingDirectory, sessionCodexHome, profile = 'contained', task, user = '1000:1000', networkEnvironment = {}, trustedCa = false, resumeThreadId, persistentChat = false }) {
  const workspace = mounts.find(mount => mount.containerPath === workingDirectory && mount.mode === 'rw');
  if (!workspace) throw new RunnerValidationError('WORKING_DIRECTORY_NOT_WRITABLE', 'workingDirectory must be the destination of a declared rw mount.');
  if (profile !== 'contained' && profile !== 'offline') throw new RunnerValidationError('ISOLATION_PROFILE_INVALID', `Unsupported profile: ${profile}`);
  const dockerArgs = ['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--user=${user}`, '--workdir', workingDirectory, '--env', 'CODEX_HOME=/run/codex-home', '--env', 'HOME=/run/codex-home', '--mount', `type=bind,src=${sessionCodexHome},dst=/run/codex-home`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m'];
  // Codex needs provider egress to do useful work. `contained` isolates the
  // host filesystem and namespaces while using Docker's ordinary bridge; the
  // explicit `offline` profile is for local-model or no-network harnesses.
  dockerArgs.push('--network', profile === 'offline' ? 'none' : 'bridge');
  if (profile !== 'offline') for (const [key, value] of Object.entries(networkEnvironment)) dockerArgs.push('--env', `${key}=${value}`);
  if (trustedCa) dockerArgs.push('--env', 'SSL_CERT_FILE=/run/codex-home/trusted-ca.pem');
  for (const mount of mounts) dockerArgs.push('--mount', `type=bind,src=${mount.hostPath},dst=${mount.containerPath}${mount.mode === 'ro' ? ',readonly' : ''}`);
  // The session home contains only a runner-written auth projection and the
  // explicitly selected capability config. We deliberately load that config
  // while never mounting the host's CODEX_HOME.
  dockerArgs.push(image, 'codex', 'exec');
  if (resumeThreadId) dockerArgs.push('resume');
  if (!persistentChat) dockerArgs.push('--ephemeral');
  dockerArgs.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
  if (!resumeThreadId) dockerArgs.push('--cd', workingDirectory);
  if (resumeThreadId) dockerArgs.push(resumeThreadId);
  if (task) dockerArgs.push(task);
  return { runtime: 'docker', dockerArgs, environment: { CODEX_HOME: '/run/codex-home', HOME: '/run/codex-home', proxy: profile === 'offline' ? 'disabled' : Object.keys(networkEnvironment).length ? 'host-configured' : 'not-configured' }, mountCount: mounts.length, profile };
}

// This plan deliberately invokes `codex` without a subcommand. It opens the
// real Codex terminal UI; arguments after the contained-harness `--` separator
// are forwarded untouched so new Codex CLI functionality does not require the
// runner to reimplement it.
export function buildCodexInteractivePlan({ image, mounts, workingDirectory, codexHomePath, authProjectionPath, profile = 'contained', user = '1000:1000', networkEnvironment = {}, trustedCa = false, workspaceRuntime = false, runtimePath, codexArgs = [], tty = true }) {
  const workspace = mounts.find(mount => mount.containerPath === workingDirectory && mount.mode === 'rw');
  if (!workspace) throw new RunnerValidationError('WORKING_DIRECTORY_NOT_WRITABLE', 'workingDirectory must be the destination of a declared rw mount.');
  if (profile !== 'contained' && profile !== 'offline') throw new RunnerValidationError('ISOLATION_PROFILE_INVALID', `Unsupported profile: ${profile}`);
  if (!codexHomePath?.startsWith('/')) throw new RunnerValidationError('CODEX_HOME_INVALID', 'Interactive Codex home must be an absolute container path.');
  if (!authProjectionPath) throw new RunnerValidationError('AUTH_PROJECTION_REQUIRED', 'Interactive Codex needs a private auth projection.');
  const dockerArgs = ['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--user=${user}`, '--workdir', workingDirectory, '--env', `CODEX_HOME=${codexHomePath}`, '--env', `HOME=${codexHomePath}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--interactive'];
  if (tty) dockerArgs.push('--tty');
  dockerArgs.push('--network', profile === 'offline' ? 'none' : 'bridge');
  if (profile !== 'offline') for (const [key, value] of Object.entries(networkEnvironment)) dockerArgs.push('--env', `${key}=${value}`);
  if (trustedCa) dockerArgs.push('--env', `SSL_CERT_FILE=${codexHomePath}/trusted-ca.pem`);
  for (const mount of mounts) dockerArgs.push('--mount', `type=bind,src=${mount.hostPath},dst=${mount.containerPath}${mount.mode === 'ro' ? ',readonly' : ''}`);
  if (runtimePath) dockerArgs.push('--mount', `type=bind,src=${runtimePath},dst=/run/managed-runtime,readonly`, '--env', 'ISOLATED_HARNESS_MANAGED_RUNTIME=/run/managed-runtime', '--tmpfs', '/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m');
  else if (workspaceRuntime) dockerArgs.push('--tmpfs', '/workspace/runtime:rw,noexec,nosuid,nodev,mode=1777,size=16m');
  // This file mount hides the empty workspace placeholder. Codex can refresh
  // the projected login for this container, while auth.json is never persisted
  // in the project-owned CODEX_HOME.
  dockerArgs.push('--mount', `type=bind,src=${authProjectionPath},dst=${codexHomePath}/auth.json`);
  dockerArgs.push(image, 'codex', '--cd', workingDirectory, ...codexArgs);
  return { runtime: 'docker', dockerArgs, environment: { CODEX_HOME: codexHomePath, HOME: codexHomePath, proxy: profile === 'offline' ? 'disabled' : Object.keys(networkEnvironment).length ? 'host-configured' : 'not-configured', workspaceRuntime: runtimePath ? 'managed-readonly' : workspaceRuntime ? 'prebuilt' : 'not-mounted' }, mountCount: mounts.length + 1, profile };
}

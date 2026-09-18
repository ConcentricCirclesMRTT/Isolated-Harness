import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import path from 'node:path';
import { RunnerValidationError } from './errors.mjs';

const isSameOrChild = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${sep}`);
const isContainerChild = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}/`);
const forbiddenContainerRoots = ['/proc', '/sys', '/dev', '/run', '/etc', '/root'];

export async function planMounts(mounts, { runnerStateRoot, userHome = homedir() } = {}) {
  // A caller may supply a prospective home path during preflight. It still
  // needs to participate in the deny list even when it has not been created.
  const resolvedHome = await realpath(userHome).catch(() => resolve(userHome));
  const resolvedTemp = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const resolvedState = runnerStateRoot ? await realpath(runnerStateRoot).catch(() => resolve(runnerStateRoot)) : undefined;
  const planned = [];
  for (const [index, mount] of mounts.entries()) {
    let hostPath;
    try { hostPath = await realpath(mount.hostPath); } catch { throw new RunnerValidationError('MOUNT_PATH_MISSING', `Mount ${index} host path does not exist: ${mount.hostPath}`); }
    const metadata = await stat(hostPath);
    if (!metadata.isDirectory()) throw new RunnerValidationError('MOUNT_NOT_DIRECTORY', `Mount ${index} must be a directory: ${hostPath}`);
    if (hostPath === path.parse(hostPath).root || hostPath === resolvedHome || hostPath === resolvedTemp) throw new RunnerValidationError('MOUNT_FORBIDDEN_HOST_PATH', `Mount ${index} may not expose the host root, home directory, or temporary-directory root.`);
    if (resolvedState && (isSameOrChild(hostPath, resolvedState) || isSameOrChild(resolvedState, hostPath))) throw new RunnerValidationError('MOUNT_RUNNER_STATE_FORBIDDEN', `Mount ${index} overlaps runner state.`);
    const containerPath = path.posix.normalize(mount.containerPath);
    if (!containerPath.startsWith('/') || containerPath === '/' || containerPath.includes('/../') || forbiddenContainerRoots.some(root => isContainerChild(containerPath, root))) throw new RunnerValidationError('MOUNT_CONTAINER_PATH_FORBIDDEN', `Mount ${index} has a forbidden container path: ${mount.containerPath}`);
    const mode = mount.mode ?? 'rw';
    if (planned.some(item => isContainerChild(containerPath, item.containerPath) || isContainerChild(item.containerPath, containerPath))) throw new RunnerValidationError('MOUNT_DESTINATION_OVERLAP', `Mount ${index} overlaps an existing container destination.`);
    planned.push({ hostPath, containerPath, mode });
  }
  return planned;
}

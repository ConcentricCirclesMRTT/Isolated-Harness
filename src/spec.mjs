import { RunnerValidationError } from './errors.mjs';
import { normalizeCapabilities } from './capabilities.mjs';

export const RUN_SPEC_VERSION = 'v1';
export function validateRunSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RunnerValidationError('RUN_SPEC_INVALID', 'RunSpec must be an object.');
  const allowed = new Set(['version', 'harness', 'workingDirectory', 'mounts', 'capabilities', 'isolation', 'network', 'chat', 'task']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new RunnerValidationError('RUN_SPEC_UNKNOWN_FIELD', `Unknown RunSpec field: ${key}`);
  if (input.version !== RUN_SPEC_VERSION) throw new RunnerValidationError('RUN_SPEC_VERSION', `RunSpec.version must be ${RUN_SPEC_VERSION}.`);
  if (!input.harness || typeof input.harness !== 'object' || input.harness.id !== 'codex-cli') throw new RunnerValidationError('HARNESS_UNSUPPORTED', 'Only harness.id "codex-cli" is supported in v1.');
  if (typeof input.workingDirectory !== 'string' || !input.workingDirectory) throw new RunnerValidationError('WORKING_DIRECTORY_REQUIRED', 'workingDirectory is required.');
  if (!Array.isArray(input.mounts) || input.mounts.length === 0) throw new RunnerValidationError('MOUNTS_REQUIRED', 'At least one direct directory mount is required.');
  for (const mount of input.mounts) {
    if (!mount || typeof mount !== 'object' || typeof mount.hostPath !== 'string' || typeof mount.containerPath !== 'string') throw new RunnerValidationError('MOUNT_INVALID', 'Every mount needs hostPath and containerPath.');
    if (mount.mode !== undefined && mount.mode !== 'rw' && mount.mode !== 'ro') throw new RunnerValidationError('MOUNT_MODE_INVALID', 'Mount mode must be rw or ro.');
  }
  if (input.capabilities !== undefined) normalizeCapabilities(input.capabilities);
  if (input.task !== undefined && (typeof input.task !== 'string' || !input.task.trim())) throw new RunnerValidationError('TASK_INVALID', 'task must be a non-empty string when present.');
  if (input.chat !== undefined && (!input.chat || typeof input.chat !== 'object' || Array.isArray(input.chat) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(input.chat.id ?? ''))) throw new RunnerValidationError('CHAT_INVALID', 'chat.id must be a safe, non-empty identifier.');
  if (input.isolation?.profile && !['contained', 'offline'].includes(input.isolation.profile)) throw new RunnerValidationError('ISOLATION_PROFILE_INVALID', 'isolation.profile must be contained or offline.');
  if (input.network !== undefined) {
    if (!input.network || typeof input.network !== 'object' || Array.isArray(input.network)) throw new RunnerValidationError('NETWORK_INVALID', 'network must be an object.');
    for (const key of Object.keys(input.network)) if (key !== 'trustedCaFile') throw new RunnerValidationError('NETWORK_UNKNOWN_FIELD', `Unknown network field: ${key}`);
    if (input.network.trustedCaFile !== undefined && (typeof input.network.trustedCaFile !== 'string' || !input.network.trustedCaFile.startsWith('/'))) throw new RunnerValidationError('NETWORK_CA_INVALID', 'network.trustedCaFile must be an absolute PEM file path.');
  }
  return input;
}

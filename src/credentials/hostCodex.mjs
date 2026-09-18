import { access, copyFile, mkdir, stat, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerValidationError } from '../errors.mjs';

export function hostCodexAuthPath({ env = process.env, home = homedir() } = {}) {
  return join(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex'), 'auth.json');
}
export async function inspectHostCodexLogin(options = {}) {
  const authPath = options.authPath ?? hostCodexAuthPath(options);
  try {
    await access(authPath, constants.R_OK);
    if (!(await stat(authPath)).isFile()) return { provider: 'host-codex', status: 'unavailable' };
    return { provider: 'host-codex', status: 'available', authPath };
  } catch { return { provider: 'host-codex', status: 'unavailable' }; }
}
export async function materializeHostCodexLogin({ sessionCodexHome, authPath, options = {} }) {
  const source = authPath ?? hostCodexAuthPath(options);
  const status = await inspectHostCodexLogin({ ...options, authPath: source });
  if (status.status !== 'available') throw new RunnerValidationError('HOST_LOGIN_UNAVAILABLE', 'No usable host Codex login is available. Log in on the host before starting an isolated Codex run.');
  await mkdir(sessionCodexHome, { recursive: true, mode: 0o700 });
  const target = join(sessionCodexHome, 'auth.json');
  await copyFile(source, target);
  await chmod(target, 0o600);
  return { provider: 'host-codex', status: 'available', targetAuthPath: target };
}

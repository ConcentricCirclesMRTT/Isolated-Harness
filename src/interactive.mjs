import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildCodexInteractivePlan } from './adapters/codex.mjs';
import { inspectHostCodexLogin, materializeHostCodexLogin } from './credentials/hostCodex.mjs';
import { RunnerValidationError } from './errors.mjs';
import { planMounts } from './mounts.mjs';
import { readMacOsTrustBundle, resolveHostProxy } from './network.mjs';
import { defaultStateRoot } from './run.mjs';
import { resolveEnvironment } from './environments.mjs';

const skillName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const hostCodexHome = ({ env = process.env, home = homedir() } = {}) => resolve(env.CODEX_HOME ?? join(home, '.codex'));
const userIdentity = () => typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
const waitForExit = child => new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit({ code, signal })); });

export function normalizeInteractiveSkills(values = []) {
  if (!values.length || values.includes('none')) {
    if (values.length > 1) throw new RunnerValidationError('INTERACTIVE_SKILLS_INVALID', 'Use --skills none by itself.');
    return { mode: 'none', paths: [] };
  }
  if (values.includes('inherited')) {
    if (values.length > 1) throw new RunnerValidationError('INTERACTIVE_SKILLS_INVALID', 'Use --skills inherited by itself.');
    return { mode: 'inherited', paths: [] };
  }
  return { mode: 'explicit', paths: values.map(value => resolve(value)) };
}

export function projectCodexHome(workspace, sessionId) {
  return sessionId ? join(workspace, '.contained-harness', 'sessions', sessionId, 'codex') : join(workspace, '.contained-harness', 'codex');
}

async function ensureFile(path, code, description) {
  try { if (!(await stat(path)).isFile()) throw new Error(); }
  catch { throw new RunnerValidationError(code, `${description}: ${path}`); }
}

async function materializeInteractiveSkills(selection, { sessionCodexHome, env = process.env, home = homedir() } = {}) {
  if (selection.mode === 'none') return { mode: 'none', skills: [] };
  const sourceRoot = selection.mode === 'inherited' ? join(hostCodexHome({ env, home }), 'skills') : null;
  if (sourceRoot) {
    try { if (!(await stat(sourceRoot)).isDirectory()) return { mode: 'inherited', skills: [] }; }
    catch { return { mode: 'inherited', skills: [] }; }
    await cp(sourceRoot, join(sessionCodexHome, 'skills'), { recursive: true, dereference: false });
    return { mode: 'inherited', skills: ['*'] };
  }
  const targetRoot = join(sessionCodexHome, 'skills');
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const path of selection.paths) {
    await ensureFile(join(path, 'SKILL.md'), 'INTERACTIVE_SKILL_INVALID', 'A selected Skill directory must contain SKILL.md');
    const name = basename(path);
    if (!skillName.test(name)) throw new RunnerValidationError('INTERACTIVE_SKILL_NAME_INVALID', `Skill directory name is not a valid Skill id: ${name}`);
    if (copied.includes(name)) throw new RunnerValidationError('INTERACTIVE_SKILL_DUPLICATE', `Selected Skill appears more than once: ${name}`);
    await cp(path, join(targetRoot, name), { recursive: true, dereference: false, errorOnExist: true });
    copied.push(name);
  }
  return { mode: 'explicit', skills: copied };
}

async function materializeConfig(configPath, sessionCodexHome) {
  if (!configPath) return undefined;
  const source = resolve(configPath);
  await ensureFile(source, 'INTERACTIVE_CONFIG_INVALID', 'Codex config must be a regular file');
  await copyFile(source, join(sessionCodexHome, 'config.toml'));
  return source;
}

async function refreshInteractiveRegistration({ previous, skills, configPath, sessionCodexHome }) {
  // An existing CODEX_HOME is a resumable chat history, not an immutable
  // environment declaration. Preserve its registration when no new choice is
  // supplied; a deliberate CLI choice replaces only that registration.
  const replaceSkills = skills.length > 0;
  const replaceConfig = Boolean(configPath);
  let registeredSkills = previous?.skills;
  let registeredConfig = previous?.config;
  if (!previous || replaceSkills) {
    if (replaceSkills) await rm(join(sessionCodexHome, 'skills'), { recursive: true, force: true });
    const selection = normalizeInteractiveSkills(skills);
    registeredSkills = await materializeInteractiveSkills(selection, { sessionCodexHome });
  }
  if (!previous || replaceConfig) registeredConfig = await materializeConfig(configPath, sessionCodexHome);
  return { skills: registeredSkills ?? { mode: 'none', skills: [] }, config: registeredConfig ?? null };
}

export async function startInteractiveCodex({ workspace, skills = [], configPath, sessionId, profile = 'contained', image = 'codex-cli:local', environmentName, codexArgs = [], stateRoot = defaultStateRoot(), tty = Boolean(process.stdin.isTTY && process.stdout.isTTY), spawnProcess = spawn } = {}) {
  if (!workspace) throw new RunnerValidationError('INTERACTIVE_WORKSPACE_REQUIRED', '--workspace is required.');
  if (sessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(sessionId)) throw new RunnerValidationError('INTERACTIVE_SESSION_INVALID', '--session must be a safe non-empty identifier.');
  if (environmentName && image !== 'codex-cli:local') throw new RunnerValidationError('INTERACTIVE_ENVIRONMENT_IMAGE_CONFLICT', 'Use either --environment or --image, not both.');
  const mounts = await planMounts([{ hostPath: workspace, containerPath: '/workspace', mode: 'rw' }], { runnerStateRoot: stateRoot });
  const hostWorkspace = mounts[0].hostPath;
  const workspaceCodexHome = projectCodexHome(hostWorkspace, sessionId);
  const containerCodexHome = projectCodexHome('/workspace', sessionId);
  const metadataPath = join(workspaceCodexHome, 'contained-harness.json');
  let previous;
  try { previous = JSON.parse(await readFile(metadataPath, 'utf8')); } catch {}
  const login = await inspectHostCodexLogin();
  if (login.status !== 'available') throw new RunnerValidationError('HOST_LOGIN_UNAVAILABLE', 'Log in to Codex on the host before opening an isolated Codex CLI.');
  const projectionRoot = join(stateRoot, 'credential-projections', randomUUID());
  const privateAuthHome = join(projectionRoot, 'codex-home');
  await mkdir(workspaceCodexHome, { recursive: true, mode: 0o700 });
  // Docker overlays the temporary private auth file here. The empty placeholder
  // means the project never receives a usable host login after the container exits.
  await writeFile(join(workspaceCodexHome, 'auth.json'), '', { mode: 0o600 });
  try {
    await materializeHostCodexLogin({ sessionCodexHome: privateAuthHome, authPath: login.authPath });
    const registration = await refreshInteractiveRegistration({ previous, skills, configPath, sessionCodexHome: workspaceCodexHome });
    const registeredSkills = registration.skills;
    const registeredConfig = registration.config;
    const hostProxy = profile === 'offline' ? { status: 'disabled', environment: {} } : await resolveHostProxy();
    let trustedCa = false;
    if (hostProxy.status === 'configured') {
      const trustBundle = await readMacOsTrustBundle();
      if (trustBundle) { await writeFile(join(workspaceCodexHome, 'trusted-ca.pem'), trustBundle, { mode: 0o600 }); trustedCa = true; }
    }
    const environment = environmentName ? await resolveEnvironment(environmentName, { stateRoot }) : null;
    const selectedImage = environment?.image ?? image;
    const plan = buildCodexInteractivePlan({ image: selectedImage, mounts, workingDirectory: '/workspace', codexHomePath: containerCodexHome, authProjectionPath: join(privateAuthHome, 'auth.json'), profile, user: userIdentity(), networkEnvironment: hostProxy.environment, trustedCa, codexArgs, tty });
    const metadata = { version: 'v1', sessionId: sessionId ?? null, workspace: mounts[0], codexHome: workspaceCodexHome, skills: registeredSkills, config: registeredConfig ?? null, environment: environment ? { name: environment.name, image: environment.image, digest: environment.digest } : null, profile, image: selectedImage, codexArgs, startedAt: new Date().toISOString() };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    const child = spawnProcess('docker', plan.dockerArgs, { stdio: 'inherit' });
    const exit = await waitForExit(child);
    metadata.finishedAt = new Date().toISOString(); metadata.exit = exit;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    return { ...metadata, state: exit.code === 0 ? 'completed' : 'failed', sessionPath: workspaceCodexHome };
  } finally {
    await rm(projectionRoot, { recursive: true, force: true });
  }
}

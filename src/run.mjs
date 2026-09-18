import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateRunSpec } from './spec.mjs';
import { planMounts } from './mounts.mjs';
import { inspectHostCodexLogin, materializeHostCodexLogin } from './credentials/hostCodex.mjs';
import { buildCodexContainerPlan } from './adapters/codex.mjs';
import { RunnerValidationError } from './errors.mjs';
import { materializeCapabilities, resolveCapabilities } from './capabilities.mjs';
import { readMacOsTrustBundle, resolveHostProxy } from './network.mjs';
import { parseCodexJsonLine } from './events.mjs';

export function defaultStateRoot({ env = process.env, home = homedir() } = {}) {
  return env.ISOLATED_HARNESS_STATE_ROOT ?? env.AEGIS_STATE_ROOT ?? env.CHR_STATE_ROOT ?? join(home, '.isolated-harness');
}
const hostUser = () => typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
async function writeReceipt(path, receipt) { await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); }
function waitForExit(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }

export async function startCodexRun(rawSpec, { stateRoot = defaultStateRoot(), onEvent = () => {}, spawnProcess = spawn } = {}) {
  const spec = validateRunSpec(rawSpec);
  if (!spec.task) throw new RunnerValidationError('TASK_REQUIRED', 'A Codex run requires RunSpec.task.');
  const runId = randomUUID();
  const runDirectory = join(stateRoot, 'runs', runId);
  const chatDirectory = spec.chat ? join(stateRoot, 'chats', spec.chat.id) : null;
  const chatStatePath = chatDirectory ? join(chatDirectory, 'chat.json') : null;
  let chatState = null;
  if (chatDirectory) { await mkdir(chatDirectory, { recursive: true, mode: 0o700 }); try { chatState = JSON.parse(await readFile(chatStatePath, 'utf8')); } catch {} }
  const sessionCodexHome = chatDirectory ? join(chatDirectory, 'codex-home') : join(runDirectory, 'codex-home');
  const receiptPath = join(runDirectory, 'receipt.json');
  const stdoutPath = join(runDirectory, 'stdout.log');
  const stderrPath = join(runDirectory, 'stderr.log');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const mounts = await planMounts(spec.mounts, { runnerStateRoot: stateRoot });
  const resolvedCapabilities = await resolveCapabilities(spec.capabilities ?? {});
  const hostProxy = spec.isolation?.profile === 'offline' ? { status: 'disabled', environment: {} } : await resolveHostProxy();
  const login = await inspectHostCodexLogin();
  if (login.status !== 'available') throw new RunnerValidationError('HOST_LOGIN_UNAVAILABLE', 'No usable host Codex login is available. Log in on the host before starting an isolated Codex run.');
  const isNewChat = !chatState;
  await materializeHostCodexLogin({ sessionCodexHome, authPath: login.authPath });
  let trustedCa = false;
  let trustedCaSource = 'system-only';
  if (spec.network?.trustedCaFile) {
    let caStat;
    try { caStat = await stat(spec.network.trustedCaFile); } catch { throw new RunnerValidationError('NETWORK_CA_MISSING', `Trusted CA file does not exist: ${spec.network.trustedCaFile}`); }
    if (!caStat.isFile()) throw new RunnerValidationError('NETWORK_CA_INVALID', 'network.trustedCaFile must name a regular PEM file.');
    await copyFile(spec.network.trustedCaFile, join(sessionCodexHome, 'trusted-ca.pem'));
    trustedCa = true;
    trustedCaSource = 'explicit-file';
  } else if (hostProxy.status === 'configured') {
    const hostTrustBundle = await readMacOsTrustBundle();
    if (hostTrustBundle) {
      await writeFile(join(sessionCodexHome, 'trusted-ca.pem'), hostTrustBundle, { mode: 0o600 });
      trustedCa = true;
      trustedCaSource = 'host-keychain';
    }
  }
  let registeredCapabilities = chatState?.registeredCapabilities;
  try { if (isNewChat || !registeredCapabilities) registeredCapabilities = await materializeCapabilities(resolvedCapabilities, { stateRoot, sessionCodexHome }); }
  catch (error) { await rm(sessionCodexHome, { recursive: true, force: true }); throw error; }
  const plan = buildCodexContainerPlan({ image: spec.harness.image ?? 'codex-cli:local', mounts, workingDirectory: spec.workingDirectory, sessionCodexHome, profile: spec.isolation?.profile ?? 'contained', task: spec.task, user: hostUser(), trustedCa, networkEnvironment: hostProxy.environment, persistentChat: Boolean(spec.chat), resumeThreadId: chatState?.threadId });
  const receipt = { version: 'v1', runId, state: 'starting', startedAt: new Date().toISOString(), harness: { id: spec.harness.id, image: spec.harness.image ?? 'codex-cli:local' }, chat: spec.chat ? { id: spec.chat.id, continued: Boolean(chatState?.threadId) } : null, isolation: { profile: plan.profile, user: hostUser(), network: plan.profile === 'offline' ? 'none' : 'bridge', hostProxy: hostProxy.status, trustedCa: trustedCaSource, session: spec.chat ? 'chat-scoped' : 'ephemeral' }, credential: { provider: 'host-codex', status: 'available' }, mounts, capabilities: { requested: resolvedCapabilities, registered: registeredCapabilities }, logs: { stdoutPath, stderrPath }, exit: null };
  await writeReceipt(receiptPath, receipt);
  onEvent({ type: 'starting', runId, at: receipt.startedAt });
  let child;
  let exitPromise;
  try { child = spawnProcess('docker', plan.dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] }); exitPromise = waitForExit(child); }
  catch (error) { receipt.state = 'failed'; receipt.exit = { code: null, signal: null, reason: String(error) }; receipt.finishedAt = new Date().toISOString(); await writeReceipt(receiptPath, receipt); await rm(sessionCodexHome, { recursive: true, force: true }); throw error; }
  receipt.state = 'running'; await writeReceipt(receiptPath, receipt); onEvent({ type: 'running', runId, at: new Date().toISOString() });
  let startedThreadId = chatState?.threadId;
  const relay = (stream, path, type) => stream.on('data', async chunk => { const text = chunk.toString(); if (type === 'stdout') for (const line of text.trim().split('\n')) { const parsed = parseCodexJsonLine(line); if (parsed?.raw.type === 'thread.started') startedThreadId = parsed.raw.thread_id; if (parsed) onEvent({ type: 'codex_event', runId, at: new Date().toISOString(), ...parsed }); } await appendFile(path, text, { mode: 0o600 }); onEvent({ type, runId, at: new Date().toISOString(), text }); });
  relay(child.stdout, stdoutPath, 'stdout'); relay(child.stderr, stderrPath, 'stderr');
  try {
    const exit = await exitPromise;
    receipt.state = exit.code === 0 ? 'completed' : 'failed';
    receipt.exit = { code: exit.code, signal: exit.signal };
    receipt.finishedAt = new Date().toISOString();
    if (chatDirectory && startedThreadId) await writeFile(chatStatePath, `${JSON.stringify({ version: 'v1', chatId: spec.chat.id, threadId: startedThreadId, registeredCapabilities, createdAt: chatState?.createdAt ?? receipt.startedAt, updatedAt: receipt.finishedAt }, null, 2)}\n`, { mode: 0o600 });
    await writeReceipt(receiptPath, receipt);
    onEvent({ type: receipt.state, runId, at: receipt.finishedAt, exit: receipt.exit });
    return { runId, receiptPath, state: receipt.state, exit: receipt.exit };
  } catch (error) {
    receipt.state = 'failed'; receipt.exit = { code: null, signal: null, reason: String(error) }; receipt.finishedAt = new Date().toISOString(); await writeReceipt(receiptPath, receipt); onEvent({ type: 'failed', runId, at: receipt.finishedAt, error: String(error) }); throw error;
  } finally {
    // Auth is run-scoped. Logs and the redacted receipt stay in runner state,
    // but the session home never becomes a future session's memory.
    if (!chatDirectory && existsSync(sessionCodexHome)) await rm(sessionCodexHome, { recursive: true, force: true });
  }
}

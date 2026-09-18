import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodexRun } from '../src/run.mjs';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'chr-chat-isolation-'));
async function resolveDemoTrustBundle() {
  const configuredTrustBundle = process.env.ISOLATED_HARNESS_DEMO_TRUSTED_CA ?? process.env.AEGIS_DEMO_TRUSTED_CA ?? process.env.CHR_DEMO_TRUSTED_CA;
  if (configuredTrustBundle) return configuredTrustBundle;
  if (process.platform !== 'darwin') return undefined;
  try {
    const sources = ['/Library/Keychains/System.keychain', join(homedir(), 'Library/Keychains/login.keychain-db')];
    const bundles = [];
    for (const source of sources) { try { bundles.push((await execFileAsync('security', ['find-certificate', '-a', '-p', source], { encoding: 'utf8' })).stdout); } catch {} }
    const pem = bundles.join('\n');
    if (!pem.includes('BEGIN CERTIFICATE')) return undefined;
    const path = join(root, 'host-trust.pem'); await writeFile(path, pem, { mode: 0o600 }); return path;
  } catch { return undefined; }
}
const trustedCaFile = await resolveDemoTrustBundle();
const workspace = join(root, 'workspace');
const stateRoot = join(root, 'state');
const token = `chat-only-${randomUUID().slice(0, 8)}`;
const chatA = `demo-a-${randomUUID().slice(0, 8)}`;
const chatB = `demo-b-${randomUUID().slice(0, 8)}`;
await mkdir(workspace);
const base = { version: 'v1', harness: { id: 'codex-cli', image: 'codex-cli:local' }, workingDirectory: '/workspace', mounts: [{ hostPath: workspace, containerPath: '/workspace', mode: 'rw' }], isolation: { profile: 'contained' }, ...(trustedCaFile ? { network: { trustedCaFile } } : {}) };
const transcript = [];
const run = (spec, key) => startCodexRun(spec, { stateRoot, onEvent: event => transcript.push({ key, ...event }) });
const first = await run({ ...base, chat: { id: chatA }, task: `Remember this exact phrase for this chat: ${token}. Reply only: remembered.` }, 'a1');
const continued = await run({ ...base, chat: { id: chatA }, task: 'What exact phrase did I ask you to remember? Reply with only the phrase.' }, 'a2');
const separate = await run({ ...base, chat: { id: chatB }, task: 'You are a different new chat. Do you know a phrase from another chat? Reply only: unknown.' }, 'b1');
const output = key => transcript.filter(event => event.key === key && event.type === 'stdout').map(event => event.text).join('');
const [firstReceipt, continuedReceipt, separateReceipt] = await Promise.all([first, continued, separate].map(result => readFile(result.receiptPath, 'utf8').then(JSON.parse)));
const report = {
  token,
  chatA: { id: chatA, threadId: continuedReceipt.chat && JSON.parse(await readFile(join(stateRoot, 'chats', chatA, 'chat.json'), 'utf8')).threadId, firstRun: first.runId, continuedRun: continued.runId },
  chatB: { id: chatB, threadId: JSON.parse(await readFile(join(stateRoot, 'chats', chatB, 'chat.json'), 'utf8')).threadId, run: separate.runId },
  assertions: {
    sameChatContinues: output('a2').includes(token),
    differentChatUsesDifferentThread: firstReceipt.chat.id === chatA && separateReceipt.chat.id === chatB && continuedReceipt.chat.continued === true,
    tokenDoesNotEnterDifferentChat: !output('b1').includes(token)
  }
};
report.passed = Object.values(report.assertions).every(Boolean);
await writeFile(join(root, 'chat-isolation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`chat A, first message:   remembered a private phrase`);
console.log(`chat A, second message:  ${report.assertions.sameChatContinues ? 'recalled that phrase ✓' : 'did not recall phrase ✗'}`);
console.log(`chat B, first message:   ${report.assertions.tokenDoesNotEnterDifferentChat ? 'does not contain chat A phrase ✓' : 'contains chat A phrase ✗'}`);
console.log(`thread isolation:         ${report.assertions.differentChatUsesDifferentThread ? 'separate private threads ✓' : 'failed ✗'}`);
console.log(`report: ${join(root, 'chat-isolation-report.json')}`);
if (!report.passed) process.exitCode = 1;

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
function stringValue(text, key) {
  const match = text.match(new RegExp(`\\b${key}\\s*:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}
function enabled(text, key) { return stringValue(text, key) === '1'; }
function proxyUrl(host, port) {
  if (!host || !port) return undefined;
  // On Docker Desktop the macOS loopback service is reachable at this stable alias.
  const target = host === '127.0.0.1' || host === 'localhost' ? 'host.docker.internal' : host;
  return `http://${target}:${port}`;
}

export async function resolveHostProxy({ exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec('scutil', ['--proxy'], { encoding: 'utf8' });
    const http = enabled(stdout, 'HTTPEnable') ? proxyUrl(stringValue(stdout, 'HTTPProxy'), stringValue(stdout, 'HTTPPort')) : undefined;
    const https = enabled(stdout, 'HTTPSEnable') ? proxyUrl(stringValue(stdout, 'HTTPSProxy'), stringValue(stdout, 'HTTPSPort')) : undefined;
    if (!http && !https) return { status: 'not-configured', environment: {} };
    const exceptions = [...stdout.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map(match => match[1].trim());
    return { status: 'configured', environment: { ...(http ? { HTTP_PROXY: http, http_proxy: http } : {}), ...(https ? { HTTPS_PROXY: https, https_proxy: https } : {}), ...(exceptions.length ? { NO_PROXY: exceptions.join(','), no_proxy: exceptions.join(',') } : {}) } };
  } catch {
    return { status: 'unavailable', environment: {} };
  }
}

// Docker's Linux certificate bundle does not include certificates installed in
// macOS Keychain. When a host proxy resigns TLS, the runner can project the
// public certificate chain into its private CODEX_HOME for this run. No private
// key or host login material is copied.
export async function readMacOsTrustBundle({ platform = process.platform, home = homedir(), exec = execFileAsync } = {}) {
  if (platform !== 'darwin') return undefined;
  const keychains = ['/Library/Keychains/System.keychain', `${home}/Library/Keychains/login.keychain-db`];
  const certificates = [];
  for (const keychain of keychains) {
    try {
      const { stdout } = await exec('security', ['find-certificate', '-a', '-p', keychain], { encoding: 'utf8' });
      if (stdout.includes('BEGIN CERTIFICATE')) certificates.push(stdout);
    } catch {}
  }
  return certificates.length ? certificates.join('\n') : undefined;
}

import { cp, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { RunnerValidationError } from './errors.mjs';

const kinds = ['skills', 'mcps', 'plugins'];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeCapabilities(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RunnerValidationError('CAPABILITIES_INVALID', 'capabilities must be an object.');
  const allowed = new Set(['inherit', ...kinds]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new RunnerValidationError('CAPABILITIES_UNKNOWN_FIELD', `Unknown capabilities field: ${key}`);
  const inherit = input.inherit ?? {};
  if (!inherit || typeof inherit !== 'object' || Array.isArray(inherit)) throw new RunnerValidationError('CAPABILITY_INHERIT_INVALID', 'capabilities.inherit must be an object.');
  for (const key of Object.keys(inherit)) if (!kinds.includes(key) || typeof inherit[key] !== 'boolean') throw new RunnerValidationError('CAPABILITY_INHERIT_INVALID', 'capabilities.inherit contains an invalid entry.');
  const result = { inherit: Object.fromEntries(kinds.map(key => [key, inherit[key] ?? false])) };
  for (const kind of kinds) {
    const entries = input[kind] ?? [];
    if (!Array.isArray(entries)) throw new RunnerValidationError('CAPABILITY_LIST_INVALID', `capabilities.${kind} must be an array.`);
    const ids = new Set();
    result[kind] = entries.filter(entry => entry.enabled !== false).map(entry => validateEntry(kind, entry, ids));
  }
  if (Object.values(result.inherit).some(Boolean)) throw new RunnerValidationError('CAPABILITY_CATALOG_UNAVAILABLE', 'Host-global capability inheritance is disabled. Select explicit sources until a runner-managed catalog is configured.');
  return result;
}

function validateEntry(kind, entry, ids) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !idPattern.test(entry.id ?? '')) throw new RunnerValidationError('CAPABILITY_INVALID', `Every ${kind} entry needs a safe id.`);
  if (ids.has(entry.id)) throw new RunnerValidationError('CAPABILITY_DUPLICATE', `Duplicate ${kind} capability id: ${entry.id}`);
  ids.add(entry.id);
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new RunnerValidationError('CAPABILITY_INVALID', `capabilities.${kind}.${entry.id}.enabled must be boolean.`);
  if (kind === 'skills' || kind === 'plugins') {
    if (typeof entry.source !== 'string' || !entry.source) throw new RunnerValidationError('CAPABILITY_SOURCE_REQUIRED', `${kind}.${entry.id} needs a source directory.`);
    return { id: entry.id, source: entry.source, version: optionalString(entry.version, 'version') };
  }
  if (!['stdio', 'http'].includes(entry.transport)) throw new RunnerValidationError('MCP_TRANSPORT_INVALID', `MCP ${entry.id} needs transport "stdio" or "http".`);
  if (entry.transport === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command) throw new RunnerValidationError('MCP_COMMAND_REQUIRED', `stdio MCP ${entry.id} needs command.`);
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string'))) throw new RunnerValidationError('MCP_ARGS_INVALID', `stdio MCP ${entry.id}.args must be strings.`);
    if (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env) || Object.entries(entry.env).some(([key, value]) => !envNamePattern.test(key) || typeof value !== 'string'))) throw new RunnerValidationError('MCP_ENV_INVALID', `stdio MCP ${entry.id}.env must map environment names to string values.`);
    return { id: entry.id, transport: 'stdio', command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, version: optionalString(entry.version, 'version') };
  }
  if (typeof entry.url !== 'string' || !/^https:\/\//.test(entry.url)) throw new RunnerValidationError('MCP_URL_INVALID', `http MCP ${entry.id}.url must be HTTPS.`);
  if (entry.bearerTokenEnvVar !== undefined && !envNamePattern.test(entry.bearerTokenEnvVar)) throw new RunnerValidationError('MCP_TOKEN_ENV_INVALID', `MCP ${entry.id}.bearerTokenEnvVar is invalid.`);
  return { id: entry.id, transport: 'http', url: entry.url, bearerTokenEnvVar: entry.bearerTokenEnvVar, version: optionalString(entry.version, 'version') };
}
function optionalString(value, name) { if (value !== undefined && typeof value !== 'string') throw new RunnerValidationError('CAPABILITY_INVALID', `${name} must be a string.`); return value; }

async function assertDirectory(source, kind, id) {
  let resolved;
  try { resolved = await realpath(source); } catch { throw new RunnerValidationError('CAPABILITY_SOURCE_MISSING', `${kind} ${id} source does not exist: ${source}`); }
  if (!(await stat(resolved)).isDirectory()) throw new RunnerValidationError('CAPABILITY_SOURCE_INVALID', `${kind} ${id} source must be a directory.`);
  return resolved;
}
async function digestDirectory(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      const meta = await lstat(path);
      if (meta.isSymbolicLink()) throw new RunnerValidationError('CAPABILITY_SYMLINK_FORBIDDEN', `Capability sources may not contain symlinks: ${rel}`);
      if (meta.isDirectory()) { hash.update(`dir\0${rel}\0`); await visit(path); }
      else if (meta.isFile()) { hash.update(`file\0${rel}\0`); hash.update(await readFile(path)); }
      else throw new RunnerValidationError('CAPABILITY_SOURCE_INVALID', `Unsupported capability entry: ${rel}`);
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export async function resolveCapabilities(input) {
  const capabilities = normalizeCapabilities(input);
  const resolved = { ...capabilities, skills: [], plugins: [], mcps: capabilities.mcps.map(mcp => ({ ...mcp, digest: createHash('sha256').update(JSON.stringify(mcp)).digest('hex') })) };
  for (const kind of ['skills', 'plugins']) for (const item of capabilities[kind]) {
    const source = await assertDirectory(item.source, kind, item.id);
    if (kind === 'skills') {
      try { await stat(join(source, 'SKILL.md')); } catch { throw new RunnerValidationError('SKILL_MANIFEST_MISSING', `Skill ${item.id} must contain SKILL.md.`); }
    }
    resolved[kind].push({ ...item, source, digest: await digestDirectory(source) });
  }
  return resolved;
}

export async function materializeCapabilities(resolved, { stateRoot, sessionCodexHome }) {
  const cacheRoot = join(stateRoot, 'capability-cache', 'sha256');
  const registered = { skills: [], mcps: resolved.mcps.map(({ source, ...mcp }) => mcp), plugins: [] };
  for (const kind of ['skills', 'plugins']) for (const item of resolved[kind]) {
    const cachePath = join(cacheRoot, item.digest);
    try { await stat(cachePath); } catch { await mkdir(cacheRoot, { recursive: true, mode: 0o700 }); await cp(item.source, cachePath, { recursive: true, errorOnExist: true }); }
    const target = kind === 'skills' ? join(sessionCodexHome, 'skills', item.id) : join(sessionCodexHome, 'capabilities', 'plugins', item.id);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await cp(cachePath, target, { recursive: true, errorOnExist: true });
    registered[kind].push({ id: item.id, version: item.version, digest: item.digest, source: kind === 'skills' ? `session://skills/${item.id}` : `session://plugins/${item.id}` });
  }
  if (registered.mcps.length) await writeFile(join(sessionCodexHome, 'config.toml'), renderMcpConfig(registered.mcps), { mode: 0o600 });
  return registered;
}

function toml(value) { return JSON.stringify(value); }
export function renderMcpConfig(mcps) {
  return mcps.map(mcp => {
    const header = `[mcp_servers.${mcp.id}]\n`;
    if (mcp.transport === 'http') return `${header}url = ${toml(mcp.url)}\n${mcp.bearerTokenEnvVar ? `bearer_token_env_var = ${toml(mcp.bearerTokenEnvVar)}\n` : ''}`;
    const base = `${header}command = ${toml(mcp.command)}\nargs = [${mcp.args.map(toml).join(', ')}]\n`;
    const env = Object.entries(mcp.env).map(([key, value]) => `${key} = ${toml(value)}`).join('\n');
    return `${base}${env ? `\n[mcp_servers.${mcp.id}.env]\n${env}\n` : ''}`;
  }).join('\n');
}

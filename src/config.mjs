import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { copilotHome, parseDuration } from './monitor.mjs';
import { record } from './public/schema.mjs';

export const MAX_CONFIG_BYTES = 1 << 20;
export const MAX_TIMER_MS = 2 ** 31 - 1;
export const RUNTIME_DEFAULTS = { sinceMs: 864e5, idleExitMs: 0, remotePauseMs: 600_000 };
const HOST = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,127}$/;
const PATH_KEYS = ['node', 'script', 'copilotHome'];
const RUNTIME_KEYS = ['since', 'idleExitMinutes', 'pauseRemotesMinutes'];
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (body) => createHash('sha256').update(body).digest('hex');
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024 && !/[\x00-\x1f\x7f]/.test(s);

export function minutesToMs(minutes, maximum = Infinity) {
  if (typeof minutes !== 'number' || minutes < 0 || !Number.isFinite(minutes * 60_000) || minutes > maximum / 60_000) return null;
  // The largest allowed minute value can round slightly past the timer limit when multiplied.
  return Math.min(minutes * 60_000, maximum);
}

export function validateRemote(remote, where = 'settings') {
  if (!record(remote) || typeof remote.host !== 'string' || !HOST.test(remote.host)
    || Object.keys(remote).some((key) => !['host', ...PATH_KEYS].includes(key))
    || PATH_KEYS.some((key) => remote[key] !== undefined && !text(remote[key]))) {
    throw problem(`Invalid or duplicate remote in ${where}; use an SSH Host name and optional node, script and copilotHome paths.`);
  }
  return {
    host: remote.host, node: remote.node ?? 'node',
    ...(remote.script ? { script: remote.script } : {}),
    ...(remote.copilotHome ? { copilotHome: remote.copilotHome } : {}),
  };
}

export function validateConfig(value, where = 'settings') {
  if (!record(value) || ![1, 2].includes(value.version) || !Array.isArray(value.remotes) || value.remotes.length > 32
    || Object.keys(value).some((key) => !['version', 'remotes', ...(value.version === 2 ? RUNTIME_KEYS : [])].includes(key))) {
    throw problem(`Expected version 1 or 2 and up to 32 remotes in ${where}.`);
  }
  if (value.since !== undefined && (typeof value.since !== 'string' || value.since.length > 128 || parseDuration(value.since) === null)) {
    throw problem(`Invalid session history in ${where}; use a duration such as 24h or 7d.`);
  }
  for (const key of ['idleExitMinutes', 'pauseRemotesMinutes']) {
    const minutes = value[key];
    if (minutes !== undefined && minutesToMs(minutes, key === 'pauseRemotesMinutes' ? MAX_TIMER_MS : Infinity) === null) {
      throw problem(`Invalid ${key} in ${where}; use nonnegative minutes${key === 'pauseRemotesMinutes' ? ` up to ${MAX_TIMER_MS / 60_000}` : ''} (0 means never).`);
    }
  }
  const seen = new Set();
  const remotes = value.remotes.map((value, index) => {
    const remote = validateRemote(value, `${where}, remote ${index + 1}`);
    if (seen.has(remote.host)) throw problem(`Invalid or duplicate remote in ${where}: ${remote.host}.`);
    seen.add(remote.host);
    return remote;
  });
  return {
    version: 2,
    ...(value.since !== undefined ? { since: value.since.trim() } : {}),
    ...(value.idleExitMinutes !== undefined ? { idleExitMinutes: value.idleExitMinutes } : {}),
    ...(value.pauseRemotesMinutes !== undefined ? { pauseRemotesMinutes: value.pauseRemotesMinutes } : {}),
    remotes,
  };
}

export function resolveSettings(config, defaults = RUNTIME_DEFAULTS) {
  return {
    sinceMs: config.since === undefined ? defaults.sinceMs : parseDuration(config.since),
    idleExitMs: config.idleExitMinutes === undefined ? defaults.idleExitMs : minutesToMs(config.idleExitMinutes),
    remotePauseMs: config.pauseRemotesMinutes === undefined ? defaults.remotePauseMs : minutesToMs(config.pauseRemotesMinutes, MAX_TIMER_MS),
  };
}

export async function readConfig(home = copilotHome()) {
  const path = join(home, 'copilot-viz.json');
  let entry;
  try {
    entry = await lstat(path);
  } catch (e) {
    if (e.code === 'ENOENT') return { path, revision: null, config: { version: 2, remotes: [] }, readOnly: false };
    throw new Error(`Cannot read ${path}: ${e.message}`);
  }
  let body;
  let file;
  try {
    file = entry.isSymbolicLink() ? await stat(path) : entry;
    if (!file.isFile()) throw new Error('not a regular file');
    if (file.size > MAX_CONFIG_BYTES) throw new Error('configuration exceeds 1 MiB');
    body = await readFile(path);
    if (body.length > MAX_CONFIG_BYTES) throw new Error('configuration exceeds 1 MiB');
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${e.message}`);
  }
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw problem(`Invalid JSON in ${path}.`);
  }
  return { path, revision: digest(body), config: validateConfig(value, path), readOnly: entry.isSymbolicLink() || file.nlink > 1 };
}

// The caller serializes saves. The revision also detects edits made since a page loaded.
export async function writeConfig(home, value, revision, { signal } = {}) {
  const config = validateConfig(value);
  const path = join(home, 'copilot-viz.json');
  const check = async () => {
    signal?.throwIfAborted();
    const current = await readConfig(home);
    if (current.readOnly) throw problem(`Cannot replace linked configuration ${path}; edit it manually.`, 409);
    if (current.revision !== revision) throw problem('Settings changed on disk or in another page. Reload saved settings before saving.', 409);
  };
  await check();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `.copilot-viz-${randomBytes(12).toString('hex')}.tmp`);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  let created = false;
  try {
    signal?.throwIfAborted();
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    await check();
    signal?.throwIfAborted();
    await rename(temporary, path);
    created = false;
    return { path, revision: digest(body), config, readOnly: false };
  } finally {
    if (created) {
      await unlink(temporary).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    }
  }
}

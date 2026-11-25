import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOOT, INSTALL, MISSING_EXIT, MISSING_MARK, UNSUPPORTED_EXIT } from './deploy.mjs';
import { copilotHome } from './monitor.mjs';
import { encodeMessage, HEARTBEAT_MS, PROTOCOL, readMessages, unavailable } from './wire.mjs';

const HOST = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,127}$/;
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024 && !/[\x00-\x1f\x7f]/.test(s);

export async function loadRemotes(home = copilotHome()) {
  const path = join(home, 'copilot-viz.json');
  let body;
  try {
    body = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${path}: ${e.message}`);
  }
  let config;
  try {
    config = JSON.parse(body);
  } catch {
    throw new Error(`Invalid JSON in ${path}.`);
  }
  if (!config || config.version !== 1 || !Array.isArray(config.remotes) || config.remotes.length > 32
    || Object.keys(config).some((k) => !['version', 'remotes'].includes(k))) throw new Error(`Expected version 1 and up to 32 remotes in ${path}.`);
  const seen = new Set();
  return config.remotes.map((r) => {
    if (!r || typeof r !== 'object' || typeof r.host !== 'string' || !HOST.test(r.host) || seen.has(r.host)
      || Object.keys(r).some((k) => !['host', 'node', 'script', 'copilotHome'].includes(k))
      || ['node', 'script', 'copilotHome'].some((k) => r[k] !== undefined && !text(r[k]))) {
      throw new Error(`Invalid or duplicate remote in ${path}; use an SSH Host name and optional node, script and copilotHome paths.`);
    }
    seen.add(r.host);
    return { host: r.host, node: r.node ?? 'node', ...(r.script ? { script: r.script } : {}), ...(r.copilotHome ? { copilotHome: r.copilotHome } : {}) };
  });
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
// Without a script, Node runs the bundle that copilot-viz installed in the cache of the host.
const bootArgs = (config, bundle, code) => [config.node, '--input-type=commonjs', '-e', code, '--', bundle.id, bundle.names.join(',')];

export function sshArgs(config, sinceMs, bundle) {
  const args = config.script ? [config.node, '--', config.script] : bootArgs(config, bundle, BOOT);
  args.push('--since', String(sinceMs));
  if (config.copilotHome) args.push('--home', config.copilotHome);
  return sshCommand(config, args);
}

export const installArgs = (config, bundle) => sshCommand(config, bootArgs(config, bundle, INSTALL));

function sshCommand(config, args) {
  // Paths are absolute or relative to HOME. Neither paths nor aliases are evaluated as shell text.
  const command = `cd "$HOME" && exec ${args.map(quote).join(' ')}`;
  return [
    '-T', '-x', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    // ControlMaster=no keeps a ControlPersist master from outliving a pause or a stop.
    '-o', 'RemoteCommand=none', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '--', config.host, `sh -c ${quote(command)}`,
  ];
}

export function createRemote(config, {
  sinceMs, bundle, onMessage, onState, spawnProcess = spawn, retryMs = 1000, timeoutMs = 40_000, installTimeoutMs = 60_000,
} = {}) {
  if (!config.script && !bundle) throw new Error(`${config.host}: a remote without a script needs the worker bundle.`);
  let current = null;
  let stopped = false;
  let paused = false;
  // A failure that a retry cannot fix, such as an incompatible worker, outlasts a pause too.
  let terminal = false;
  let retry = null;
  let attempts = 0;
  let sequence = 0;
  const children = new Set();

  // Starts SSH and tracks the process until it exits, so that stop can wait for it.
  function launch(args) {
    const child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let resolveExit;
    const tracked = { child, exited: new Promise((resolve) => { resolveExit = resolve; }) };
    children.add(tracked);
    let closed = false;
    let escalation;
    child.once('close', () => {
      closed = true;
      clearTimeout(escalation);
      children.delete(tracked);
      resolveExit();
    });
    const terminate = () => {
      if (closed) return;
      child.stdin.destroy();
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    return { child, terminate };
  }

  function afterFailure(e) {
    if (stopped) return;
    if (paused) {
      onState('paused', null, null);
      return;
    }
    if (e.permanent) terminal = true;
    const delay = Math.min(30_000, retryMs * 2 ** Math.min(attempts++, 5));
    onState('offline', e.message, e.permanent ? null : Date.now() + delay);
    if (!e.permanent) retry = setTimeout(connect, delay);
  }

  // Each attempt installs the bundle at most once, when the boot script reports it missing.
  function connect(installed = false) {
    if (stopped || paused) return;
    onState('connecting', null, null);
    const { child, terminate } = launch(sshArgs(config, sinceMs, bundle));
    const a = { child, hello: false, baseline: false, pending: new Map(), stderr: '', heard: Date.now(), dead: false };
    current = a;
    const fail = (e) => {
      if (a.dead) return;
      a.dead = true;
      clearInterval(a.timer);
      a.unlisten?.();
      for (const p of a.pending.values()) {
        clearTimeout(p.timer);
        p.reject(unavailable(e.message));
      }
      a.pending.clear();
      terminate();
      if (e.install && !stopped && !paused) install();
      else afterFailure(e);
    };
    a.fail = fail;
    child.stderr.on('data', (chunk) => { a.stderr = (a.stderr + chunk.toString()).slice(-4096); });
    // A write fails when SSH has exited; close then reports the exit code and stderr.
    child.stdin.on('error', () => {});
    child.on('error', fail);
    child.once('close', (code, signal) => {
      if (a.dead) return;
      const error = new Error(a.stderr.trim() || `SSH closed (${signal ?? code}).`);
      // Only the boot script exits with these codes, and only before the worker says hello.
      const boot = !config.script && !a.hello;
      if (boot && code === MISSING_EXIT && a.stderr.includes(MISSING_MARK) && !installed) error.install = true;
      if (boot && code === UNSUPPORTED_EXIT) error.permanent = true;
      fail(error);
    });
    a.unlisten = readMessages(child.stdout, (msg) => {
      a.heard = Date.now();
      if (!a.hello) {
        if (msg.type !== 'hello' || msg.protocol !== PROTOCOL) {
          const message = config.script
            ? `The worker at ${config.script} is incompatible; update it to match this copilot-viz.`
            : 'The remote worker is incompatible with this copilot-viz.';
          throw Object.assign(new Error(message), { permanent: true });
        }
        a.hello = true;
        a.loadingAt = Date.now();
        onState('loading', null, null);
        return;
      }
      if (msg.type === 'error') throw Object.assign(new Error(String(msg.error)), { permanent: Boolean(msg.permanent) });
      if (msg.type === 'reply') {
        const p = a.pending.get(msg.request);
        if (!p) return;
        clearTimeout(p.timer);
        a.pending.delete(msg.request);
        if (msg.error) p.reject(Object.assign(new Error(String(msg.error)), { status: msg.status === 409 ? 409 : 503 }));
        else p.resolve(msg.data ?? null);
        return;
      }
      if (!Number.isFinite(msg.now)) throw new Error('Worker message has no clock.');
      if (msg.type === 'heartbeat') {
        onMessage(msg);
        return;
      }
      if (!['snapshot', 'delta', 'status'].includes(msg.type)) throw new Error('Unexpected worker message.');
      if (!a.baseline && msg.type !== 'snapshot') throw new Error('Worker sent changes without a snapshot.');
      if (msg.type === 'snapshot' && msg.ready !== true) throw new Error('Worker snapshot is incomplete.');
      onMessage(msg);
      if (msg.type === 'snapshot') {
        a.baseline = true;
        attempts = 0;
      }
    }, fail);
    a.timer = setInterval(() => {
      const now = Date.now();
      if ((!a.hello && now - a.heard > Math.min(timeoutMs, 15_000)) || now - a.heard > timeoutMs
        || (a.hello && !a.baseline && now - a.loadingAt > 120_000)) {
        return fail(new Error('SSH worker timed out.'));
      }
      if (child.stdin.writableLength > 65536) return fail(new Error('SSH worker is not reading requests.'));
      child.stdin.write(encodeMessage({ type: 'ping' }));
    }, Math.min(HEARTBEAT_MS, timeoutMs / 2));
  }

  function install() {
    const { child, terminate } = launch(installArgs(config, bundle));
    const b = { dead: false, stderr: '' };
    current = b;
    b.fail = (e) => {
      if (b.dead) return;
      b.dead = true;
      clearTimeout(b.timer);
      terminate();
      afterFailure(e);
    };
    b.timer = setTimeout(() => b.fail(new Error('Installing the worker timed out.')), installTimeoutMs);
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { b.stderr = (b.stderr + chunk.toString()).slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('error', b.fail);
    child.once('close', (code, signal) => {
      if (b.dead) return;
      if (code !== 0) {
        const error = new Error(b.stderr.trim() || `Installing the worker failed (${signal ?? code}).`);
        return b.fail(Object.assign(error, { permanent: code === UNSUPPORTED_EXIT }));
      }
      b.dead = true;
      clearTimeout(b.timer);
      connect(true);
    });
    child.stdin.end(bundle.payload);
  }

  return {
    start: () => connect(),
    call(sid, id, epoch) {
      const a = current;
      if (!a || a.dead || !a.baseline) return Promise.reject(unavailable('This host is not connected.'));
      if (a.pending.size >= 32) return Promise.reject(unavailable('Too many pending remote detail requests.'));
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          a.pending.delete(request);
          reject(unavailable('Remote call details timed out.'));
        }, 10_000);
        a.pending.set(request, { resolve, reject, timer });
        a.child.stdin.write(encodeMessage({ type: 'call', request, sid, id, epoch }));
      });
    },
    // Closes SSH without retrying, until resume. The old child may still be exiting when resume
    // starts the next one; its attempt is already dead, so it reports nothing more.
    pause() {
      if (stopped || paused || terminal) return;
      paused = true;
      clearTimeout(retry);
      if (current && !current.dead) current.fail(new Error('Disconnected while no page was in view.'));
      else onState('paused', null, null);
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      attempts = 0;
      connect();
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      current?.fail(new Error('The local server stopped.'));
      await Promise.all([...children].map((c) => c.exited));
    },
  };
}

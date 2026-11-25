import { spawn } from 'node:child_process';
import { readConfig, validateRemote } from './config.mjs';
import { BOOT, INSTALL, MISSING_EXIT, MISSING_MARK, UNSUPPORTED_EXIT } from './deploy.mjs';
import { record } from './public/schema.mjs';
import { encodeMessage, HEARTBEAT_MS, PROTOCOL, readMessages, unavailable } from './wire.mjs';

export async function loadRemotes(home) {
  return (await readConfig(home)).config.remotes;
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

// Like the deployment scripts, this passes through a fish login shell: no quote or backslash.
const PROBE = `
var fs = require("fs"), os = require("os"), path = require("path");
var home = process.argv[1] || process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
var result = { nodeVersion: process.versions.node, nodePath: process.execPath, copilotHome: path.resolve(home), sessions: false };
try {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or later is required.");
  var dir = path.join(home, "session-state");
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error(dir + " is not a directory.");
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    result.sessions = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
}
process.stdout.write(JSON.stringify(result));
`;

export function checkArgs(config) {
  return [
    '-o', 'UpdateHostKeys=no', '-o', 'CheckHostIP=no', '-o', 'ControlPath=none',
    ...sshCommand(config, [config.node, '--input-type=commonjs', '-e', PROBE, '--', config.copilotHome ?? '']),
  ];
}

export async function checkRemote(value, { spawnProcess = spawn, signal, timeoutMs = 15_000, killMs = 1000 } = {}) {
  const config = validateRemote(value);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnProcess('ssh', checkArgs(config), { stdio: ['ignore', 'pipe', 'pipe'] });
    const failure = (message, status = 502) => Object.assign(new Error(message), { status });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let error;
    let closed = false;
    let escalation;
    const terminate = (reason) => {
      if (closed || error) return;
      error = reason;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), killMs);
    };
    const abort = () => terminate(signal.reason);
    const timer = setTimeout(() => terminate(failure('SSH check timed out. Check the host name, network, and SSH configuration.', 504)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16384) terminate(failure('SSH check returned too much output. Check non-interactive shell startup output.'));
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.stdout.on('error', (e) => terminate(failure(`Cannot read the SSH check: ${e.message}`)));
    child.stderr.on('error', (e) => terminate(failure(`Cannot read SSH errors: ${e.message}`)));
    child.on('error', (e) => terminate(failure(`Cannot run SSH: ${e.message}`)));
    child.once('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(failure(code === 0
          ? 'Unexpected output from the SSH check. Check non-interactive shell startup output.'
          : `SSH or Node.js check failed: ${stderr.trim() || exitSignal || code}. Verify batch SSH access and the Node.js executable path.`));
      }
      if (record(result) && typeof result.error === 'string') return reject(failure(result.error, 422));
      if (code !== 0 || !record(result) || typeof result.nodeVersion !== 'string'
        || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.nodeVersion)
        || typeof result.nodePath !== 'string' || typeof result.copilotHome !== 'string' || typeof result.sessions !== 'boolean') {
        return reject(failure('The SSH check did not return a valid Node.js result.'));
      }
      if (Number(result.nodeVersion.split('.')[0]) < 22) return reject(failure('Node.js 22 or later is required.', 422));
      return resolve({
        nodeVersion: result.nodeVersion, nodePath: result.nodePath, copilotHome: result.copilotHome, sessions: result.sessions,
      });
    });
  });
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

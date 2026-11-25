import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, chmod, chown, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { BOOT, INSTALL, MISSING_MARK, REMOTE_DIR, WORKER_FILES, workerBundle } from '../src/deploy.mjs';
import { createRemote } from '../src/remote.mjs';
import { HERE, SERVER_FILES } from '../src/runtime.mjs';

const bundle = await workerBundle();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what) {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(10);
  }
}

// A host whose login shell runs the SSH command line in a disposable HOME with a quote in its path.
async function fakeHost(t, shell = 'sh') {
  const root = await mkdtemp(join(tmpdir(), 'copilot-viz-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home ' x");
  const copilotHome = join(root, 'copilot');
  const dir = join(copilotHome, 'session-state', 'same');
  await mkdir(home);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'session.start', data: {}, timestamp: new Date().toISOString() })}\n`);
  const host = { home, cache: join(home, REMOTE_DIR), commands: [] };
  host.installs = () => host.commands.filter((c) => c.includes('mkdtempSync')).length;
  host.connect = (t2 = t) => {
    const states = [];
    let snapshot = null;
    const remote = createRemote({ host: 'dev', node: process.execPath, copilotHome }, {
      sinceMs: 864e5, bundle, retryMs: 20,
      onMessage: (m) => { if (m.type === 'snapshot') snapshot = m; },
      onState: (...s) => states.push(s),
      spawnProcess: (cmd, args, options) => {
        host.commands.push(args.at(-1));
        return spawn(shell, ['-c', args.at(-1)], { ...options, env: { ...process.env, HOME: home } });
      },
    });
    t2.after(() => remote.stop());
    remote.start();
    return { remote, states, snapshot: () => snapshot, last: () => states.at(-1) };
  };
  return host;
}

const ready = (c) => waitFor(() => c.snapshot()?.sessions.length === 1, 'the snapshot');

test('a host without a script gets the worker installed once, reused, and replaced when damaged', { timeout: 20_000 }, async (t) => {
  const host = await fakeHost(t);
  const first = host.connect();
  await ready(first);
  assert.equal(host.installs(), 1);
  const dir = join(host.cache, bundle.id.slice(0, 16));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'model.mjs'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8'), /agenttop/);
  await first.remote.stop();

  await ready(host.connect());
  assert.equal(host.installs(), 1);

  await appendFile(join(dir, 'model.mjs'), '\n');
  await ready(host.connect());
  assert.equal(host.installs(), 2);
  assert.deepEqual(await readdir(host.cache), [bundle.id.slice(0, 16)]);
});

test('concurrent first connections install one copy and all start', { timeout: 20_000 }, async (t) => {
  const host = await fakeHost(t);
  const connections = [host.connect(), host.connect(), host.connect()];
  await Promise.all(connections.map(ready));
  assert.deepEqual(await readdir(host.cache), [bundle.id.slice(0, 16)]);
});

test('a cache path that another user could change is refused for good', { timeout: 20_000 }, async (t) => {
  const refused = async (host, what) => {
    const c = host.connect();
    await waitFor(() => c.last()?.[0] === 'offline', what);
    assert.match(c.last()[1], /refusing to use .*no other user can write/);
    assert.equal(c.last()[2], null);
    await c.remote.stop();
  };
  const cache = (host) => join(host.home, '.cache');

  const open = await fakeHost(t);
  await mkdir(cache(open), { mode: 0o700 });
  await chmod(cache(open), 0o777);
  await refused(open, 'a world-writable ~/.cache');
  assert.deepEqual(await readdir(cache(open)), []);

  const shared = await fakeHost(t);
  await mkdir(dirname(shared.cache), { recursive: true, mode: 0o700 });
  await chmod(dirname(shared.cache), 0o777);
  await refused(shared, 'a writable cache');
  assert.deepEqual(await readdir(dirname(shared.cache)), []);
  // The installer checks the path again, as it may change after the boot script looked.
  const install = spawnSync(process.execPath, ['--input-type=commonjs', '-e', INSTALL, '--', bundle.id, bundle.names.join(',')],
    { cwd: shared.home, input: bundle.payload });
  assert.equal(install.status, 78);
  assert.deepEqual(await readdir(shared.cache), []);

  const linked = await fakeHost(t);
  await mkdir(join(linked.home, 'elsewhere'), { mode: 0o700 });
  await mkdir(cache(linked), { mode: 0o700 });
  await symlink(join(linked.home, 'elsewhere'), dirname(linked.cache));
  await refused(linked, 'a symlink in the cache');

  // The own group of the user may write to ~/.cache, but not below it.
  const group = await fakeHost(t);
  await mkdir(cache(group), { mode: 0o700 });
  await chown(cache(group), process.getuid(), process.getgid());
  await chmod(cache(group), 0o770);
  await ready(group.connect());
  await chmod(join(group.cache, bundle.id.slice(0, 16)), 0o770);
  await refused(group, 'a writable copy');
});

test('a failed installation is reported and retried', { timeout: 20_000 }, async (t) => {
  const host = await fakeHost(t);
  await mkdir(host.cache, { recursive: true, mode: 0o700 });
  await chmod(host.cache, 0o500);
  const c = host.connect();
  await waitFor(() => c.last()?.[0] === 'offline', 'the failure');
  assert.match(c.last()[1], /cannot install the worker/);
  assert.notEqual(c.last()[2], null);
  await chmod(host.cache, 0o700);
  await ready(c);
});

test('an installer that exits before reading the upload reports its own error', { timeout: 20_000 }, async (t) => {
  const states = [];
  const remote = createRemote({ host: 'dev', node: 'node' }, {
    sinceMs: 0, bundle: { ...bundle, payload: 'x'.repeat(8 << 20) }, retryMs: 20, onMessage() {},
    onState: (...s) => states.push(s),
    spawnProcess: (cmd, args, options) => spawn('sh', ['-c', args.at(-1).includes('mkdtempSync')
      ? 'echo "copilot-viz: Node.js 22 or later is required." >&2; exit 78'
      : `echo "${MISSING_MARK}" >&2; exit 75`], options),
  });
  t.after(() => remote.stop());
  remote.start();
  await waitFor(() => states.at(-1)?.[0] === 'offline', 'the failure');
  assert.match(states.at(-1)[1], /Node\.js 22 or later/);
  assert.equal(states.at(-1)[2], null);
});

test('fish as the login shell passes the boot and install scripts unchanged', {
  timeout: 20_000, skip: spawnSync('fish', ['--version']).error ? 'fish is not installed' : false,
}, async (t) => {
  const host = await fakeHost(t, 'fish');
  await ready(host.connect());
  assert.equal(host.installs(), 1);
});

test('the scripts hold no character that a login shell reads inside single quotes', () => {
  for (const code of [BOOT, INSTALL]) assert.doesNotMatch(code, /['\\]/);
});

// Static imports and import('./x') calls, as paths relative to src/.
async function closure(entries) {
  const seen = new Set();
  const visit = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(join(HERE, file), 'utf8');
    for (const m of text.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
      await visit(relative(HERE, resolve(HERE, dirname(file), m[1])));
    }
  };
  for (const e of entries) await visit(e);
  return [...seen].sort();
}

test('the worker bundle and the code version cover every module they load', async () => {
  assert.deepEqual(await closure(['worker.mjs']), [...WORKER_FILES].sort());
  assert.deepEqual(await closure(['cli.mjs', 'server.mjs', 'worker.mjs']), [...SERVER_FILES].sort());
});

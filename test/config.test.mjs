import assert from 'node:assert/strict';
import fs, { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_TIMER_MS, readConfig, resolveSettings, validateConfig, writeConfig } from '../src/config.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'copilot-viz-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function mockFs(t, name, implementation) {
  t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('legacy settings retain optional defaults and literal paths when saved privately as version 2', async (t) => {
  const home = await temporary(t);
  const path = join(home, 'copilot-viz.json');
  const legacy = { version: 1, remotes: [{ host: 'lab', node: "bin/node ' x", copilotHome: 'custom home', script: 'worker.mjs' }] };
  await writeFile(path, JSON.stringify(legacy));
  const before = await readConfig(home);
  const saved = await writeConfig(home, before.config, before.revision);
  assert.deepEqual(saved.config, { ...legacy, version: 2 });
  assert.deepEqual((await readConfig(home)).config, saved.config);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(home), ['copilot-viz.json']);
  assert.notEqual(saved.revision, before.revision);
});

test('first save creates a missing Copilot home and validates runtime bounds without changing defaults', async (t) => {
  const home = join(await temporary(t), 'new-home');
  const before = await readConfig(home);
  const config = { version: 2, since: '1.5h', idleExitMinutes: 0, pauseRemotesMinutes: MAX_TIMER_MS / 60_000, remotes: [] };
  const saved = await writeConfig(home, config, before.revision);
  assert.deepEqual((await readConfig(home)).config, config);
  assert.equal(resolveSettings(saved.config).remotePauseMs, MAX_TIMER_MS);
  assert.equal((await readConfig(home)).revision, saved.revision);
  const remotes = Array.from({ length: 32 }, (_, i) => ({ host: `lab-${i}` }));
  assert.equal(validateConfig({ version: 2, remotes }).remotes.length, 32);
  for (const invalid of [
    { ...config, since: '' }, { ...config, since: '9'.repeat(128) + 'h' },
    { ...config, idleExitMinutes: null }, { ...config, idleExitMinutes: -1 },
    { ...config, pauseRemotesMinutes: Infinity }, { ...config, pauseRemotesMinutes: (MAX_TIMER_MS + 1) / 60_000 },
    { ...config, remotes: [...remotes, { host: 'extra' }] },
    { ...config, remotes: [{ host: 'lab' }, { host: 'lab' }] },
    { ...config, arbitrary: true }, { ...config, version: 1 },
  ]) {
    await assert.rejects(writeConfig(home, invalid, saved.revision), { status: 400 });
    assert.equal((await readConfig(home)).revision, saved.revision);
  }
});

test('stale, malformed, and linked settings are never overwritten', async (t) => {
  const home = await temporary(t);
  const path = join(home, 'copilot-viz.json');
  const config = { version: 2, remotes: [] };
  const saved = await writeConfig(home, config, null);
  const external = JSON.stringify({ ...config, since: '7d' });
  await writeFile(path, external);
  await assert.rejects(writeConfig(home, config, saved.revision), { status: 409 });
  assert.equal(await readFile(path, 'utf8'), external);
  await writeFile(path, '{invalid');
  await assert.rejects(writeConfig(home, config, saved.revision), /Invalid JSON/);
  assert.equal(await readFile(path, 'utf8'), '{invalid');
  await rm(path);
  const target = join(home, 'managed.json');
  await writeFile(target, external);
  await symlink(target, path);
  const linked = await readConfig(home);
  assert.equal(linked.readOnly, true);
  await assert.rejects(writeConfig(home, config, linked.revision), /linked configuration/);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), external);
});

test('an edit made while a temporary file is written wins over the stale save', async (t) => {
  const home = await temporary(t);
  const config = { version: 2, remotes: [] };
  const saved = await writeConfig(home, config, null);
  const external = JSON.stringify({ ...config, since: '3d' });
  const open = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const file = await open(path, ...args);
    if (path.startsWith(join(home, '.copilot-viz-'))) {
      const sync = file.sync.bind(file);
      t.mock.method(file, 'sync', async () => {
        await writeFile(saved.path, external);
        await sync();
      });
    }
    return file;
  });
  await assert.rejects(writeConfig(home, { ...config, since: '7d' }, saved.revision), { status: 409 });
  assert.equal(await readFile(saved.path, 'utf8'), external);
  assert.deepEqual(await readdir(home), ['copilot-viz.json']);
});

test('a failed rename or an aborted save preserves the file and removes the temporary copy', async (t) => {
  const home = await temporary(t);
  const config = { version: 2, remotes: [] };
  const saved = await writeConfig(home, config, null);
  const original = await readFile(saved.path, 'utf8');
  const rename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    if (to === saved.path) throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
    return rename(from, to);
  });
  await assert.rejects(writeConfig(home, { ...config, since: '7d' }, saved.revision), { code: 'EROFS' });
  await assert.rejects(writeConfig(home, config, saved.revision, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(await readFile(saved.path, 'utf8'), original);
  assert.deepEqual(await readdir(home), ['copilot-viz.json']);
});

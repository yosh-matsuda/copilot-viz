import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemo, DEMO_SECONDS, HERO, REMOTE } from '../scripts/demo-data.mjs';
import { startDemo } from '../scripts/demo.mjs';
import { createStore } from '../src/public/store.mjs';
import { lanesOf } from '../src/public/timeline.mjs';

test('the authored demo plays through real agent and shell states accepted by the UI', () => {
  const demo = createDemo();
  const store = createStore();
  const initial = demo.snapshot();
  assert.ok(store.apply(initial));
  const hero = store.sessions.get(HERO);
  assert.equal(hero.agents.filter((a) => a.display === 'running').length, 4);
  assert.equal(hero.shells.filter((s) => s.status === 'running').length, 2);
  assert.equal(hero.calls.find((c) => c.id === 'tests-launch').status, 'ok');
  assert.equal(lanesOf(hero, initial.now - 300_000, initial.now).filter((l) => l.kind === 'shell').length, 2);
  const epoch = hero.epoch;
  for (const second of [3, 7, 12, DEMO_SECONDS]) {
    demo.advance(second);
    assert.ok(store.apply(demo.snapshot()));
    assert.equal(store.sessions.get(HERO).epoch, epoch);
    if (second === 7) {
      const s = store.sessions.get(HERO);
      assert.equal(s.shells.find((sh) => sh.id === 'tests').status, 'done');
      assert.equal(s.shells.find((sh) => sh.id === 'build').status, 'running');
      assert.equal(s.agents.find((a) => a.name === 'test-runner').display, 'done');
    }
  }
  const final = store.sessions.get(HERO);
  assert.equal(final.state, 'idle');
  assert.ok(final.shells.every((s) => s.status === 'done' && s.exitCode === 0));
  assert.equal(final.agents.filter((a) => a.display === 'done').length, 3);
  assert.match(demo.callDetail(HERO, 'tests-result', epoch).preview, /24 passed/);
  assert.equal(store.sessions.get(REMOTE).state, 'idle');
});

test('remote session identity and tool detail stay distinct from local calls with the same ID', () => {
  const demo = createDemo();
  const snapshot = demo.snapshot();
  const remote = snapshot.sessions.find((s) => s.id === REMOTE);
  assert.equal(remote.sourceId, 'demo-benchmark');
  assert.equal(snapshot.hosts.find((h) => h.id === remote.host).name, remote.hostName);
  assert.equal(remote.hostName, 'build-box');
  const local = snapshot.sessions.find((s) => s.id === HERO);
  assert.match(demo.callDetail(HERO, 'inspect', local.epoch).preview, /searchProducts/);
  assert.match(demo.callDetail(REMOTE, 'inspect', remote.epoch).preview, /Synthetic catalog/);
  assert.throws(() => demo.callDetail(REMOTE, 'inspect', local.epoch), { status: 409 });
});

test('the isolated demo serves the real UI and synthetic API, but no files outside public assets', async (t) => {
  const server = await startDemo();
  t.after(() => server.close());
  const base = new URL(server.url).origin;
  const index = await fetch(base);
  assert.match(await index.text(), /DEMO &middot; synthetic data/);
  assert.match(await (await fetch(`${base}/app.mjs`)).text(), /createStore/);
  for (const path of ['/package.json', '/api/status', '/%2e%2e%2fsrc/server.mjs']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  const pair = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: 'demo' }) });
  assert.equal(pair.status, 200);
  const { token } = await pair.json();
  const stream = await fetch(`${base}/api/stream?token=${token}`);
  const reader = stream.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += new TextDecoder().decode(chunk.value);
  }
  const snapshot = JSON.parse(text.split('\n\n')[0].slice('data: '.length));
  assert.ok(createStore().apply(snapshot));
  assert.equal(snapshot.sessions.find((s) => s.id === HERO).shells.filter((s) => s.status === 'running').length, 2);
  const s = snapshot.sessions.find((entry) => entry.id === REMOTE);
  const query = new URLSearchParams({ sid: s.id, id: 'inspect', epoch: s.epoch });
  const detail = await fetch(`${base}/api/call?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(detail.status, 200);
  assert.match((await detail.json()).preview, /Synthetic catalog/);
  await reader.cancel();
});

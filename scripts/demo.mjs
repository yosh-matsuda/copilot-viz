import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDemo, HERO } from './demo-data.mjs';

const PUBLIC = new URL('../src/public/', import.meta.url);
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

// This development server never loads the real server, session logs, or SSH configuration.
export async function startDemo() {
  const assets = new Map(await Promise.all((await readdir(PUBLIC)).filter((name) => TYPES[extname(name)]).map(async (name) => {
    let body = await readFile(new URL(name, PUBLIC));
    if (name === 'index.html') body = Buffer.from(body.toString().replace(
      '<span>Copilot Viz</span>', '<span>Copilot Viz</span><span class="badge" data-tone="purple">DEMO &middot; synthetic data</span>',
    ));
    return [`/${name}`, { body, type: TYPES[extname(name)] }];
  })));
  assets.set('/', assets.get('/index.html'));
  const demo = createDemo();
  const streams = new Set();
  let startedAt;
  let timer;
  let closing;

  function play() {
    if (startedAt !== undefined) return;
    startedAt = performance.now();
    timer = setInterval(() => {
      demo.advance((performance.now() - startedAt) / 1000);
      const body = frame(demo.snapshot());
      for (const res of streams) {
        if (res.writableLength > 1 << 20) res.destroy();
        else res.write(body);
      }
    }, 250);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return json(res, 413, { error: 'Demo pairing request is too large.' });
      }
      let code;
      try {
        ({ code } = JSON.parse(body));
      } catch {
        return json(res, 400, { error: 'Invalid demo pairing request.' });
      }
      return code === 'demo' ? json(res, 200, { token: 'synthetic-demo' }) : json(res, 403, { error: 'Use the demo link.' });
    }
    if (url.pathname === '/api/stream' && req.method === 'GET') {
      if (url.searchParams.get('token') !== 'synthetic-demo') return json(res, 401, { error: 'Use the demo link.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(frame(demo.snapshot()));
      streams.add(res);
      res.on('close', () => streams.delete(res));
      play();
      return;
    }
    if (url.pathname === '/api/call' && req.method === 'GET') {
      if (req.headers.authorization !== 'Bearer synthetic-demo') return json(res, 401, { error: 'Use the demo link.' });
      const detail = demo.callDetail(url.searchParams.get('sid'), url.searchParams.get('id'), url.searchParams.get('epoch') ?? undefined);
      return json(res, detail ? 200 : 404, detail ?? { error: 'Unknown demo call.' });
    }
    const asset = assets.get(url.pathname);
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : asset.body);
    }
    return json(res, 404, { error: 'Not part of the demo.' });
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e.status !== 409) console.error(`copilot-viz demo: ${e.stack ?? e}`);
      if (res.headersSent) res.destroy(e);
      else json(res, e.status === 409 ? 409 : 500, { error: e.message });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/?code=demo#${HERO}`,
    close() {
      if (closing) return closing;
      clearInterval(timer);
      for (const res of streams) res.end();
      closing = once(server, 'close');
      server.close();
      server.closeAllConnections();
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const demo = await startDemo();
  console.log(`Synthetic demo only; no real sessions or SSH connections.\n${demo.url}\nPress Ctrl+C to stop.`);
  const stop = () => demo.close().catch((e) => { console.error(e); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

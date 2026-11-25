import { createModel } from '../src/model.mjs';

export const DEMO_SECONDS = 20;
export const HERO = 'demo-search';
export const REMOTE = 'build-box/demo-benchmark';

// Authored events only: commands and their output are examples, never executed.
export function createDemo() {
  const base = Date.parse('2026-01-01T12:05:00Z');
  let elapsed = 0;
  let cursor = 0;
  const events = [];
  const locations = new Map();
  const model = createModel({ home: '/demo', now: () => base + elapsed * 1000, onError: (e) => { throw e; } });
  const api = '00000000-0000-4000-8000-000000000001';
  const ui = '00000000-0000-4000-8000-000000000002';
  const tests = '00000000-0000-4000-8000-000000000003';
  const bench = '00000000-0000-4000-8000-000000000004';
  const add = (sid, sec, type, data = {}, agentId) => events.push({
    sid, sec, event: { type, data, timestamp: new Date(base + sec * 1000).toISOString(), ...(agentId ? { agentId } : {}) },
  });
  const message = (sid, sec, content, agentId) => add(sid, sec, 'assistant.message', { content, toolRequests: [] }, agentId);
  const done = (sid, sec, id, content, agentId) => add(sid, sec, 'tool.execution_complete', {
    toolCallId: id, success: true, result: { content },
  }, agentId);
  const call = (sid, sec, id, toolName, args, duration, output = '', agentId) => {
    add(sid, sec, 'tool.execution_start', { toolCallId: id, toolName, arguments: args }, agentId);
    if (duration != null) done(sid, sec + duration, id, output, agentId);
  };
  const session = (sid, name, host, sec, prompt, branch = 'main', client = 'github/cli') => {
    locations.set(sid, host);
    model.setMeta(sid, { name, client, alive: true });
    add(sid, sec, 'session.start', {
      selectedModel: 'claude-sonnet-4.5',
      context: { cwd: '/demo/shop', repository: 'demo/shop', branch },
    });
    add(sid, sec + 1, 'user.message', { content: prompt });
    add(sid, sec + 2, 'assistant.turn_start');
  };
  const agent = (sid, sec, id, agentId, name, description, type) => {
    call(sid, sec, id, 'task', { name, description, agent_type: type, mode: 'background', prompt: description }, 0.5,
      `Agent started in background with agent_id: ${agentId}.`);
    add(sid, sec, 'subagent.started', {
      toolCallId: id, agentDisplayName: name, agentType: type, executionMode: 'background',
      model: type === 'task' ? 'gpt-5.1-codex-mini' : 'gpt-5.1-codex', resumable: false,
    }, agentId);
    add(sid, sec + 1, 'assistant.turn_start', { parentToolCallId: id }, agentId);
  };
  const finish = (sid, sec, id, agentId, text) => {
    message(sid, sec, text, agentId);
    add(sid, sec, 'assistant.turn_end', {}, agentId);
    add(sid, sec, 'subagent.completed', { toolCallId: id }, agentId);
  };
  const shell = (sid, sec, id, command, description, shellId, agentId) => {
    call(sid, sec, id, 'bash', { command, description, mode: 'async', shellId }, 0.5,
      `<command started in background with shellId: ${shellId}>`, agentId);
  };

  session(HERO, 'Build instant search', 'laptop', -290,
    'Add instant product search with keyboard navigation, ranked results, and tests.', 'feat/instant-search');
  message(HERO, -282, 'I will split the API, interface, and tests into parallel tasks.');
  call(HERO, -278, 'inspect', 'rg', { pattern: 'search', paths: 'src/' }, 9, 'src/search.ts: export function searchProducts(query) {');
  call(HERO, -263, 'read-design', 'view', { path: '/demo/shop/docs/search.md' }, 7, 'Search: ranked results, keyboard navigation, and an empty state.');
  agent(HERO, -245, 'api-task', api, 'search-api', 'Rank search results', 'general-purpose');
  agent(HERO, -242, 'ui-task', ui, 'search-ui', 'Build search UI', 'general-purpose');
  agent(HERO, -239, 'test-task', tests, 'test-runner', 'Run search tests', 'task');
  for (const [who, offset, file] of [[api, 0, 'search.ts'], [ui, 4, 'SearchBox.tsx'], [tests, 8, 'search.test.ts']]) {
    call(HERO, -230 + offset, `read-${file}`, 'view', { path: `/demo/shop/src/${file}` }, 8, `Existing ${file} module.`, who);
    call(HERO, -213 + offset, `find-${file}`, 'rg', { pattern: 'query', paths: `src/${file}` }, 5, 'Found the query handler.', who);
    call(HERO, -187 + offset, `edit-${file}`, 'edit', {
      path: `/demo/shop/src/${file}`, old_str: 'const limit = 5;', new_str: 'const limit = 10;',
    }, 24, 'File updated.', who);
    call(HERO, -131 + offset, `check-${file}`, 'bash', { command: `npm test -- ${file}`, description: 'Check focused tests' },
      19, 'Focused checks passed.', who);
    add(HERO, -90 + offset, 'session.usage_record', { inputTokens: 4200 + offset * 100, outputTokens: 1200, cacheReadTokens: 2400 }, who);
  }
  call(HERO, -174, 'main-read', 'view', { path: '/demo/shop/package.json' }, 5, '{"scripts":{"test":"vitest run","build":"vite build"}}');
  call(HERO, -152, 'main-plan', 'sql', { query: 'SELECT title, status FROM todos' }, 3, 'API: in progress\nUI: in progress\nTests: in progress');
  message(HERO, -68, 'The API and interface are ready for integration. Running the build and tests in parallel.');
  shell(HERO, -58, 'build-launch', 'npm run build', 'Production build', 'build', ui);
  shell(HERO, -48, 'tests-launch', 'npm test', 'Search tests', 'tests', tests);
  message(HERO, -22, 'I am checking the final results while the two background shells finish.');
  message(HERO, -20, 'Exact matches come first; empty queries return no results.', api);
  message(HERO, -18, 'Keyboard navigation and the empty state are in place.', ui);
  message(HERO, -15, 'Testing ranking, debouncing, and keyboard navigation.', tests);
  call(HERO, -13, 'api-final', 'edit', {
    path: '/demo/shop/src/search.ts', old_str: 'return results;', new_str: 'return rankResults(results, query);',
  }, 16, 'Ranking now uses the normalized query.', api);
  call(HERO, -9, 'ui-final', 'view', { path: '/demo/shop/src/SearchBox.tsx' }, 11, 'The search input exposes an accessible combobox.', ui);
  call(HERO, -6, 'tests-result', 'read_bash', { shellId: 'tests' }, 12,
    'PASS  search.test.ts\n  8 ranking checks\n  8 keyboard checks\n  8 empty-state checks\n\nTest Files  3 passed (3)\nTests       24 passed (24)\n\n<shellId: tests completed with exit code 0>', tests);
  call(HERO, -2, 'build-progress', 'read_bash', { shellId: 'build' }, 6,
    'Transforming modules...\nRendering chunks...\n<command with shellId: build is still running after 4 seconds>');
  message(HERO, 3, 'The query normalization is covered. Running one final API check.', api);
  call(HERO, 3.5, 'api-check', 'bash', { command: 'npm test -- search-api', description: 'Verify ranked results' }, 7,
    '8 API checks passed.', api);
  finish(HERO, 7, 'test-task', tests, 'All 24 checks passed: ranking, keyboard navigation, and empty states.');
  add(HERO, 9, 'system.notification', { kind: { type: 'shell_completed', shellId: 'build', exitCode: 0 } });
  finish(HERO, 10, 'ui-task', ui, 'Search UI complete. The production build passed.');
  finish(HERO, 11, 'api-task', api, 'Ranked search is complete, with coverage for exact matches and empty queries.');
  message(HERO, 12, 'Ready to review: ranked search, keyboard navigation, 24 passing checks, and a successful build.');
  add(HERO, 12, 'assistant.turn_end');

  session(REMOTE, 'Benchmark search', 'build-box', -270, 'Compare the search index against a synthetic product catalog.', 'perf/search-index');
  message(REMOTE, -263, 'I will build the sample catalog and run the benchmark on this host.');
  call(REMOTE, -258, 'inspect', 'view', { path: '/demo/shop/bench/catalog.json' }, 8, 'Synthetic catalog: 10,000 sample products.');
  agent(REMOTE, -231, 'bench-task', bench, 'benchmark', 'Validate the search index', 'task');
  call(REMOTE, -205, 'bench-config', 'view', { path: '/demo/shop/bench/search.mjs' }, 13, 'Benchmark fixture with a fixed random seed.', bench);
  call(REMOTE, -172, 'bench-edit', 'edit', {
    path: '/demo/shop/bench/search.mjs', old_str: 'const runs = 1;', new_str: 'const runs = 10;',
  }, 16, 'Benchmark repetitions updated.', bench);
  shell(REMOTE, -108, 'bench-launch', 'node bench/search.mjs', 'Search benchmark', 'benchmark', bench);
  message(REMOTE, -6, 'The sample catalog is loaded. Checking index consistency across repeated runs.', bench);
  call(REMOTE, -4, 'bench-result', 'read_bash', { shellId: 'benchmark' }, 21,
    'Synthetic benchmark complete.\nAll repeated runs returned the same ranked results.\n<shellId: benchmark completed with exit code 0>', bench);
  finish(REMOTE, 18, 'bench-task', bench, 'The synthetic catalog produced consistent results across all runs.');
  message(REMOTE, 19, 'The benchmark and index checks are complete.');
  add(REMOTE, 19, 'assistant.turn_end');

  const waiting = 'demo-cache';
  session(waiting, 'Set cache policy', 'laptop', -205, 'Add caching to the search endpoint.', 'feat/search-cache', 'vscode-agent-host');
  call(waiting, -186, 'cache-read', 'view', { path: '/demo/shop/src/cache.ts' }, 11, 'The current endpoint has no cache.');
  message(waiting, -88, 'A short cache lifetime reduces repeated work. Which policy would you prefer?');
  call(waiting, -80, 'cache-choice', 'ask_user', { message: 'Cache results for 30 seconds or refresh on every request?' }, null);

  const docs = 'test-box/demo-docs';
  session(docs, 'Write API examples', 'test-box', -250, 'Document the search endpoint with small examples.', 'docs/search');
  call(docs, -222, 'docs-read', 'view', { path: '/demo/shop/docs/api.md' }, 12, 'GET /api/search?q=...');
  call(docs, -180, 'docs-edit', 'edit', {
    path: '/demo/shop/docs/api.md', old_str: 'Search products.', new_str: 'Search products by name. Empty queries return an empty list.',
  }, 23, 'Examples added.');
  message(docs, -106, 'Added examples for ranked results, empty queries, and pagination.');
  add(docs, -105, 'assistant.turn_end');

  events.sort((a, b) => a.sec - b.sec);
  function advance(seconds) {
    if (!Number.isFinite(seconds) || seconds < elapsed) throw new Error('Demo time must move forward.');
    elapsed = seconds;
    while (cursor < events.length && events[cursor].sec <= elapsed) {
      const { sid, event } = events[cursor++];
      model.ingest(sid, event);
    }
    model.tick();
    model.drain();
  }
  advance(0);
  return {
    advance,
    callDetail: model.callDetail,
    snapshot() {
      const now = base + elapsed * 1000;
      const hosts = ['laptop', 'build-box', 'test-box'].map((name, i) => ({
        id: i ? `ssh:${name}` : 'local', name, remote: i > 0, state: 'live', error: null, retryAt: null, lastSeen: now,
      }));
      const snapshot = model.snapshot();
      return {
        ...snapshot, type: 'snapshot', now, ready: true, hosts,
        sessions: snapshot.sessions.map((s) => {
          const host = hosts.find((h) => h.name === locations.get(s.id));
          return { ...s, host: host.id, hostName: host.name, sourceId: s.id.split('/').at(-1), clockOffset: 0, sourceNow: now, stale: false };
        }),
      };
    },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installCheckupWeb, PAGE_ROUTE, API_ROUTE } from '../src/web.js';

/** Capture the routes a plugin would register on ctx.webServer. */
function harness(getReport, baselineActions = { saveBaseline: async () => ({ recordedAt: 'x' }), clearBaseline: async () => {} }) {
  const routes = new Map();
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['webServer']);
      callback({
        get: (name) =>
          name === 'webServer'
            ? {
                register: (route) => {
                  routes.set(route.path, route.handler);
                  return () => routes.delete(route.path);
                },
              }
            : undefined,
        effect: (fn) => fn(),
      });
    },
  };
  installCheckupWeb(ctx, getReport, baselineActions);
  return routes;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = typeof body === 'string' ? body : String(body);
    },
  };
}

function fakeRequest({ method = 'GET', url = '/', headers = {}, body = '', remoteAddress = '127.0.0.1', host = '127.0.0.1:43120' } = {}) {
  const req = {
    method,
    url,
    socket: { remoteAddress },
    headers: { host, ...headers },
  };
  if (body !== '') {
    req[Symbol.asyncIterator] = async function* () {
      yield body;
    };
  }
  return req;
}

const REPORT = {
  schemaVersion: 2,
  generatedAt: '2026-10-21T00:00:00.000Z',
  profile: { dir: 'C:/Users/demo/.dsh/profiles/web', bundles: ['dsh-a'] },
  counts: { blocker: 1, warn: 0, info: 0, total: 1 },
  findings: [
    {
      rule: 'failed-entry',
      severity: 'blocker',
      subject: { kind: 'entry', entryId: 'a', moduleName: 'dsh-a' },
      title: '插件加载失败：dsh-a',
      detail: 'fiberPhase=failed',
      evidence: [{ kind: 'runtime', ref: 'loader entry a', pointer: 'fiberPhase=failed' }],
      confidence: 'high',
      source: 'runtime',
    },
  ],
  inventory: {
    entries: [],
    bundles: [],
    plugins: [],
    tools: { available: true, items: [] },
    commands: { available: true, items: [] },
    recent: [],
    attribution: { tools: { memory_get: ['dsh-a'] }, commands: {}, slots: {}, scanned: [], bytes: 0, warnings: [] },
  },
  baseline: { exists: true, recordedAt: '2026-10-20T00:00:00.000Z', empty: true, entries: { added: [], removed: [] }, tools: { added: [], removed: [] }, commands: { added: [], removed: [] }, bundles: { added: [], removed: [] } },
  warnings: [],
  meta: { layer: 'L2-runtime', readOnly: true, modelCalls: 0, networkCalls: 0 },
};

test('registers page, report and baseline routes', () => {
  const routes = harness(async () => REPORT);
  assert.ok(routes.has(PAGE_ROUTE));
  assert.ok(routes.has(API_ROUTE));
  assert.ok(routes.has(`${API_ROUTE}/baseline`));
});

test('api returns the report as JSON', async () => {
  const routes = harness(async () => REPORT);
  const res = fakeResponse();
  await routes.get(API_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup/api' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /application\/json/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.report.counts.blocker, 1);
  assert.equal(payload.report.inventory.attribution.tools.memory_get[0], 'dsh-a');
});

test('api supports markdown export', async () => {
  const routes = harness(async () => REPORT);
  const res = fakeResponse();
  await routes.get(API_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup/api?format=md' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/markdown/);
  assert.match(res.body, /DSH 插件运行时巡检报告/);
});

test('page returns HTML with a nonce CSP and a baseline token', async () => {
  const routes = harness(async () => REPORT);
  const res = fakeResponse();
  await routes.get(PAGE_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.match(res.headers['Content-Security-Policy'], /nonce-[0-9a-f]+/);
  assert.match(res.body, /插件体检/);
  assert.match(res.body, /var TOKEN = "[0-9a-f]{64}"/);
});

test('cross-site requests are rejected', async () => {
  const routes = harness(async () => REPORT);
  const res = fakeResponse();
  await routes.get(API_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup/api', headers: { 'sec-fetch-site': 'cross-site' } }), res);
  assert.equal(res.statusCode, 403);
});

test('non-loopback clients are rejected', async () => {
  const routes = harness(async () => REPORT);
  const res = fakeResponse();
  await routes.get(API_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup/api', remoteAddress: '10.1.2.3' }), res);
  assert.equal(res.statusCode, 403);
});

test('non-GET report methods are rejected', async () => {
  const routes = harness(async () => REPORT);
  const res = fakeResponse();
  await routes.get(API_ROUTE)(fakeRequest({ method: 'POST', url: '/_dsh/plugin-checkup/api' }), res);
  assert.equal(res.statusCode, 405);
});

test('baseline save requires the page token', async () => {
  const routes = harness(async () => REPORT);
  const page = fakeResponse();
  await routes.get(PAGE_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup' }), page);
  const token = /var TOKEN = "([0-9a-f]{64})"/.exec(page.body)[1];

  const denied = fakeResponse();
  await routes.get(`${API_ROUTE}/baseline`)(
    fakeRequest({
      method: 'POST',
      url: '/_dsh/plugin-checkup/api/baseline',
      headers: { 'content-type': 'application/json', 'x-checkup-token': 'wrong' },
      body: JSON.stringify({ action: 'save' }),
    }),
    denied,
  );
  assert.equal(denied.statusCode, 403);

  const allowed = fakeResponse();
  await routes.get(`${API_ROUTE}/baseline`)(
    fakeRequest({
      method: 'POST',
      url: '/_dsh/plugin-checkup/api/baseline',
      headers: { 'content-type': 'application/json', 'x-checkup-token': token },
      body: JSON.stringify({ action: 'save' }),
    }),
    allowed,
  );
  assert.equal(allowed.statusCode, 200);
  assert.equal(JSON.parse(allowed.body).ok, true);
});

test('baseline clear calls the clear action', async () => {
  let cleared = false;
  const routes = harness(async () => REPORT, {
    saveBaseline: async () => ({ recordedAt: 'x' }),
    clearBaseline: async () => {
      cleared = true;
    },
  });
  const page = fakeResponse();
  await routes.get(PAGE_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup' }), page);
  const token = /var TOKEN = "([0-9a-f]{64})"/.exec(page.body)[1];
  const res = fakeResponse();
  await routes.get(`${API_ROUTE}/baseline`)(
    fakeRequest({
      method: 'POST',
      url: '/_dsh/plugin-checkup/api/baseline',
      headers: { 'content-type': 'application/json', 'x-checkup-token': token },
      body: JSON.stringify({ action: 'clear' }),
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(cleared, true);
});

test('baseline rejects unknown actions', async () => {
  const routes = harness(async () => REPORT);
  const page = fakeResponse();
  await routes.get(PAGE_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup' }), page);
  const token = /var TOKEN = "([0-9a-f]{64})"/.exec(page.body)[1];
  const res = fakeResponse();
  await routes.get(`${API_ROUTE}/baseline`)(
    fakeRequest({
      method: 'POST',
      url: '/_dsh/plugin-checkup/api/baseline',
      headers: { 'content-type': 'application/json', 'x-checkup-token': token },
      body: JSON.stringify({ action: 'explode' }),
    }),
    res,
  );
  assert.equal(res.statusCode, 400);
});

test('report failures return a JSON error instead of crashing', async () => {
  const routes = harness(async () => {
    throw new Error('probe exploded');
  });
  const res = fakeResponse();
  await routes.get(API_ROUTE)(fakeRequest({ url: '/_dsh/plugin-checkup/api' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /probe exploded/);
});

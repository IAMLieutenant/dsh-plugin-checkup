#!/usr/bin/env node
/**
 * Local preview: serve the checkup page with fixture data, so you can see the
 * UI before installing the plugin into a DSH profile.
 *
 *   node scripts/demo.mjs          → http://127.0.0.1:4799/_dsh/plugin-checkup
 *
 * The fixtures mimic a real desktop profile with a few typical problems:
 * a failed row, a module loaded twice, an undeclared row, a missing package and
 * a declared-but-not-loaded row. Nothing here touches a real DSH installation.
 */

import { createServer } from 'node:http';
import { renderPage } from '../src/page.js';
import { evaluate } from '../src/rules.js';
import { buildReport, toMarkdown } from '../src/report.js';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4799);
const ROUTE = '/_dsh/plugin-checkup';

const facts = {
  generatedAt: new Date().toISOString(),
  loaderAvailable: true,
  managementAvailable: true,
  profileDir: 'C:/Users/demo/.dsh/profiles/web',
  profileManifest: {
    bundles: ['dsh-tool-user-memory', 'dsh-context', 'dsh-missing-plugin'],
    dependencies: {
      'dsh-tool-user-memory': '^0.4.0',
      'dsh-context': '^0.5.2',
      'dsh-missing-plugin': '^1.2.0',
    },
  },
  entries: [
    { entryId: 'tool-user-memory', moduleName: 'dsh-tool-user-memory', enabled: true, phase: 'active' },
    { entryId: 'context', moduleName: 'dsh-context', enabled: true, phase: 'failed' },
    { entryId: 'context-2', moduleName: 'dsh-context', enabled: true, phase: 'active' },
    { entryId: 'sneaky', moduleName: 'dsh-undeclared-helper', enabled: true, phase: 'active' },
    { entryId: 'disabled-row', moduleName: 'dsh-optional-tool', enabled: false, phase: null },
  ],
  bundles: [
    {
      name: 'dsh-tool-user-memory',
      version: '0.4.0',
      installed: true,
      enabled: true,
      availability: 'profile',
      rows: [{ rowId: 'tool-user-memory', moduleName: 'dsh-tool-user-memory', entryId: 'tool-user-memory' }],
    },
    {
      name: 'dsh-context',
      version: '0.5.2',
      installed: true,
      enabled: true,
      availability: 'profile',
      rows: [{ rowId: 'context', moduleName: 'dsh-context', entryId: 'context' }],
    },
    {
      name: 'dsh-missing-plugin',
      version: '1.2.0',
      installed: true,
      enabled: true,
      availability: 'missing',
      rows: [{ rowId: 'missing', moduleName: 'dsh-missing-plugin' }],
    },
    {
      name: 'dsh-declared-only',
      version: '0.1.0',
      installed: true,
      enabled: true,
      availability: 'profile',
      rows: [{ rowId: 'declared-only', moduleName: 'dsh-declared-only' }],
    },
  ],
  plugins: [
    { entryId: 'tool-user-memory', moduleName: 'dsh-tool-user-memory', enabled: true, fiberPhase: 'active' },
    { entryId: 'context', moduleName: 'dsh-context', enabled: true, fiberPhase: 'failed' },
    { entryId: 'ro', moduleName: 'dsh-agent-preset-tool', enabled: true, fiberPhase: 'active', readOnlyReason: 'management-required' },
  ],
  tools: { available: true, items: [{ name: 'memory_get' }, { name: 'memory_update' }, { name: 'web_search' }, { name: 'plan' }] },
  commands: { available: true, items: [{ name: 'plan' }, { name: 'context' }, { name: 'checkup' }] },
  recent: [
    { name: 'dsh-context', version: '^0.5.2', modifiedAt: '2026-10-20T09:12:00.000Z' },
    { name: 'dsh-tool-user-memory', version: '^0.4.0', modifiedAt: '2026-10-18T15:40:00.000Z' },
  ],
  warnings: ['ctx.fs 读取示例：本预览使用内置 fixture，不访问真实 profile'],
};

const report = buildReport(facts, evaluate(facts));

/** Mirror the real plugin's loopback + same-origin guard so the demo behaves the same. */
function allowed(req) {
  const remote = req.socket?.remoteAddress;
  if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== `127.0.0.1:${PORT}`) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!allowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden: loopback + same-origin only');
    return;
  }
  if (url.pathname === ROUTE) {
    const nonce = randomBytes(16).toString('hex');
    const html = renderPage({ nonce, embedded: false });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'self'`,
    });
    res.end(html);
    return;
  }
  if (url.pathname === `${ROUTE}/api`) {
    if (url.searchParams.get('format') === 'md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(toMarkdown(report));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, report }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`checkup demo → http://127.0.0.1:${PORT}${ROUTE}`);
  console.log(`fixture findings → ${report.counts.blocker} blocker / ${report.counts.warn} warn / ${report.counts.info} info`);
});

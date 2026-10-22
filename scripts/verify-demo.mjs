#!/usr/bin/env node
/**
 * Smoke-check a running checkup server (demo or real DSH).
 *   node scripts/verify-demo.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:4799';

const api = await fetch(`${base}/_dsh/plugin-checkup/api`);
console.log('api status:', api.status, api.headers.get('content-type'));
const payload = await api.json();
console.log('ok:', payload.ok);
console.log(
  'counts:',
  JSON.stringify(payload.report.counts),
  'entries:',
  payload.report.inventory.entries.length,
  'bundles:',
  payload.report.inventory.bundles.length,
);
for (const finding of payload.report.findings) {
  console.log(` - [${finding.severity}] ${finding.rule}: ${finding.title}`);
}

const page = await fetch(`${base}/_dsh/plugin-checkup`);
const html = await page.text();
console.log('page status:', page.status, 'bytes:', html.length, 'has title:', html.includes('插件体检'));
console.log('csp:', page.headers.get('content-security-policy'));

const markdown = await (await fetch(`${base}/_dsh/plugin-checkup/api?format=md`)).text();
console.log('markdown bytes:', markdown.length, 'starts:', markdown.slice(0, 24));

const crossSite = await fetch(`${base}/_dsh/plugin-checkup/api`, { headers: { 'sec-fetch-site': 'cross-site' } });
console.log('cross-site status (expect 403):', crossSite.status);

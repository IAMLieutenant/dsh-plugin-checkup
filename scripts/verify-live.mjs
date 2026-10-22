#!/usr/bin/env node
/**
 * End-to-end check against a live DSH host.
 *   node scripts/verify-live.mjs [baseUrl]
 *
 * Reads the report, saves a baseline through the page token, reads the diff,
 * then clears the baseline again. Everything happens over the plugin's own
 * loopback-only HTTP surface.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:4790';

async function waitForApi(attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${base}/_dsh/plugin-checkup/api`);
      if (response.ok) return response;
    } catch {
      // host still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`checkup api did not answer at ${base}`);
}

const api = await waitForApi();
const first = (await api.json()).report;
console.log('api ok');
console.log('entries:', first.inventory.entries.length, 'bundles:', first.inventory.bundles.length, 'findings:', first.findings.length);
console.log('counts:', JSON.stringify(first.counts));
console.log('tools:', first.inventory.tools.available ? first.inventory.tools.items.length : 'unavailable');
console.log('commands:', first.inventory.commands.available ? first.inventory.commands.items.length : 'unavailable');
console.log('attribution:', first.inventory.attribution ? `${first.inventory.attribution.scanned.length} packages, ${first.inventory.attribution.bytes} bytes` : 'none');
for (const finding of first.findings.slice(0, 10)) console.log(` - [${finding.severity}] ${finding.rule}: ${finding.title}`);

const page = await (await fetch(`${base}/_dsh/plugin-checkup`)).text();
const token = /var TOKEN = "([0-9a-f]{64})"/.exec(page)?.[1];
if (!token) throw new Error('page token not found');
console.log('page token found');

const save = await fetch(`${base}/_dsh/plugin-checkup/api/baseline`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-checkup-token': token },
  body: JSON.stringify({ action: 'save' }),
});
console.log('baseline save:', save.status, JSON.stringify(await save.json()));

const afterSave = (await (await fetch(`${base}/_dsh/plugin-checkup/api?refresh=1`)).json()).report;
console.log('baseline in report:', afterSave.baseline ? `exists, recordedAt=${afterSave.baseline.recordedAt}, empty=${afterSave.baseline.empty}` : 'missing');

const clear = await fetch(`${base}/_dsh/plugin-checkup/api/baseline`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-checkup-token': token },
  body: JSON.stringify({ action: 'clear' }),
});
console.log('baseline clear:', clear.status, JSON.stringify(await clear.json()));

const afterClear = (await (await fetch(`${base}/_dsh/plugin-checkup/api?refresh=1`)).json()).report;
console.log('baseline after clear:', afterClear.baseline ? 'still present' : 'removed');

const markdown = await (await fetch(`${base}/_dsh/plugin-checkup/api?format=md`)).text();
console.log('markdown bytes:', markdown.length, '| has attribution:', markdown.includes('工具来源归因'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanRegistrations } from '../src/scan.js';

async function fixturePackage(profileDir, name, files) {
  const root = join(profileDir, 'node_modules', name);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

test('scanRegistrations attributes tools, commands and slots to packages', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-scan-'));
  try {
    await fixturePackage(profileDir, 'dsh-alpha', {
      'package.json': JSON.stringify({ name: 'dsh-alpha', version: '1.0.0' }),
      'lib/index.js': [
        "ctx.tools.register(defineTool({",
        "  name: 'memory_get',",
        "  description: 'read memory',",
        "}))",
        "ctx.commands.register({ name: 'alpha_cmd', handler: async () => ({ type: 'success' }) })",
        "ctx.slots.register({ name: 'plugins.detail.badge', key: 'alpha#badge' }, Component)",
      ].join('\n'),
    });
    await fixturePackage(profileDir, 'dsh-beta', {
      'package.json': JSON.stringify({ name: 'dsh-beta', version: '1.0.0' }),
      'dist/index.mjs': "export const x = defineTool({ name: 'memory_get' })",
    });

    const result = await scanRegistrations(profileDir, ['dsh-alpha', 'dsh-beta', 'dsh-missing']);
    assert.deepEqual(result.tools.memory_get, ['dsh-alpha', 'dsh-beta']);
    assert.deepEqual(result.commands.alpha_cmd, ['dsh-alpha']);
    assert.deepEqual(result.slots['plugins.detail.badge'], ['dsh-alpha']);
    assert.equal(result.scanned.length, 2);
    assert.ok(result.bytes > 0);
    assert.equal(result.warnings.length, 0);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
});

test('scanRegistrations skips files above the size cap and honors the budget', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-scan-cap-'));
  try {
    await fixturePackage(profileDir, 'dsh-big', {
      'lib/huge.js': "defineTool({ name: 'huge_tool' })" + 'x'.repeat(5000),
    });
    const result = await scanRegistrations(profileDir, ['dsh-big'], { maxFileBytes: 100 });
    assert.equal(result.tools.huge_tool, undefined);
    assert.equal(result.bytes, 0);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectFacts, phaseOf } from '../src/probe.js';

/** Minimal fake Context exposing only what the probe reads. */
function fakeContext({ entries, services = {}, loaderThrows = false } = {}) {
  const rows = entries ?? [
    { id: 'row-a', options: { name: 'dsh-a' }, disabled: false, fiber: { state: 2 } },
    { id: 'row-b', options: { name: 'dsh-b' }, disabled: true, fiber: { state: 4 } },
    { id: 'group-1', options: { name: 'group', group: true }, disabled: false },
  ];
  const registry = {
    pluginManager: {
      listBundles: async () => [
        {
          name: 'dsh-a',
          installed: true,
          enabled: true,
          availability: 'installation',
          rows: [{ rowId: 'a', moduleName: 'dsh-a' }],
        },
      ],
      listPlugins: async () => [
        { entryId: 'row-a', moduleName: 'dsh-a', enabled: true, fiberPhase: 'active' },
        { entryId: 'row-x', moduleName: 'dsh-x', enabled: true, fiberPhase: 'active', readOnlyReason: 'management-required' },
      ],
    },
    tools: { schemas: () => [{ name: 'memory_get', description: 'read memory' }] },
    commands: { list: () => [{ name: 'plan' }] },
    ...services,
  };
  return {
    loader: {
      entries: () => {
        if (loaderThrows) throw new Error('boom');
        return rows;
      },
    },
    get: (name) => (name in registry ? registry[name] : undefined),
  };
}

test('phaseOf maps cordis fiber states', () => {
  assert.equal(phaseOf({ state: 0 }), 'pending');
  assert.equal(phaseOf({ state: 1 }), 'loading');
  assert.equal(phaseOf({ state: 2 }), 'active');
  assert.equal(phaseOf({ state: 3 }), 'failed');
  assert.equal(phaseOf({ state: 4 }), null);
  assert.equal(phaseOf({ state: 5 }), 'unloading');
  assert.equal(phaseOf(undefined), null);
  assert.equal(phaseOf('active'), 'active');
});

test('collectFacts reads loader rows and enumerable registries', async () => {
  const facts = await collectFacts(fakeContext());
  assert.equal(facts.loaderAvailable, true);
  assert.equal(facts.managementAvailable, true);
  assert.equal(facts.profileDir, undefined);

  // group rows are skipped
  assert.deepEqual(facts.entries.map((entry) => entry.entryId), ['row-a', 'row-b']);
  assert.equal(facts.entries[1].enabled, false);
  assert.equal(facts.entries[1].phase, null);

  assert.equal(facts.bundles.length, 1);
  assert.equal(facts.plugins.length, 2);
  assert.equal(facts.tools.items[0].name, 'memory_get');
  assert.equal(facts.commands.items[0].name, 'plan');
  assert.equal(facts.warnings.length, 0);
});

test('collectFacts reads the profile manifest when the directory is available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-checkup-'));
  try {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'dsh-a': '^1.0.0' }, dsh: { profile: { bundles: ['dsh-a'] } } }),
      'utf8',
    );
    await mkdir(join(dir, 'node_modules', 'dsh-a'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'dsh-a', 'package.json'), JSON.stringify({ name: 'dsh-a', version: '1.0.0' }), 'utf8');

    const ctx = fakeContext({ services: { profileContext: { dir } } });
    const facts = await collectFacts(ctx);
    assert.equal(facts.profileDir, dir);
    assert.deepEqual(facts.profileManifest.bundles, ['dsh-a']);
    assert.equal(facts.recent.length, 1);
    assert.equal(facts.recent[0].name, 'dsh-a');
    assert.equal(facts.warnings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectFacts degrades when pluginManager is absent', async () => {
  const ctx = fakeContext({ services: { pluginManager: undefined } });
  const facts = await collectFacts(ctx);
  assert.equal(facts.managementAvailable, false);
  assert.equal(facts.bundles.length, 0);
  assert.ok(facts.warnings.some((warning) => warning.includes('pluginManager')));
});

test('collectFacts survives a throwing loader and a throwing tools registry', async () => {
  const ctx = fakeContext({
    loaderThrows: true,
    services: {
      tools: {
        schemas: () => {
          throw new Error('nope');
        },
      },
    },
  });
  const facts = await collectFacts(ctx);
  assert.equal(facts.loaderAvailable, false);
  assert.ok(facts.warnings.some((warning) => warning.includes('loader.entries')));
  assert.equal(facts.tools.available, false);
  assert.ok(facts.warnings.some((warning) => warning.includes('tools')));
});

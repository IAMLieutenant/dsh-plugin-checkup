import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  baselinePath,
  clearBaseline,
  diffBaseline,
  readBaseline,
  snapshotFromReport,
  writeBaseline,
} from '../src/baseline.js';

function report(overrides = {}) {
  return {
    counts: { blocker: 0, warn: 1, info: 0, total: 1 },
    inventory: {
      entries: [{ entryId: 'a', moduleName: 'dsh-a', phase: 'active' }],
      tools: { available: true, items: [{ name: 'memory_get' }] },
      commands: { available: true, items: [{ name: 'plan' }] },
      bundles: [{ name: 'dsh-a', version: '1.0.0' }],
      ...overrides.inventory,
    },
    ...overrides.report,
  };
}

test('baseline lives under DSH_HOME and round-trips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-baseline-'));
  try {
    const profileDir = join(root, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });

    assert.equal(baselinePath(profileDir), join(root, 'plugin-checkup', 'baseline.json'));
    assert.equal(await readBaseline(profileDir), null);

    const snapshot = snapshotFromReport(report(), '2026-10-21T00:00:00.000Z');
    await writeBaseline(profileDir, snapshot);
    const loaded = await readBaseline(profileDir);
    assert.equal(loaded.recordedAt, '2026-10-21T00:00:00.000Z');
    assert.deepEqual(loaded.tools, ['memory_get']);
    assert.deepEqual(loaded.entries, [{ entryId: 'a', moduleName: 'dsh-a', phase: 'active' }]);

    await clearBaseline(profileDir);
    assert.equal(await readBaseline(profileDir), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diffBaseline reports added and removed runtime facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-baseline-diff-'));
  try {
    const profileDir = join(root, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    await writeBaseline(profileDir, snapshotFromReport(report(), '2026-10-21T00:00:00.000Z'));
    const baseline = await readBaseline(profileDir);

    const current = report({
      inventory: {
        entries: [
          { entryId: 'a', moduleName: 'dsh-a', phase: 'active' },
          { entryId: 'b', moduleName: 'dsh-b', phase: 'active' },
        ],
        tools: { available: true, items: [{ name: 'memory_get' }, { name: 'new_tool' }] },
        commands: { available: true, items: [] },
        bundles: [{ name: 'dsh-a', version: '1.0.0' }, { name: 'dsh-b', version: '0.1.0' }],
      },
    });
    const diff = diffBaseline(baseline, current);
    assert.equal(diff.exists, true);
    assert.equal(diff.empty, false);
    assert.deepEqual(diff.entries.added, ['b|dsh-b']);
    assert.deepEqual(diff.tools.added, ['new_tool']);
    assert.deepEqual(diff.commands.removed, ['plan']);
    assert.deepEqual(diff.bundles.added, ['dsh-b@0.1.0']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diffBaseline reports no change for an identical report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-baseline-same-'));
  try {
    const profileDir = join(root, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    await writeBaseline(profileDir, snapshotFromReport(report(), '2026-10-21T00:00:00.000Z'));
    const baseline = await readBaseline(profileDir);
    const diff = diffBaseline(baseline, report());
    assert.equal(diff.exists, true);
    assert.equal(diff.empty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diffBaseline without a baseline is empty', () => {
  assert.deepEqual(diffBaseline(null, report()), { exists: false });
});

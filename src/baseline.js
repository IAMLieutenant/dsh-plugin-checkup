/**
 * Baseline snapshots: record one point in time, then show what changed since.
 *
 * Storage lives under $DSH_HOME/plugin-checkup/baseline.json. It never touches
 * the DSH profile: the baseline is the checkup plugin's own data directory.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const DIR_NAME = 'plugin-checkup';
const FILE_NAME = 'baseline.json';

/**
 * @param {string} profileDir
 * @returns {string}
 */
export function baselinePath(profileDir) {
  const home = resolve(profileDir, '..', '..');
  return join(home, DIR_NAME, FILE_NAME);
}

/**
 * @param {string} profileDir
 * @returns {Promise<any|null>}
 */
export async function readBaseline(profileDir) {
  try {
    const raw = await readFile(baselinePath(profileDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} profileDir
 * @param {any} snapshot
 */
export async function writeBaseline(profileDir, snapshot) {
  const path = baselinePath(profileDir);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/** @param {string} profileDir */
export async function clearBaseline(profileDir) {
  try {
    await unlink(baselinePath(profileDir));
  } catch {
    // already absent
  }
}

/**
 * @param {any} report
 * @param {string} [recordedAt]
 */
export function snapshotFromReport(report, recordedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    recordedAt,
    entries: (report.inventory.entries ?? []).map((entry) => ({
      entryId: entry.entryId,
      moduleName: entry.moduleName,
      phase: entry.phase ?? null,
    })),
    tools: (report.inventory.tools?.items ?? []).map((item) => item.name).sort(),
    commands: (report.inventory.commands?.items ?? []).map((item) => item.name).sort(),
    bundles: (report.inventory.bundles ?? []).map((bundle) => ({ name: bundle.name, version: bundle.version ?? null })),
    counts: report.counts,
  };
}

/** @param {string[]} before @param {string[]} after */
function listDiff(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((item) => !beforeSet.has(item)),
    removed: before.filter((item) => !afterSet.has(item)),
  };
}

/**
 * @param {any} baseline
 * @param {any} report
 */
export function diffBaseline(baseline, report) {
  if (!baseline) return { exists: false };
  const current = snapshotFromReport(report, baseline.recordedAt);
  const entryKey = (entry) => `${entry.entryId}|${entry.moduleName}`;
  const entries = listDiff(
    (baseline.entries ?? []).map(entryKey),
    (current.entries ?? []).map(entryKey),
  );
  const tools = listDiff(baseline.tools ?? [], current.tools);
  const commands = listDiff(baseline.commands ?? [], current.commands);
  const bundleKeys = (list) => list.map((bundle) => `${bundle.name}@${bundle.version ?? ''}`);
  const bundles = listDiff(bundleKeys(baseline.bundles ?? []), bundleKeys(current.bundles ?? []));
  const empty =
    entries.added.length === 0 &&
    entries.removed.length === 0 &&
    tools.added.length === 0 &&
    tools.removed.length === 0 &&
    commands.added.length === 0 &&
    commands.removed.length === 0 &&
    bundles.added.length === 0 &&
    bundles.removed.length === 0;
  return {
    exists: true,
    recordedAt: baseline.recordedAt,
    entries,
    tools,
    commands,
    bundles,
    empty,
  };
}

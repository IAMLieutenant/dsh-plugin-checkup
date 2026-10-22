/**
 * dsh-plugin-checkup — host entry (L2 runtime inspection).
 *
 * Read-only by construction for the DSH profile: this plugin never writes to
 * the profile, never installs/enables/disables anything, never reads plugin
 * behavior at runtime beyond official registries, and never calls a model.
 * The only write in the whole product is the optional baseline snapshot, which
 * lives under $DSH_HOME/plugin-checkup/ and never in a profile.
 */

import { collectFacts } from './probe.js';
import { evaluate } from './rules.js';
import { buildReport } from './report.js';
import { installCheckupWeb } from './web.js';
import { scanRegistrations } from './scan.js';
import {
  clearBaseline,
  diffBaseline,
  readBaseline,
  snapshotFromReport,
  writeBaseline,
} from './baseline.js';

export const name = 'plugin-checkup';

/** Core service only: the Loader is what makes runtime facts observable. */
export const inject = ['loader'];

const CACHE_MS = 3000;

/**
 * Attribute runtime tool/command names back to installed packages by scanning
 * their built files. Bounded and optional: failure downgrades the report, never
 * breaks it.
 * @param {any} facts
 */
async function collectAttribution(facts) {
  if (typeof facts.profileDir !== 'string') return null;
  const names = new Set();
  for (const bundle of facts.bundles ?? []) {
    if (bundle?.name) names.add(bundle.name);
  }
  for (const dependency of Object.keys(facts.profileManifest?.dependencies ?? {})) names.add(dependency);
  if (names.size === 0) return null;
  try {
    const attribution = await scanRegistrations(facts.profileDir, [...names]);
    facts.warnings.push(...attribution.warnings);
    return attribution;
  } catch (error) {
    facts.warnings.push(`来源归因扫描失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function apply(ctx) {
  let cache = { at: 0, report: null };

  /**
   * Probe → attribute → evaluate → snapshot diff. `force` is the explicit
   * refresh path; otherwise a 3s cache keeps repeated page opens cheap.
   * @param {boolean} [force]
   */
  const getReport = async (force = false) => {
    if (!force && cache.report !== null && Date.now() - cache.at < CACHE_MS) return cache.report;
    const facts = await collectFacts(ctx);
    facts.attribution = await collectAttribution(facts);
    const findings = evaluate(facts);
    const report = buildReport(facts, findings);
    if (typeof facts.profileDir === 'string') {
      try {
        const baseline = await readBaseline(facts.profileDir);
        if (baseline) report.baseline = diffBaseline(baseline, report);
      } catch {
        // a corrupt baseline must not break the report
      }
    }
    cache = { at: Date.now(), report };
    return report;
  };

  const saveBaselineNow = async () => {
    const report = await getReport(true);
    const profileDir = report.profile.dir;
    if (typeof profileDir !== 'string') throw new Error('当前 profile 目录不可用，无法记录基线');
    const snapshot = snapshotFromReport(report);
    await writeBaseline(profileDir, snapshot);
    cache = { at: 0, report: null };
    return snapshot;
  };

  const clearBaselineNow = async () => {
    const report = await getReport(false);
    const profileDir = report.profile.dir;
    if (typeof profileDir !== 'string') throw new Error('当前 profile 目录不可用');
    await clearBaseline(profileDir);
    cache = { at: 0, report: null };
  };

  // Installing/enabling/disabling a plugin invalidates the next read. There is
  // no polling: the cache only bounds staleness between consecutive page opens.
  try {
    ctx.on('plugin-manager/changed', () => {
      cache = { at: 0, report: null };
    });
  } catch {
    // Event unavailable on this host version: the 3s cache still bounds staleness.
  }

  installCheckupWeb(ctx, getReport, { saveBaseline: saveBaselineNow, clearBaseline: clearBaselineNow });
}

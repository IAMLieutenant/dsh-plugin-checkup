import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, countBySeverity } from '../src/rules.js';
import { buildReport, toMarkdown } from '../src/report.js';

const STAMP = '2026-10-21T00:00:00.000Z';

function makeFacts(overrides = {}) {
  return {
    generatedAt: STAMP,
    loaderAvailable: true,
    managementAvailable: true,
    profileDir: 'C:/Users/demo/.dsh/profiles/web',
    profileManifest: { bundles: ['dsh-a'], dependencies: { 'dsh-a': '^1.0.0' } },
    entries: [{ entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' }],
    bundles: [
      {
        name: 'dsh-a',
        version: '1.0.0',
        installed: true,
        enabled: true,
        availability: 'installation',
        rows: [{ rowId: 'a', moduleName: 'dsh-a', entryId: 'a' }],
      },
    ],
    plugins: [{ entryId: 'a', moduleName: 'dsh-a', enabled: true, fiberPhase: 'active' }],
    tools: { available: true, items: [{ name: 'memory_get' }] },
    commands: { available: true, items: [{ name: 'plan' }] },
    recent: [],
    warnings: [],
    ...overrides,
  };
}

function byRule(findings, rule) {
  return findings.filter((finding) => finding.rule === rule);
}

test('clean profile has no findings', () => {
  const findings = evaluate(makeFacts());
  assert.equal(findings.length, 0, JSON.stringify(findings, null, 2));
});

test('failed loader entry is a blocker', () => {
  const findings = evaluate(
    makeFacts({ entries: [{ entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'failed' }] }),
  );
  const failed = byRule(findings, 'failed-entry');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, 'blocker');
  assert.equal(failed[0].source, 'runtime');
  assert.equal(failed[0].subject.entryId, 'a');
});

test('same module loaded by two entries is a warning', () => {
  const findings = evaluate(
    makeFacts({
      entries: [
        { entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' },
        { entryId: 'a2', moduleName: 'dsh-a', enabled: true, phase: 'active' },
      ],
    }),
  );
  const duplicates = byRule(findings, 'duplicate-module');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].confidence, 'medium');
  assert.match(duplicates[0].title, /dsh-a/);
});

test('declared row without a runtime entry is reported', () => {
  const findings = evaluate(makeFacts({ entries: [] }));
  const missing = byRule(findings, 'declared-but-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].subject.moduleName, 'dsh-a');
});

test('missing package is a blocker', () => {
  const findings = evaluate(
    makeFacts({
      entries: [],
      bundles: [
        {
          name: 'dsh-gone',
          installed: true,
          enabled: true,
          availability: 'missing',
          rows: [{ rowId: 'gone', moduleName: 'dsh-gone' }],
        },
      ],
    }),
  );
  const missing = byRule(findings, 'package-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'blocker');
});

test('incompatible-version diagnostic is surfaced with requirements', () => {
  const findings = evaluate(
    makeFacts({
      bundles: [
        {
          name: 'dsh-old',
          installed: true,
          enabled: true,
          availability: 'profile',
          rows: [],
          error: {
            code: 'incompatible-version',
            incompatible: [
              { name: 'dsh-old', version: '0.9.0', runtimeVersion: '0.2.1-rc.2', requirements: { 'engines.dsh': '>=0.3.0' } },
            ],
          },
        },
      ],
    }),
  );
  const incompatible = byRule(findings, 'incompatible-version');
  assert.equal(incompatible.length, 1);
  assert.match(incompatible[0].detail, /engines\.dsh/);
});

test('runtime entry with no declaration is reported as undeclared', () => {
  const findings = evaluate(
    makeFacts({
      entries: [
        { entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' },
        { entryId: 'sneaky', moduleName: 'dsh-sneaky', enabled: true, phase: 'active' },
      ],
    }),
  );
  const undeclared = byRule(findings, 'undeclared-entry');
  assert.equal(undeclared.length, 1);
  assert.equal(undeclared[0].subject.moduleName, 'dsh-sneaky');
});

test('official core rows are not reported as undeclared', () => {
  const findings = evaluate(
    makeFacts({
      entries: [
        { entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' },
        { entryId: 'tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, phase: 'active' },
        { entryId: 'base-include', moduleName: 'cordis:plugin-include', enabled: true, phase: 'active' },
      ],
    }),
  );
  assert.equal(byRule(findings, 'undeclared-entry').length, 0);
});

test('disabled bundles do not contribute declarations', () => {
  const findings = evaluate(
    makeFacts({
      entries: [{ entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' }],
      bundles: [
        {
          name: 'dsh-a',
          installed: true,
          enabled: true,
          availability: 'profile',
          rows: [{ rowId: 'a', moduleName: 'dsh-a', entryId: 'a' }],
        },
        {
          name: 'dsh-optional',
          installed: false,
          enabled: false,
          availability: 'installation',
          rows: [{ rowId: 'opt', moduleName: 'dsh-opt' }],
        },
      ],
    }),
  );
  assert.equal(byRule(findings, 'declared-but-missing').length, 0);
});

test('optional bundle that was never installed is not "missing"', () => {
  const findings = evaluate(
    makeFacts({
      bundles: [
        {
          name: '@deepseek-ai/dsh-experimental-voice-input-bundle',
          installed: false,
          enabled: false,
          availability: 'missing',
          rows: [],
        },
      ],
    }),
  );
  assert.equal(byRule(findings, 'package-missing').length, 0);
});

test('official duplicate declarations and modules are ignored', () => {
  const findings = evaluate(
    makeFacts({
      entries: [
        { entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' },
        { entryId: 'preset-1', moduleName: '@deepseek-ai/dsh-agent-preset', enabled: true, phase: 'active' },
        { entryId: 'preset-2', moduleName: '@deepseek-ai/dsh-agent-preset', enabled: true, phase: 'active' },
      ],
      bundles: [
        {
          name: '@deepseek-ai/dsh-base',
          installed: false,
          enabled: true,
          availability: 'installation',
          rows: [{ rowId: 'core', moduleName: '@deepseek-ai/dsh-llm', entryId: 'include:llm' }],
        },
        {
          name: '@deepseek-ai/dsh-web-app',
          installed: false,
          enabled: true,
          availability: 'installation',
          rows: [{ rowId: 'core-web', moduleName: '@deepseek-ai/dsh-llm', entryId: 'include:llm' }],
        },
        {
          name: 'dsh-a',
          installed: true,
          enabled: true,
          availability: 'profile',
          rows: [{ rowId: 'a', moduleName: 'dsh-a', entryId: 'a' }],
        },
      ],
    }),
  );
  assert.equal(byRule(findings, 'duplicate-declaration').length, 0);
  assert.equal(byRule(findings, 'duplicate-module').length, 0);
});

test('tool with no package attribution is reported', () => {
  const findings = evaluate(
    makeFacts({
      tools: { available: true, items: [{ name: 'mystery_tool' }] },
      attribution: { tools: {}, commands: {}, slots: {}, scanned: [], bytes: 0, warnings: [] },
    }),
  );
  const unattributed = byRule(findings, 'unattributed-tool');
  assert.equal(unattributed.length, 1);
  assert.match(unattributed[0].title, /mystery_tool/);
});

test('official tools are exempt from attribution rules', () => {
  const findings = evaluate(
    makeFacts({
      tools: { available: true, items: [{ name: 'web_search' }, { name: 'read' }] },
      attribution: { tools: {}, commands: {}, slots: {}, scanned: [], bytes: 0, warnings: [] },
    }),
  );
  assert.equal(byRule(findings, 'unattributed-tool').length, 0);
});

test('tool claimed by two packages is reported as multi-source', () => {
  const findings = evaluate(
    makeFacts({
      tools: { available: true, items: [{ name: 'memory_get' }] },
      attribution: {
        tools: { memory_get: ['dsh-a', 'dsh-b'] },
        commands: {},
        slots: {},
        scanned: [],
        bytes: 0,
        warnings: [],
      },
    }),
  );
  const multi = byRule(findings, 'tool-multi-source');
  assert.equal(multi.length, 1);
  assert.equal(multi[0].severity, 'info');
});

test('same entry id declared by two bundles is reported', () => {
  const findings = evaluate(
    makeFacts({
      entries: [{ entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'active' }],
      bundles: [
        {
          name: 'dsh-a',
          installed: true,
          enabled: true,
          availability: 'installation',
          rows: [{ rowId: 'a', moduleName: 'dsh-a', entryId: 'a' }],
        },
        {
          name: 'dsh-b',
          installed: true,
          enabled: true,
          availability: 'profile',
          rows: [{ rowId: 'a', moduleName: 'dsh-b', entryId: 'a' }],
        },
      ],
    }),
  );
  const duplicate = byRule(findings, 'duplicate-declaration');
  assert.equal(duplicate.length, 1);
  assert.match(duplicate[0].detail, /dsh-a/);
});

test('tool and command sharing a name is informational', () => {
  const findings = evaluate(
    makeFacts({
      tools: { available: true, items: [{ name: 'plan' }] },
      commands: { available: true, items: [{ name: 'plan' }] },
    }),
  );
  const collision = byRule(findings, 'namespace-collision');
  assert.equal(collision.length, 1);
  assert.equal(collision[0].severity, 'info');
});

test('loader unavailable degrades to a warning', () => {
  const findings = evaluate(makeFacts({ loaderAvailable: false, entries: [] }));
  assert.equal(byRule(findings, 'loader-unavailable').length, 1);
});

test('management unavailable degrades to runtime-only mode', () => {
  const findings = evaluate(makeFacts({ managementAvailable: false, bundles: [], plugins: [] }));
  assert.equal(byRule(findings, 'degraded-mode').length, 1);
  assert.equal(byRule(findings, 'undeclared-entry').length, 0);
});

test('countBySeverity totals every finding', () => {
  const counts = countBySeverity([
    { severity: 'blocker' },
    { severity: 'warn' },
    { severity: 'info' },
    { severity: 'info' },
  ]);
  assert.deepEqual(counts, { blocker: 1, warn: 1, info: 2, total: 4 });
});

test('report carries counts, inventory and metadata', () => {
  const facts = makeFacts({ entries: [{ entryId: 'a', moduleName: 'dsh-a', enabled: true, phase: 'failed' }] });
  const findings = evaluate(facts);
  const report = buildReport(facts, findings);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.counts.blocker, 1);
  assert.equal(report.inventory.entries.length, 1);
  assert.equal(report.meta.modelCalls, 0);
  assert.equal(report.meta.readOnly, true);

  const markdown = toMarkdown(report);
  assert.match(markdown, /DSH 插件运行时巡检报告/);
  assert.match(markdown, /failed-entry/);
  assert.match(markdown, /运行时条目/);
});

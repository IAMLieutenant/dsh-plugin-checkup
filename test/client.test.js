import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js');

/** Load the hand-written browser bundle in a fake window and return its plugin object. */
async function loadPlugin(report) {
  const code = await readFile(SOURCE, 'utf8');
  let definition;
  const sandboxWindow = {
    __ModuleLoader__: {
      load: (value) => {
        definition = value;
      },
    },
  };
  const fakeFetch = async () => ({ json: async () => ({ ok: true, report }) });
  const run = new Function('window', 'fetch', code);
  run(sandboxWindow, fakeFetch);
  assert.ok(definition, 'client bundle called __ModuleLoader__.load');

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react');
    return React;
  });
  return plugin;
}

function fakeContext() {
  const registrations = [];
  return {
    registrations,
    ctx: {
      slots: {
        inject(name, callback) {
          return callback();
        },
        register(options, component) {
          registrations.push({ options, component });
          return () => {};
        },
      },
      effect(fn) {
        return fn();
      },
    },
  };
}

/** Render a fake React element tree by invoking function components. */
function render(element) {
  if (element === null || typeof element !== 'object') return element;
  if (typeof element.type === 'function') return render(element.type(element.props));
  return {
    type: element.type,
    props: element.props,
    children: (element.children ?? []).map(render),
  };
}

const REPORT = {
  counts: { blocker: 1, warn: 0, info: 0, total: 1 },
  findings: [
    {
      rule: 'failed-entry',
      severity: 'blocker',
      subject: { kind: 'entry', entryId: 'ctx-1', moduleName: 'dsh-context' },
      title: '插件加载失败：dsh-context',
      confidence: 'high',
    },
    {
      rule: 'declared-but-missing',
      severity: 'warn',
      subject: { kind: 'bundle', bundle: 'dsh-broken', moduleName: 'dsh-broken' },
      title: '声明了但未加载：dsh-broken',
      confidence: 'medium',
    },
  ],
  inventory: {
    bundles: [
      { name: 'dsh-context', version: '0.5.2' },
      { name: 'dsh-tool-user-memory', version: '0.4.0' },
    ],
  },
};

test('client bundle registers plugin-page surfaces', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const names = registrations.map((entry) => entry.options.name);
  assert.ok(names.includes('plugins.detail.badge'));
  assert.ok(names.includes('plugins.detail.section'));
  assert.ok(names.includes('plugins.overview'));
  assert.ok(names.includes('plugins.row.config'));

  const bundleActions = registrations.filter((entry) => entry.options.name === 'plugins.bundle.actions');
  assert.deepEqual(
    bundleActions.map((entry) => entry.options.key).sort(),
    ['dsh-context', 'dsh-tool-user-memory'],
  );

  const rowConfig = registrations.find((entry) => entry.options.name === 'plugins.row.config');
  assert.equal(rowConfig.options.key, 'dsh-plugin-checkup#plugin-checkup');
});

test('detail badge renders nothing without findings and a badge with findings', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const badge = registrations.find((entry) => entry.options.name === 'plugins.detail.badge').component;
  const unrelated = render(badge({ subject: { kind: 'bundle', pkg: { name: 'other-bundle', rows: [] } } }));
  assert.equal(unrelated, null);

  const related = render(badge({ subject: { kind: 'bundle', pkg: { name: 'dsh-context', rows: [{ moduleName: 'dsh-context' }] } } }));
  assert.ok(related, 'badge rendered for a bundle with findings');
  assert.equal(related.props.style.color, '#dc2626');
});

test('detail section lists findings and returns null when clean', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const section = registrations.find((entry) => entry.options.name === 'plugins.detail.section').component;
  assert.equal(render(section({ subject: { kind: 'bundle', pkg: { name: 'clean', rows: [] } } })), null);
  const rendered = render(section({ subject: { kind: 'bundle', pkg: { name: 'dsh-context', rows: [{ moduleName: 'dsh-context' }] } } }));
  assert.ok(rendered);
  assert.ok(Array.isArray(rendered.children));
});

test('overview card renders counts', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const overview = registrations.find((entry) => entry.options.name === 'plugins.overview').component;
  const rendered = render(overview());
  const text = JSON.stringify(rendered);
  assert.match(text, /阻断 1/);
});

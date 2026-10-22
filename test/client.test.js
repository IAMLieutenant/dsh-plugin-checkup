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
  return definition.factory((name) => {
    assert.equal(name, 'react');
    return React;
  });
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
      { name: 'dsh-context', version: '0.5.2', rows: [{ rowId: 'context', moduleName: 'dsh-context' }] },
      { name: 'dsh-tool-user-memory', version: '0.4.0', rows: [{ rowId: 'mem', moduleName: 'dsh-tool-user-memory' }] },
    ],
  },
};

test('client bundle registers the 体检 tab and plugin-page surfaces', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const names = registrations.map((entry) => entry.options.name);
  assert.ok(names.includes('plugins.tab'));
  assert.ok(names.includes('plugins.detail.badge'));
  assert.ok(names.includes('plugins.detail.section'));
  assert.ok(names.includes('plugins.overview'));
  assert.ok(names.includes('plugins.row.config'));

  const tab = registrations.find((entry) => entry.options.name === 'plugins.tab');
  assert.equal(tab.options.id, 'checkup');
  assert.equal(tab.options.label, '体检');

  const rowConfig = registrations.find((entry) => entry.options.name === 'plugins.row.config');
  assert.equal(rowConfig.options.key, 'dsh-plugin-checkup#plugin-checkup');
});

test('bundle badges appear only for bundles with findings', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const actions = registrations.filter((entry) => entry.options.name === 'plugins.bundle.actions');
  assert.deepEqual(actions.map((entry) => entry.options.key), ['dsh-context']);
});

test('tab renders an embedded iframe and a dialog button', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const tab = registrations.find((entry) => entry.options.name === 'plugins.tab').component;
  const rendered = render(tab());
  const iframe = rendered.children.find((child) => child && child.type === 'iframe');
  assert.ok(iframe, 'tab embeds the checkup page');
  assert.match(iframe.props.src, /\/_dsh\/plugin-checkup\?embedded=1/);

  const button = rendered.children
    .flatMap((child) => (child && Array.isArray(child.children) ? child.children : []))
    .find((child) => child && child.type === 'button');
  assert.ok(button, 'tab has a dialog button');
  assert.equal(typeof button.props.onClick, 'function');
});

test('detail badge renders nothing without findings and a badge with findings', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const badge = registrations.find((entry) => entry.options.name === 'plugins.detail.badge').component;
  assert.equal(render(badge({ subject: { kind: 'bundle', pkg: { name: 'other-bundle', rows: [] } } })), null);
  const related = render(badge({ subject: { kind: 'bundle', pkg: { name: 'dsh-context', rows: [{ moduleName: 'dsh-context' }] } } }));
  assert.ok(related);
  assert.equal(related.props.style.color, '#dc2626');
});

test('detail section lists findings and returns null when clean', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const section = registrations.find((entry) => entry.options.name === 'plugins.detail.section').component;
  assert.equal(render(section({ subject: { kind: 'bundle', pkg: { name: 'clean', rows: [] } } })), null);
  assert.ok(render(section({ subject: { kind: 'bundle', pkg: { name: 'dsh-context', rows: [{ moduleName: 'dsh-context' }] } } })));
});

test('overview card renders counts', async () => {
  const plugin = await loadPlugin(REPORT);
  const { ctx, registrations } = fakeContext();
  await plugin.apply(ctx);

  const overview = registrations.find((entry) => entry.options.name === 'plugins.overview').component;
  const text = JSON.stringify(render(overview()));
  assert.match(text, /阻断 1/);
});

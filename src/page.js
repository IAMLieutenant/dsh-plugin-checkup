/**
 * The checkup page: a self-contained, dependency-free HTML document.
 *
 * Every piece of data is rendered with DOM APIs + textContent (never innerHTML
 * with runtime data), so plugin-provided strings cannot inject markup.
 */

/**
 * @param {{nonce: string, embedded: boolean, token?: string}} options
 * @returns {string}
 */
export function renderPage({ nonce, embedded, token }) {
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>插件体检 · 运行时巡检</title>
<style nonce="${nonce}">
  :root {
    --ck-bg: var(--dsw-alias-bg-layer-1, #ffffff);
    --ck-surface: var(--dsw-alias-bg-module-platform, #f6f6f7);
    --ck-text: var(--dsw-alias-label-primary, #1f2328);
    --ck-muted: var(--dsw-alias-label-secondary, #6b7280);
    --ck-border: var(--dsw-alias-border-l2, #e3e4e8);
    --ck-hover: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
    --ck-blocker: #dc2626; --ck-warn: #d97706; --ck-info: #2563eb; --ck-ok: #059669;
  }
  html[data-theme="dark"] {
    --ck-bg: #17181c; --ck-surface: #1f2127; --ck-text: #e8e9ec; --ck-muted: #9aa0aa;
    --ck-border: #2e3138; --ck-hover: rgba(255,255,255,.07);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 22px 40px; background: var(--ck-bg); color: var(--ck-text); font: 14px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0; }
  .hint { color: var(--ck-muted); font-size: 12px; }
  .spacer { flex: 1; }
  button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 10px; border: 1px solid var(--ck-border); background: var(--ck-surface); color: inherit; cursor: pointer; }
  button:hover { background: var(--ck-hover); }
  button:disabled { opacity: .5; cursor: default; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .card { border: 1px solid var(--ck-border); border-radius: 12px; padding: 10px 12px; background: var(--ck-surface); }
  .card b { display: block; font-size: 20px; line-height: 1.2; }
  .card span { color: var(--ck-muted); font-size: 12px; }
  .section { margin: 22px 0 8px; font-size: 15px; font-weight: 600; }
  .finding { border: 1px solid var(--ck-border); border-left-width: 4px; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; background: var(--ck-surface); }
  .finding.blocker { border-left-color: var(--ck-blocker); }
  .finding.warn { border-left-color: var(--ck-warn); }
  .finding.info { border-left-color: var(--ck-info); }
  .finding h3 { margin: 0 0 4px; font-size: 14px; display: flex; gap: 8px; align-items: baseline; }
  .tag { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid currentColor; opacity: .9; }
  .finding p { margin: 4px 0; color: var(--ck-muted); }
  .finding code, .finding .evidence { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .evidence { color: var(--ck-muted); display: block; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--ck-border); vertical-align: top; }
  th { color: var(--ck-muted); font-weight: 500; }
  td code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .muted { color: var(--ck-muted); }
  .empty { color: var(--ck-muted); padding: 8px 0; }
  details { margin: 10px 0; }
  summary { cursor: pointer; color: var(--ck-muted); }
  .ok { color: var(--ck-ok); }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--ck-hover); }
</style>
</head>
<body>
<header>
  <h1>插件体检 · 运行时巡检</h1>
  <span class="hint">只读 · 不调用模型 · 数据来自宿主运行时注册表</span>
  <span class="spacer"></span>
  <button id="refresh" type="button">重新巡检</button>
  <button id="copy" type="button">复制 Markdown</button>
</header>
<div class="hint" id="meta">加载中…</div>

<div class="cards" id="cards"></div>
<div id="content"></div>

<script nonce="${nonce}">
(function () {
  'use strict';
  var state = null;
  var base = '/_dsh/plugin-checkup';
  var TOKEN = ${JSON.stringify(token ?? '')};

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'class') node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function tone(sev) { return sev === 'blocker' ? '失败' : sev === 'warn' ? '警告' : '提示'; }

  function renderCards(report) {
    var cards = document.getElementById('cards');
    cards.textContent = '';
    var items = [
      ['阻断', report.counts.blocker, '必须处理'],
      ['警告', report.counts.warn, '建议确认'],
      ['提示', report.counts.info, '了解即可'],
      ['运行时条目', report.inventory.entries.length, '实际加载'],
      ['组合包', report.inventory.bundles.length, '声明的包'],
    ];
    items.forEach(function (item) {
      cards.appendChild(el('div', { class: 'card' }, [
        el('b', { text: String(item[1]) }),
        el('span', { text: item[0] + ' · ' + item[2] }),
      ]));
    });
  }

  function renderFindings(report) {
    var content = document.getElementById('content');
    content.appendChild(el('div', { class: 'section', text: '发现（' + report.findings.length + '）' }));
    if (report.findings.length === 0) {
      content.appendChild(el('div', { class: 'empty ok', text: '未发现异常。运行时条目与插件声明一致。' }));
      return;
    }
    report.findings.forEach(function (finding) {
      var box = el('div', { class: 'finding ' + finding.severity });
      var title = el('h3', null, [
        el('span', { class: 'tag', text: tone(finding.severity) }),
        el('span', { text: finding.title }),
      ]);
      box.appendChild(title);
      box.appendChild(el('p', { text: finding.detail }));
      (finding.evidence || []).forEach(function (evidence) {
        box.appendChild(el('span', { class: 'evidence', text: '· 证据：' + (evidence.kind === 'file' ? '文件 ' : '运行时 ') + evidence.ref + (evidence.pointer ? ' @ ' + evidence.pointer : '') }));
      });
      (finding.fix || []).forEach(function (fix) {
        box.appendChild(el('span', { class: 'evidence', text: '· 建议：' + fix.label }));
      });
      box.appendChild(el('span', { class: 'evidence', text: '· 规则 ' + finding.rule + ' · 置信度 ' + finding.confidence + ' · 来源 ' + finding.source }));
      content.appendChild(box);
    });
  }

  function table(headers, rows) {
    var t = el('table');
    var thead = el('tr');
    headers.forEach(function (header) { thead.appendChild(el('th', { text: header })); });
    t.appendChild(thead);
    rows.forEach(function (row) {
      var tr = el('tr');
      row.forEach(function (cell) { tr.appendChild(cell instanceof Node ? el('td', null, [cell]) : el('td', { text: String(cell == null ? '' : cell) })); });
      t.appendChild(tr);
    });
    return t;
  }

  function renderInventory(report) {
    var content = document.getElementById('content');
    var inv = report.inventory;
    content.appendChild(el('div', { class: 'section', text: '运行时条目（实际加载）' }));
    content.appendChild(table(['entry id', 'module', '启用', '阶段'], inv.entries.map(function (entry) {
      return [entry.entryId, entry.moduleName, entry.enabled ? '是' : '否', entry.phase || '—'];
    })));

    content.appendChild(el('div', { class: 'section', text: '组合包（声明）' }));
    var bundleRows = inv.bundles.map(function (bundle) {
      return [bundle.name, bundle.version || '—', bundle.enabled ? '是' : '否', (bundle.rows || []).length, bundle.availability || '—'];
    });
    content.appendChild(bundleRows.length ? table(['包名', '版本', '启用', '行数', '可用性'], bundleRows) : el('div', { class: 'empty', text: '宿主没有提供 pluginManager 数据。' }));

    if (inv.tools.available || inv.commands.available) {
      content.appendChild(el('div', { class: 'section', text: '模型可见的工具与斜杠命令' }));
      var toolNames = (inv.tools.items || []).map(function (item) { return item.name; });
      var commandNames = (inv.commands.items || []).map(function (item) { return item.name; });
      content.appendChild(el('p', { class: 'muted', text: '工具 ' + toolNames.length + ' 个：' + (toolNames.join(', ') || '—') }));
      content.appendChild(el('p', { class: 'muted', text: '命令 ' + commandNames.length + ' 个：' + (commandNames.map(function (name) { return '/' + name; }).join(', ') || '—') }));
    }

    if ((inv.recent || []).length > 0) {
      content.appendChild(el('div', { class: 'section', text: '最近变更的插件包（按文件时间）' }));
      content.appendChild(table(['包名', '声明版本', '最后修改'], inv.recent.map(function (item) {
        return [item.name, item.version, item.modifiedAt.replace('T', ' ').slice(0, 19)];
      })));
    }

    if (inv.attribution) {
      content.appendChild(el('div', { class: 'section', text: '工具来源归因' }));
      var owners = inv.attribution.tools || {};
      var attributionRows = Object.keys(owners).map(function (name) { return [name, owners[name].join('、')]; });
      content.appendChild(attributionRows.length > 0 ? table(['工具', '来源包'], attributionRows) : el('div', { class: 'empty', text: '未扫描到工具声明。' }));
      content.appendChild(el('p', { class: 'muted', text: '扫描 ' + inv.attribution.scanned.length + ' 个包，' + inv.attribution.bytes + ' 字节构建产物。扫描不到来源的工具会出现在「未找到注册来源的工具」中。' }));
    }

    content.appendChild(el('div', { class: 'section', text: '基线对比' }));
    var baseline = report.baseline;
    if (!baseline || baseline.exists !== true) {
      content.appendChild(el('p', { class: 'muted', text: '还没有基线。记录当前状态后，之后打开本页即可看到新增或消失的条目、工具与命令。基线保存在 DSH_HOME/plugin-checkup/，不会写入 profile。' }));
    } else {
      content.appendChild(el('p', { class: 'muted', text: '基线记录于 ' + baseline.recordedAt.replace('T', ' ').slice(0, 19) + (baseline.empty ? '，当前无变化。' : '，检测到变化。') }));
      if (baseline.empty !== true) {
        [['条目', baseline.entries], ['工具', baseline.tools], ['命令', baseline.commands], ['组合包', baseline.bundles]].forEach(function (pair) {
          var diff = pair[1];
          if (!diff || (diff.added.length === 0 && diff.removed.length === 0)) return;
          var text = '· ' + pair[0] + ' 新增 ' + diff.added.length + '，消失 ' + diff.removed.length;
          if (diff.added.length > 0) text += '；新增：' + diff.added.slice(0, 10).join('、');
          if (diff.removed.length > 0) text += '；消失：' + diff.removed.slice(0, 10).join('、');
          content.appendChild(el('p', { class: 'muted', text: text }));
        });
      }
    }
    var baselineActions = el('div', null, []);
    var saveButton = el('button', { type: 'button', text: '记录当前为基线' });
    saveButton.addEventListener('click', function () { baselineAction('save'); });
    var clearButton = el('button', { type: 'button', text: '清除基线' });
    clearButton.addEventListener('click', function () { baselineAction('clear'); });
    baselineActions.appendChild(saveButton);
    baselineActions.appendChild(clearButton);
    content.appendChild(baselineActions);

    if ((report.warnings || []).length > 0) {
      var details = el('details');
      details.appendChild(el('summary', { text: '采集告警（' + report.warnings.length + '）' }));
      report.warnings.forEach(function (warning) { details.appendChild(el('div', { class: 'muted', text: '· ' + warning })); });
      content.appendChild(details);
    }
  }

  function render(report) {
    state = report;
    document.getElementById('meta').textContent =
      '生成时间 ' + report.generatedAt.replace('T', ' ').slice(0, 19) +
      (report.profile.dir ? ' · Profile ' + report.profile.dir : '') +
      ' · 检测层 ' + report.meta.layer +
      (report.meta.modelCalls === 0 ? ' · 模型调用 0 次' : '');
    renderCards(report);
    var content = document.getElementById('content');
    content.textContent = '';
    renderFindings(report);
    renderInventory(report);
  }

  function load(force) {
    var refresh = document.getElementById('refresh');
    refresh.disabled = true;
    fetch(base + '/api' + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error(payload && payload.error ? payload.error : '未知错误');
        render(payload.report);
      })
      .catch(function (error) {
        document.getElementById('meta').textContent = '加载失败：' + error.message;
      })
      .finally(function () { refresh.disabled = false; });
  }

  function baselineAction(action) {
    fetch(base + '/api/baseline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-checkup-token': TOKEN },
      body: JSON.stringify({ action: action }),
    })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error(payload && payload.error ? payload.error : '操作失败');
        return load(true);
      })
      .catch(function (error) {
        document.getElementById('meta').textContent = '基线操作失败：' + error.message;
      });
  }

  function copyMarkdown() {
    fetch(base + '/api?format=md', { headers: { accept: 'text/markdown' } })
      .then(function (response) { return response.text(); })
      .then(function (text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      })
      .then(function () { document.getElementById('copy').textContent = '已复制'; setTimeout(function () { document.getElementById('copy').textContent = '复制 Markdown'; }, 1500); })
      .catch(function () { document.getElementById('copy').textContent = '复制失败'; });
  }

  // ── theme sync when embedded in the DSH window (same-origin iframe) ──────
  function syncTheme() {
    var parentDocument = null;
    try { parentDocument = window.parent !== window ? window.parent.document : null; } catch (error) { parentDocument = null; }
    if (!parentDocument) return;
    var dark = parentDocument.body && parentDocument.body.hasAttribute('data-ds-dark-theme');
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var source = parentDocument.body ? getComputedStyle(parentDocument.body) : null;
    if (!source) return;
    var pairs = {
      '--dsw-alias-bg-layer-1': '--ck-bg',
      '--dsw-alias-bg-module-platform': '--ck-surface',
      '--dsw-alias-label-primary': '--ck-text',
      '--dsw-alias-label-secondary': '--ck-muted',
      '--dsw-alias-border-l2': '--ck-border',
      '--dsw-alias-interactive-bg-hover': '--ck-hover',
    };
    var root = document.documentElement;
    Object.keys(pairs).forEach(function (token) {
      var value = source.getPropertyValue(token).trim();
      if (value) root.style.setProperty(pairs[token], value);
    });
    if (source.fontFamily) document.body.style.fontFamily = source.fontFamily;
  }

  document.getElementById('refresh').addEventListener('click', function () { load(true); });
  document.getElementById('copy').addEventListener('click', copyMarkdown);
  ${embedded ? 'window.addEventListener("load", function () { syncTheme(); try { new MutationObserver(syncTheme).observe(window.parent.document.body, { attributes: true }); } catch (error) {} });' : ''}
  load(false);
})();
</script>
</body>
</html>`;
}

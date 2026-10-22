/**
 * Browser half: plugin-page surfaces for the runtime inspection.
 *
 * Surfaces:
 *   plugins.tab            → a dedicated 体检 tab on the Plugins page
 *   plugins.overview       → aggregate card on the installed list
 *   plugins.detail.badge   → severity badge on a bundle/row/item detail page
 *   plugins.detail.section → evidence list for the same subject
 *   plugins.row.config     → open-the-dialog button on this plugin's own row
 *
 * The panel opens as an in-app modal with a same-origin iframe. It is never
 * opened in a browser tab: the Desktop host admits only its Electron renderer,
 * so a normal browser gets a 403 by design. The dialog is built with plain DOM
 * on click, which keeps every slot component a pure function without hooks.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-checkup',
  factory: function (require) {
    var React = require('react');
    var BASE = '/_dsh/plugin-checkup';
    var SEVERITY_ORDER = { blocker: 3, warn: 2, info: 1 };
    var SEVERITY_COLOR = { blocker: '#dc2626', warn: '#d97706', info: '#2563eb' };
    var SEVERITY_LABEL = { blocker: '阻断', warn: '警告', info: '提示' };

    var activeDialog = null;

    function closeDialog() {
      if (!activeDialog) return;
      var current = activeDialog;
      activeDialog = null;
      if (current.open) current.close();
      current.remove();
    }

    function openDialog() {
      if (activeDialog) return;
      var previousFocus = document.activeElement;
      var dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', '插件运行时巡检');
      Object.assign(dialog.style, {
        width: 'min(1040px, 94vw)',
        height: 'min(760px, 88vh)',
        maxWidth: '94vw',
        maxHeight: '88vh',
        padding: '0',
        border: '1px solid var(--dsw-alias-border-l2, #dcdce0)',
        borderRadius: '20px',
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        overflow: 'hidden',
        font: 'inherit',
        boxShadow: '0 16px 60px #00000026'
      });

      var layout = document.createElement('div');
      Object.assign(layout.style, { display: 'flex', flexDirection: 'column', height: '100%' });

      var header = document.createElement('header');
      Object.assign(header.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 18px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #dcdce0)',
        flexShrink: '0'
      });

      var title = document.createElement('strong');
      title.textContent = '插件体检 · 运行时巡检';
      title.style.fontSize = '14px';

      var note = document.createElement('span');
      note.textContent = '只读 · 零模型调用';
      Object.assign(note.style, {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        marginRight: 'auto'
      });

      var close = document.createElement('button');
      close.type = 'button';
      close.textContent = '关闭';
      close.setAttribute('aria-label', '关闭运行时巡检');
      Object.assign(close.style, {
        border: 'none',
        borderRadius: '12px',
        padding: '7px 12px',
        background: 'var(--dsw-alias-interactive-bg-hover, #00000008)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px'
      });
      close.addEventListener('click', closeDialog);

      var frame = document.createElement('iframe');
      frame.src = BASE + '?embedded=1';
      frame.title = 'DSH 插件运行时巡检';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');
      Object.assign(frame.style, { width: '100%', flex: '1', minHeight: '0', border: '0' });

      header.append(title, note, close);
      layout.append(header, frame);
      dialog.append(layout);
      dialog.addEventListener(
        'close',
        function () {
          closeDialog();
          if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        },
        { once: true }
      );
      document.body.append(dialog);
      dialog.showModal();
      activeDialog = dialog;
      close.focus();
    }

    function findingsForSubject(report, subject) {
      if (!report || !subject) return [];
      var findings = report.findings || [];
      if (subject.kind === 'bundle') {
        var pkg = subject.pkg || {};
        var modules = {};
        (pkg.rows || []).forEach(function (row) {
          if (row.moduleName) modules[row.moduleName] = true;
        });
        return findings.filter(function (finding) {
          if (finding.subject.kind === 'bundle' && finding.subject.bundle === pkg.name) return true;
          return finding.subject.kind === 'entry' && modules[finding.subject.moduleName] === true;
        });
      }
      if (subject.kind === 'row') {
        var row = subject.row || {};
        return findings.filter(function (finding) {
          return finding.subject.kind === 'entry' && finding.subject.moduleName === row.moduleName;
        });
      }
      if (subject.kind === 'item') {
        return findings.filter(function (finding) {
          return finding.subject.kind === 'entry' && finding.subject.entryId === subject.id;
        });
      }
      return [];
    }

    function worstSeverity(findings) {
      var worst = null;
      findings.forEach(function (finding) {
        if (worst === null || (SEVERITY_ORDER[finding.severity] || 0) > (SEVERITY_ORDER[worst] || 0)) worst = finding.severity;
      });
      return worst;
    }

    function severityBadge(findings) {
      if (findings.length === 0) return null;
      var severity = worstSeverity(findings);
      var titles = findings.map(function (finding) {
        return finding.title;
      }).join('\n');
      return React.createElement(
        'span',
        {
          title: titles,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            marginLeft: '8px',
            padding: '1px 9px',
            borderRadius: '999px',
            border: '1px solid ' + SEVERITY_COLOR[severity],
            color: SEVERITY_COLOR[severity],
            fontSize: '12px',
            lineHeight: '20px',
            whiteSpace: 'nowrap'
          }
        },
        React.createElement('span', {
          style: { width: '6px', height: '6px', borderRadius: '50%', background: SEVERITY_COLOR[severity] }
        }),
        '体检：' + findings.length + ' 项' + SEVERITY_LABEL[severity]
      );
    }

    function loadReport() {
      return fetch(BASE + '/api', { headers: { accept: 'application/json' } })
        .then(function (response) {
          return response.json();
        })
        .then(function (payload) {
          return payload && payload.ok === true ? payload.report : null;
        })
        .catch(function () {
          return null;
        });
    }

    function CheckupTab() {
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 4px' } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          React.createElement('strong', null, '插件体检'),
          React.createElement(
            'span',
            { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
            '读取宿主运行时注册表，对照组合包声明，找出失败、缺失、重复与未声明项。全程只读，不调用模型。'
          ),
          React.createElement('button', { type: 'button', onClick: openDialog }, '弹窗打开')
        ),
        React.createElement('iframe', {
          src: BASE + '?embedded=1',
          title: '插件运行时巡检',
          sandbox: 'allow-scripts allow-same-origin allow-downloads',
          style: {
            width: '100%',
            height: 'min(620px, 66vh)',
            border: '1px solid var(--dsw-alias-border-l2, #dcdce0)',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-1, Canvas)'
          }
        })
      );
    }

    function Overview(props) {
      var report = props.report;
      if (!report) return null;
      var counts = report.counts || { blocker: 0, warn: 0, info: 0 };
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            margin: '4px 0 10px',
            padding: '10px 12px',
            border: '1px solid var(--dsw-alias-border-l2, #dcdce0)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-module-platform, #f6f6f7)'
          }
        },
        React.createElement('strong', null, '插件体检'),
        React.createElement(
          'span',
          { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
          '阻断 ' + counts.blocker + ' · 警告 ' + counts.warn + ' · 提示 ' + counts.info
        ),
        React.createElement('button', { type: 'button', onClick: openDialog }, '打开巡检面板')
      );
    }

    function DetailBadge(props) {
      return severityBadge(findingsForSubject(props.report, props.subject));
    }

    function DetailSection(props) {
      var findings = findingsForSubject(props.report, props.subject);
      if (findings.length === 0) return null;
      var children = [
        React.createElement('div', { key: 'title', style: { fontWeight: 600, marginBottom: '6px' } }, '插件体检发现')
      ];
      findings.slice(0, 6).forEach(function (finding, index) {
        children.push(
          React.createElement(
            'div',
            { key: 'f' + index, style: { margin: '4px 0', color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
            React.createElement('span', { style: { color: SEVERITY_COLOR[finding.severity], marginRight: '6px' } }, '●'),
            finding.title + '　' + finding.rule + ' · 置信度 ' + finding.confidence
          )
        );
      });
      children.push(React.createElement('button', { key: 'open', type: 'button', onClick: openDialog }, '打开巡检面板'));
      return React.createElement('div', { style: { padding: '10px 0' } }, children);
    }

    function RowConfig() {
      return React.createElement(
        'div',
        { style: { padding: '12px 0' } },
        React.createElement('button', { type: 'button', onClick: openDialog }, '打开运行时巡检'),
        React.createElement(
          'p',
          { style: { margin: '6px 0 0', fontSize: '12px', opacity: 0.72 } },
          '读取实际加载的条目、工具与命令，对照组合包声明找出失败、缺失、重复与未声明项。全程只读。'
        )
      );
    }

    /** A conditional card badge: only bundles with findings get one. */
    function BundleBadge(props) {
      var findings = props.findings || [];
      if (findings.length === 0) return null;
      var severity = worstSeverity(findings);
      return React.createElement(
        'button',
        {
          type: 'button',
          title: findings.map(function (finding) { return finding.title; }).join('\n'),
          onClick: openDialog,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            marginRight: '8px',
            padding: '2px 9px',
            borderRadius: '999px',
            border: '1px solid ' + SEVERITY_COLOR[severity],
            background: 'transparent',
            color: SEVERITY_COLOR[severity],
            fontSize: '12px',
            lineHeight: '18px',
            cursor: 'pointer',
            whiteSpace: 'nowrap'
          }
        },
        '体检：' + findings.length + ' 项' + SEVERITY_LABEL[severity]
      );
    }

    return {
      name: 'plugin-checkup',
      inject: ['slots'],
      apply: function (ctx) {
        function registerSlot(name, options, component) {
          try {
            ctx.effect(function () {
              return ctx.slots.inject(name, function () {
                return ctx.slots.register(Object.assign({ name: name }, options), component);
              });
            });
          } catch (error) {
            // A slot this host version does not declare must not break the rest.
          }
        }

        return loadReport().then(function (report) {
          registerSlot('plugins.tab', { id: 'checkup', label: '体检', order: 60 }, CheckupTab);
          registerSlot('plugins.overview', { id: 'dsh-plugin-checkup#overview', order: 40 }, function () {
            return React.createElement(Overview, { report: report });
          });
          registerSlot('plugins.detail.badge', { id: 'dsh-plugin-checkup#badge', order: 40 }, function (props) {
            return React.createElement(DetailBadge, { report: report, subject: props && props.subject });
          });
          registerSlot('plugins.detail.section', { id: 'dsh-plugin-checkup#section', order: 40 }, function (props) {
            return React.createElement(DetailSection, { report: report, subject: props && props.subject });
          });
          registerSlot('plugins.row.config', { key: 'dsh-plugin-checkup#plugin-checkup', order: 40 }, RowConfig);

          // Card badges are conditional: a plugin card shows "体检：N 项" only
          // when that bundle actually has findings. Clean bundles get nothing.
          var bundles = report && report.inventory && Array.isArray(report.inventory.bundles) ? report.inventory.bundles : [];
          bundles.forEach(function (bundle) {
            if (!bundle || typeof bundle.name !== 'string') return;
            var findings = findingsForSubject(report, { kind: 'bundle', pkg: bundle });
            if (findings.length === 0) return;
            registerSlot('plugins.bundle.actions', { key: bundle.name, order: 40 }, function () {
              return React.createElement(BundleBadge, { findings: findings });
            });
          });
        });
      }
    };
  }
});

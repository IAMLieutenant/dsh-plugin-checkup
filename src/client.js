/**
 * Browser half: plugin-page surfaces for the runtime inspection.
 *
 * Data comes from the plugin's own read-only JSON endpoint. It is fetched once
 * at load; there is no polling timer. Badges are computed from that snapshot:
 *   plugins.detail.badge   → severity badge on a bundle/row/item detail page
 *   plugins.detail.section → evidence list for the same subject
 *   plugins.overview       → aggregate card on the plugins page
 *   plugins.bundle.actions → per-bundle button that opens the full page
 *
 * Hand-written bundle, no build step: window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-checkup',
  factory: function (require) {
    var React = require('react');
    var BASE = '/_dsh/plugin-checkup';
    var SEVERITY_ORDER = { blocker: 3, warn: 2, info: 1 };
    var SEVERITY_COLOR = { blocker: '#dc2626', warn: '#d97706', info: '#2563eb' };
    var SEVERITY_LABEL = { blocker: '阻断', warn: '警告', info: '提示' };

    function findingsForSubject(report, subject) {
      if (!report || !subject) return [];
      var findings = report.findings || [];
      if (subject.kind === 'bundle') {
        var pkg = subject.pkg || {};
        var modules = {};
        (pkg.rows || []).forEach(function (row) { if (row.moduleName) modules[row.moduleName] = true; });
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
      var titles = findings.map(function (finding) { return finding.title; }).join('\n');
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
        React.createElement('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: SEVERITY_COLOR[severity] } }),
        '体检：' + findings.length + ' 项' + SEVERITY_LABEL[severity]
      );
    }

    function DetailBadge(props) {
      var findings = findingsForSubject(props.report, props.subject);
      return severityBadge(findings);
    }

    function DetailSection(props) {
      var findings = findingsForSubject(props.report, props.subject);
      if (findings.length === 0) return null;
      var children = [
        React.createElement('div', { key: 'title', style: { fontWeight: 600, marginBottom: '6px' } }, '插件体检发现'),
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
      children.push(
        React.createElement(
          'button',
          { key: 'open', type: 'button', onClick: function () { window.open(BASE, '_blank', 'noopener'); } },
          '查看完整巡检'
        )
      );
      return React.createElement('div', { style: { padding: '10px 0' } }, children);
    }

    function Overview(props) {
      var report = props.report;
      if (!report) return null;
      var counts = report.counts || { blocker: 0, warn: 0, info: 0 };
      return React.createElement(
        'div',
        { style: { padding: '8px 0', display: 'flex', alignItems: 'center', gap: '12px' } },
        React.createElement('strong', null, '插件体检'),
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
          '阻断 ' + counts.blocker + ' · 警告 ' + counts.warn + ' · 提示 ' + counts.info),
        React.createElement('button', { type: 'button', onClick: function () { window.open(BASE, '_blank', 'noopener'); } }, '打开巡检')
      );
    }

    function BundleAction() {
      return React.createElement(
        'button',
        { type: 'button', onClick: function () { window.open(BASE, '_blank', 'noopener'); } },
        '体检'
      );
    }

    function loadReport() {
      return fetch(BASE + '/api', { headers: { accept: 'application/json' } })
        .then(function (response) { return response.json(); })
        .then(function (payload) { return payload && payload.ok === true ? payload.report : null; })
        .catch(function () { return null; });
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
            // A slot that this host version does not declare must not break the rest.
          }
        }

        return loadReport().then(function (report) {
          registerSlot('plugins.detail.badge', { id: 'dsh-plugin-checkup#badge', order: 40 }, function (props) {
            return React.createElement(DetailBadge, { report: report, subject: props && props.subject });
          });
          registerSlot('plugins.detail.section', { id: 'dsh-plugin-checkup#section', order: 40 }, function (props) {
            return React.createElement(DetailSection, { report: report, subject: props && props.subject });
          });
          registerSlot('plugins.overview', { id: 'dsh-plugin-checkup#overview', order: 40 }, function () {
            return React.createElement(Overview, { report: report });
          });
          registerSlot('plugins.row.config', { key: 'dsh-plugin-checkup#plugin-checkup', order: 40 }, function () {
            return React.createElement(
              'div',
              { style: { padding: '12px 0' } },
              React.createElement('button', { type: 'button', onClick: function () { window.open(BASE, '_blank', 'noopener'); } }, '打开运行时巡检'),
              React.createElement(
                'p',
                { style: { margin: '6px 0 0', fontSize: '12px', opacity: 0.72 } },
                '列出实际加载的插件条目、模型可见的工具与命令，对照组合包声明找出未声明、未生效与失败的插件。全程只读。'
              )
            );
          });
          (report && report.inventory && Array.isArray(report.inventory.bundles) ? report.inventory.bundles : []).forEach(function (bundle) {
            if (!bundle || typeof bundle.name !== 'string') return;
            registerSlot('plugins.bundle.actions', { key: bundle.name, order: 40 }, function () {
              return React.createElement(BundleAction);
            });
          });
        });
      }
    };
  }
});

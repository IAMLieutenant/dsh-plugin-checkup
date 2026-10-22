/**
 * Report assembly + Markdown export. Pure: facts in, report out.
 */

import { countBySeverity } from './rules.js';

/**
 * @param {any} facts
 * @param {import('./rules.js').Finding[]} findings
 * @param {{ baseline?: any }} [options]
 */
export function buildReport(facts, findings, options = {}) {
  const counts = countBySeverity(findings);
  return {
    schemaVersion: 2,
    generatedAt: facts.generatedAt,
    profile: {
      dir: facts.profileDir ?? null,
      bundles: facts.profileManifest?.bundles ?? [],
    },
    counts,
    findings,
    inventory: {
      entries: facts.entries ?? [],
      bundles: facts.bundles ?? [],
      plugins: facts.plugins ?? [],
      tools: facts.tools ?? { available: false, items: [] },
      commands: facts.commands ?? { available: false, items: [] },
      recent: facts.recent ?? [],
      attribution: facts.attribution ?? null,
    },
    ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    warnings: facts.warnings ?? [],
    meta: {
      layer: 'L2-runtime',
      readOnly: true,
      modelCalls: 0,
      networkCalls: 0,
    },
  };
}

const SEVERITY_LABEL = { blocker: '阻断', warn: '警告', info: '提示' };

/** @param {any} report */
export function toMarkdown(report) {
  const lines = [];
  lines.push('# DSH 插件运行时巡检报告');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 检测层：${report.meta.layer}（运行时事实，只读，未调用模型）`);
  if (report.profile.dir) lines.push(`- Profile：\`${report.profile.dir}\``);
  lines.push('');
  lines.push(
    `**汇总**：阻断 ${report.counts.blocker} · 警告 ${report.counts.warn} · 提示 ${report.counts.info} · ` +
      `运行时条目 ${report.inventory.entries.length} · 组合包 ${report.inventory.bundles.length}`,
  );
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('未发现问题。');
  } else {
    lines.push('## 发现');
    lines.push('');
    for (const finding of report.findings) {
      const where =
        finding.subject.kind === 'entry'
          ? `条目 ${finding.subject.entryId ?? ''} ${finding.subject.moduleName ?? ''}`.trim()
          : finding.subject.kind === 'bundle'
            ? `组合包 ${finding.subject.bundle ?? ''}`
            : 'profile';
      lines.push(`### [${SEVERITY_LABEL[finding.severity]}] ${finding.title}`);
      lines.push('');
      lines.push(`- 规则：\`${finding.rule}\`（置信度 ${finding.confidence}，来源 ${finding.source}）`);
      lines.push(`- 对象：${where}`);
      lines.push(`- 说明：${finding.detail}`);
      for (const evidence of finding.evidence) {
        lines.push(`- 证据：${evidence.kind === 'file' ? '文件' : '运行时'} \`${evidence.ref}\`${evidence.pointer ? ` @ ${evidence.pointer}` : ''}`);
      }
      for (const fix of finding.fix ?? []) lines.push(`- 建议：${fix.label}`);
      lines.push('');
    }
  }
  if (report.warnings.length > 0) {
    lines.push('## 采集告警');
    lines.push('');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  lines.push('## 运行时条目');
  lines.push('');
  lines.push('| entry id | module | 启用 | 阶段 |');
  lines.push('|---|---|---|---|');
  for (const entry of report.inventory.entries) {
    lines.push(`| \`${entry.entryId}\` | \`${entry.moduleName}\` | ${entry.enabled ? '是' : '否'} | ${entry.phase ?? '—'} |`);
  }
  lines.push('');

  const attribution = report.inventory.attribution;
  if (attribution) {
    lines.push('## 工具来源归因');
    lines.push('');
    lines.push(`扫描 ${attribution.scanned.length} 个包、${attribution.bytes} 字节构建产物。`);
    lines.push('');
    lines.push('| 工具 | 来源包 |');
    lines.push('|---|---|');
    for (const [name, owners] of Object.entries(attribution.tools ?? {})) {
      lines.push(`| \`${name}\` | ${owners.join('、')} |`);
    }
    lines.push('');
  }

  if (report.baseline && report.baseline.exists) {
    lines.push('## 相对基线的变化');
    lines.push('');
    lines.push(`基线记录于 ${report.baseline.recordedAt}`);
    lines.push('');
    if (report.baseline.empty) {
      lines.push('无变化。');
    } else {
      const sections = [
        ['条目', report.baseline.entries, (item) => item],
        ['工具', report.baseline.tools, (item) => item],
        ['命令', report.baseline.commands, (item) => item],
        ['组合包', report.baseline.bundles, (item) => item],
      ];
      for (const [label, diff, format] of sections) {
        if (diff.added.length === 0 && diff.removed.length === 0) continue;
        if (diff.added.length > 0) lines.push(`- ${label}新增：${diff.added.map(format).join('、')}`);
        if (diff.removed.length > 0) lines.push(`- ${label}消失：${diff.removed.map(format).join('、')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Rules: turn runtime facts into findings.
 *
 * Design constraints (keep them when extending):
 *   1. Pure functions: no fs, no network, no ctx — trivially unit-testable.
 *   2. Every finding carries evidence (runtime reference or file path).
 *   3. No false confidence: when a rule cannot attribute an owner, it says so
 *      (`confidence: 'medium'`) instead of guessing.
 *   4. `source: 'runtime'` marks L2 facts (what the host actually registered),
 *      as opposed to L1 declarative facts.
 */

/**
 * @typedef {object} Finding
 * @property {string} rule
 * @property {'blocker'|'warn'|'info'} severity
 * @property {{kind: 'entry'|'bundle'|'profile', entryId?: string, moduleName?: string, bundle?: string}} subject
 * @property {string} title
 * @property {string} detail
 * @property {Array<{kind: 'runtime'|'file', ref: string, pointer?: string}>} evidence
 * @property {Array<{kind: string, label: string}>} [fix]
 * @property {'high'|'medium'|'low'} confidence
 * @property {'runtime'} source
 */

/** @param {string} moduleName */
function isModuleLike(moduleName) {
  return moduleName !== '' && (moduleName.includes('/') || moduleName.startsWith('dsh') || moduleName.startsWith('@'));
}

/**
 * Official core rows are mounted by the host's base bundle, which is not part of
 * `pluginManager.listBundles()`. Treating them as "undeclared" would flood the
 * report with false positives, so they are excluded from that rule by design.
 * @param {string} moduleName
 */
function isOfficialCore(moduleName) {
  return moduleName.startsWith('@deepseek-ai/') || moduleName.startsWith('cordis:') || moduleName.startsWith('cordis-');
}

/** Tools shipped by the official host; they have no package entry in the profile. */
const OFFICIAL_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'terminal',
  'web_search', 'web_fetch', 'skill', 'todo_write', 'ask_user_question', 'present',
  'job_list', 'job_output', 'job_kill', 'subagent', 'subagent_fork',
  'list_agents', 'send_message', 'interrupt_agent', 'spawn_teammate', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'goal_get', 'goal_create', 'goal_update', 'get_goal', 'create_goal', 'update_goal',
  'workflow', 'run_code', 'load_workspace_dependencies', 'working_directory',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query',
]);

/**
 * @param {any} facts
 * @returns {Finding[]}
 */
export function evaluate(facts) {
  const findings = [];
  const entries = Array.isArray(facts?.entries) ? facts.entries : [];
  const bundles = Array.isArray(facts?.bundles) ? facts.bundles : [];
  const plugins = Array.isArray(facts?.plugins) ? facts.plugins : [];

  // ── declared rows, keyed by module and by entry id ───────────────────────
  // Only bundles active in this profile contribute declarations. The catalog
  // lists every shipped/optional bundle, most with enabled:false, and their
  // rows would otherwise look like phantom duplicate declarations.
  const activeBundles = bundles.filter((bundle) => bundle?.enabled !== false);

  /** @type {Map<string, Array<{bundle: string, rowId: string, entryId?: string}>>} */
  const declaredByModule = new Map();
  /** @type {Map<string, string[]>} */
  const declaredByEntryId = new Map();
  for (const bundle of activeBundles) {
    for (const row of Array.isArray(bundle?.rows) ? bundle.rows : []) {
      const moduleName = typeof row?.moduleName === 'string' ? row.moduleName : '';
      if (moduleName !== '') {
        if (!declaredByModule.has(moduleName)) declaredByModule.set(moduleName, []);
        declaredByModule.get(moduleName).push({
          bundle: String(bundle?.name ?? ''),
          rowId: String(row?.rowId ?? ''),
          ...(row?.entryId === undefined ? {} : { entryId: String(row.entryId) }),
        });
      }
      if (row?.entryId !== undefined && row?.entryId !== null) {
        const id = String(row.entryId);
        if (!declaredByEntryId.has(id)) declaredByEntryId.set(id, []);
        declaredByEntryId.get(id).push(String(bundle?.name ?? ''));
      }
    }
  }

  // ── R1: Loader 不可用（无法判断任何运行时事实） ───────────────────────────
  if (facts?.loaderAvailable === false) {
    findings.push({
      rule: 'loader-unavailable',
      severity: 'warn',
      subject: { kind: 'profile' },
      title: '无法读取 Loader 运行时条目',
      detail: '宿主未暴露 ctx.loader.entries()，本页只能展示插件声明，无法对照"实际加载了什么"。',
      evidence: [{ kind: 'runtime', ref: 'ctx.loader.entries()' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R2: 运行时加载失败的条目 ─────────────────────────────────────────────
  for (const entry of entries) {
    if (entry.phase !== 'failed') continue;
    findings.push({
      rule: 'failed-entry',
      severity: 'blocker',
      subject: { kind: 'entry', entryId: entry.entryId, moduleName: entry.moduleName },
      title: `插件加载失败：${entry.meta?.title ?? (entry.moduleName || entry.entryId)}`,
      detail: `Loader 条目标记为 failed。它会静默缺失全部能力（工具/界面/提示词），通常不会在界面上报错。${entry.enabled ? '' : '（该条目当前处于禁用状态）'}`,
      evidence: [{ kind: 'runtime', ref: `loader entry ${entry.entryId}`, pointer: 'fiberPhase=failed' }],
      fix: [{ kind: 'manual', label: '在插件页禁用该行后重启，确认是否恢复' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R3: 同一模块被多个条目加载（重复实例） ────────────────────────────────
  /** @type {Map<string, any[]>} */
  const byModule = new Map();
  for (const entry of entries) {
    if (entry.moduleName === '' || entry.enabled === false) continue;
    if (!byModule.has(entry.moduleName)) byModule.set(entry.moduleName, []);
    byModule.get(entry.moduleName).push(entry);
  }
  for (const [moduleName, group] of byModule) {
    if (group.length < 2) continue;
    if (isOfficialCore(moduleName)) continue;
    findings.push({
      rule: 'duplicate-module',
      severity: 'warn',
      subject: { kind: 'entry', moduleName },
      title: `同一模块被 ${group.length} 个条目加载：${moduleName}`,
      detail: `运行时存在 ${group.length} 个启用的条目的 moduleName 相同（${group.map((item) => item.entryId).join('、')}）。同一模块被加载多次可能产生重复的服务注册、重复的界面元素或状态不同步；也可能只是合法的多实例配置，请人工确认。`,
      evidence: group.map((item) => ({ kind: 'runtime', ref: `loader entry ${item.entryId}`, pointer: moduleName })),
      confidence: 'medium',
      source: 'runtime',
    });
  }

  // ── R4: 声明了但是运行时不存在 ────────────────────────────────────────────
  const runtimeModules = new Set(entries.filter((entry) => entry.enabled !== false && entry.moduleName !== '').map((entry) => entry.moduleName));
  for (const [moduleName, owners] of declaredByModule) {
    if (runtimeModules.has(moduleName)) continue;
    const ownerNames = [...new Set(owners.map((owner) => owner.bundle))];
    // 只对"已安装且启用"的 bundle 报告；缺失/禁用的由 R5 处理
    const relevant = bundles.filter(
      (bundle) => ownerNames.includes(String(bundle?.name ?? '')) && bundle?.enabled !== false && bundle?.installed === true,
    );
    if (relevant.length === 0) continue;
    findings.push({
      rule: 'declared-but-missing',
      severity: 'warn',
      subject: { kind: 'bundle', bundle: ownerNames[0], moduleName },
      title: `声明了但未加载：${moduleName}`,
      detail: `插件 ${ownerNames.join('、')} 的组合声明里包含这一行，但运行时没有对应的启用条目。常见原因：加载失败后被移除（在禁用状态下静默）、HMR 尚未生效、或该行被 profile 的 patch 覆盖。`,
      evidence: [
        { kind: 'runtime', ref: 'loader.entries()', pointer: `缺少 moduleName=${moduleName}` },
        { kind: 'runtime', ref: 'pluginManager.listBundles()', pointer: `bundle=${ownerNames.join(',')}` },
      ],
      fix: [{ kind: 'manual', label: '在插件页重新启用该插件或重启 DSH' }],
      confidence: 'medium',
      source: 'runtime',
    });
  }

  // ── R5: 包不可读 ─────────────────────────────────────────────────────────
  for (const bundle of bundles) {
    if (bundle?.availability !== 'missing') continue;
    // Optional/on-demand bundles that were never installed are simply absent,
    // not broken: only a profile-declared dependency can be genuinely missing.
    if (bundle?.installed !== true) continue;
    findings.push({
      rule: 'package-missing',
      severity: 'blocker',
      subject: { kind: 'bundle', bundle: String(bundle?.name ?? '') },
      title: `插件包缺失：${bundle?.name}`,
      detail: 'profile 声明了这个组合包，但它的安装文件不可读（通常是安装中断、手动删除 node_modules 或 pnpm 链接失效）。该插件的全部条目都无法加载。',
      evidence: [{ kind: 'runtime', ref: `pluginManager.listBundles(): ${bundle?.name}`, pointer: 'availability=missing' }],
      fix: [{ kind: 'manual', label: '重新安装该插件，或从 profile 中移除它' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R6: 版本不兼容（安装期已拒绝的那个结果，运行时可复核） ────────────────
  for (const bundle of bundles) {
    if (bundle?.error?.code !== 'incompatible-version') continue;
    const requirements = bundle.error?.incompatible ?? [];
    const detail = Array.isArray(requirements) && requirements.length > 0
      ? requirements
          .map((item) => {
            const unmet = Object.entries(item?.requirements ?? {})
              .map(([key, value]) => `${key} ${String(value)}`)
              .join('、');
            return `${item?.name}@${item?.version}（要求 ${unmet}，当前 DSH ${item?.runtimeVersion}）`;
          })
          .join('；')
      : '插件声明的 DSH 版本或 peer 版本与当前运行时不匹配。';
    findings.push({
      rule: 'incompatible-version',
      severity: 'blocker',
      subject: { kind: 'bundle', bundle: String(bundle?.name ?? '') },
      title: `版本不兼容：${bundle?.name}`,
      detail: `宿主已经拒绝了这次安装/加载：${detail}`,
      evidence: [{ kind: 'runtime', ref: `pluginManager.listBundles(): ${bundle?.name}`, pointer: 'error.code=incompatible-version' }],
      fix: [{ kind: 'manual', label: '升级插件到兼容版本；确实要冒险时使用 dsh plugin allow-version' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R7: 运行时存在但没有任何声明（"野条目"） ─────────────────────────────
  if (facts?.managementAvailable === true) {
    for (const entry of entries) {
      if (entry.enabled === false || !isModuleLike(entry.moduleName)) continue;
      if (isOfficialCore(entry.moduleName)) continue;
      if (declaredByModule.has(entry.moduleName)) continue;
      findings.push({
        rule: 'undeclared-entry',
        severity: 'warn',
        subject: { kind: 'entry', entryId: entry.entryId, moduleName: entry.moduleName },
        title: `未被任何组合包声明：${entry.moduleName}`,
        detail: `这个条目正在运行，但当前 profile 的插件组合里找不到它的声明行。来源可能是 profile 自己的 cordis.patch.yml 手工插入、agent preset、或卸载后残留。它同样会注册工具/界面，属于"看不见的插件"。`,
        evidence: [
          { kind: 'runtime', ref: `loader entry ${entry.entryId}` },
          { kind: 'runtime', ref: 'pluginManager.listBundles().rows', pointer: '未找到该 moduleName' },
        ],
        confidence: 'medium',
        source: 'runtime',
      });
    }
  }

  // ── R8: 同一条目被两个组合包声明（Loader 只会保留一个） ───────────────────
  for (const [entryId, owners] of declaredByEntryId) {
    const unique = [...new Set(owners)];
    if (unique.length < 2) continue;
    // Core include rows are shared by design across layer bundles, and two
    // official bundles may legitimately address the same built-in row.
    if (entryId.startsWith('include:')) continue;
    if (unique.every((owner) => owner.startsWith('@deepseek-ai/'))) continue;
    findings.push({
      rule: 'duplicate-declaration',
      severity: 'warn',
      subject: { kind: 'entry', entryId },
      title: `同一 entry id 被多个组合包声明：${entryId}`,
      detail: `组合包 ${unique.join('、')} 都声明了条目 ${entryId}。Loader 会静默保留其中一个（后者覆盖前者），另一个插件的这一行不会生效，界面上也不会报错。`,
      evidence: unique.map((owner) => ({ kind: 'runtime', ref: `pluginManager.listBundles(): ${owner}`, pointer: `entryId=${entryId}` })),
      confidence: 'medium',
      source: 'runtime',
    });
  }

  // ── R9: 只读/不可管理的条目（信息） ──────────────────────────────────────
  const unmanaged = plugins.filter((plugin) => typeof plugin?.readOnlyReason === 'string');
  if (unmanaged.length > 0) {
    const reasons = [...new Set(unmanaged.map((plugin) => plugin.readOnlyReason))];
    findings.push({
      rule: 'unmanaged-entries',
      severity: 'info',
      subject: { kind: 'profile' },
      title: `${unmanaged.length} 个条目无法在此 profile 中管理`,
      detail: `这些条目带 readOnlyReason（${reasons.join('、')}），插件页无法直接启停它们；排查时需要通过组合包或 profile 配置处理。`,
      evidence: [{ kind: 'runtime', ref: 'pluginManager.listPlugins()', pointer: 'readOnlyReason' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R10: 工具名与命令名撞名（信息） ─────────────────────────────────────
  const toolNames = new Set((facts?.tools?.items ?? []).map((item) => item.name));
  const collided = (facts?.commands?.items ?? []).map((item) => item.name).filter((name) => toolNames.has(name));
  if (collided.length > 0) {
    findings.push({
      rule: 'namespace-collision',
      severity: 'info',
      subject: { kind: 'profile' },
      title: `工具与斜杠命令同名：${collided.join('、')}`,
      detail: '同名项分别位于工具命名空间与命令命名空间，通常不会直接冲突，但会让人（和模型）在描述里产生歧义，值得插件作者统一命名。',
      evidence: [{ kind: 'runtime', ref: 'ctx.tools.schemas() / ctx.commands.list()' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R11: 降级运行提示 ───────────────────────────────────────────────────
  if (facts?.managementAvailable === false && facts?.loaderAvailable !== false) {
    findings.push({
      rule: 'degraded-mode',
      severity: 'info',
      subject: { kind: 'profile' },
      title: '仅运行时模式：无法对照插件声明',
      detail: '当前宿主没有可用的 pluginManager，本页只列出实际加载的条目，无法判断"哪些是未声明的"。这通常发生在非桌面/非 web profile 的组合里。',
      evidence: [{ kind: 'runtime', ref: 'ctx.get("pluginManager")' }],
      confidence: 'high',
      source: 'runtime',
    });
  }

  // ── R12: 工具来源归因（扫描已装包后的反查结果） ──────────────────────────
  const attribution = facts?.attribution;
  if (attribution && facts?.tools?.available === true) {
    for (const tool of facts.tools.items ?? []) {
      if (OFFICIAL_TOOL_NAMES.has(tool.name)) continue;
      if (Array.isArray(attribution.tools?.[tool.name]) && attribution.tools[tool.name].length > 0) continue;
      findings.push({
        rule: 'unattributed-tool',
        severity: 'warn',
        subject: { kind: 'profile' },
        title: `未找到注册来源的工具：${tool.name}`,
        detail:
          '这个工具在运行时对模型可见，但已安装插件的构建产物里没有找到它的注册声明。可能来自动态拼装的名称、未扫描到的目录，或由某个插件在代码里直接注册而没有独立声明。请对照插件清单人工确认。',
        evidence: [
          { kind: 'runtime', ref: `ctx.tools.schemas(): ${tool.name}` },
          { kind: 'file', ref: 'profile/node_modules/*/{lib,dist,src}', pointer: 'defineTool({ name }) 扫描' },
        ],
        confidence: 'medium',
        source: 'runtime',
      });
    }

    for (const [name, owners] of Object.entries(attribution.tools ?? {})) {
      if (owners.length < 2) continue;
      findings.push({
        rule: 'tool-multi-source',
        severity: 'info',
        subject: { kind: 'profile' },
        title: `同名工具在多个包中出现：${name}`,
        detail: `扫描到 ${owners.join('、')} 都声明了工具名 ${name}。运行时只保留最后注册的那一个，另一个会静默失效。若这是两个不同插件，属于命名冲突。`,
        evidence: owners.map((owner) => ({ kind: 'file', ref: `node_modules/${owner}`, pointer: `defineTool({ name: '${name}' })` })),
        confidence: 'medium',
        source: 'runtime',
      });
    }
  }

  // ── R13: 命令来源归因 ───────────────────────────────────────────────────
  if (attribution && facts?.commands?.available === true) {
    for (const [name, owners] of Object.entries(attribution.commands ?? {})) {
      if (owners.length < 2) continue;
      findings.push({
        rule: 'command-multi-source',
        severity: 'info',
        subject: { kind: 'profile' },
        title: `同名斜杠命令在多个包中出现：/${name}`,
        detail: `扫描到 ${owners.join('、')} 都声明了命令 ${name}。同一作用域内重复注册同名命令会抛错，不同作用域则互相遮蔽；出现多个来源时值得确认谁在生效。`,
        evidence: owners.map((owner) => ({ kind: 'file', ref: `node_modules/${owner}`, pointer: `commands.register({ name: '${name}' })` })),
        confidence: 'medium',
        source: 'runtime',
      });
    }
  }

  return findings;
}

/** @param {Finding[]} findings */
export function countBySeverity(findings) {
  const counts = { blocker: 0, warn: 0, info: 0, total: findings.length };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

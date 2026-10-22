/**
 * Probe: collect runtime facts from the host process.
 *
 * L2 = "ask the host what is actually registered", never "read plugin source".
 * Every fact below comes from an official runtime seam:
 *   - ctx.loader.entries()            → real Loader rows (incl. hidden inserts)
 *   - ctx.get('pluginManager')        → profile bundles/rows + install diagnostics
 *   - ctx.get('profileContext')       → current profile directory
 *   - ctx.get('tools').schemas()      → tools actually visible to models
 *   - ctx.get('commands').list()      → slash commands actually registered
 *
 * The probe is defensive: every seam is optional and every failure is reported
 * in `warnings` instead of breaking the page.
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Cordis Fiber state → public phase vocabulary (mirrors @deepseek-ai/dsh-host-plugin-inventory). */
const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', null, 'unloading'];

/** @param {unknown} fiber */
export function phaseOf(fiber) {
  if (fiber === undefined || fiber === null) return null;
  const state = typeof fiber === 'object' ? /** @type {{state?: unknown}} */ (fiber).state : fiber;
  if (typeof state === 'number') return FIBER_PHASE[state] ?? null;
  if (typeof state === 'string') return state === 'disposed' ? null : state;
  return null;
}

/** @param {any} ctx @param {string} name */
function safeGet(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/** @param {(value: any) => any} read */
function attempt(read) {
  try {
    return { available: true, value: read() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {any} ctx
 * @param {{ now?: Date }} [options]
 */
export async function collectFacts(ctx, options = {}) {
  const warnings = [];
  const generatedAt = (options.now ?? new Date()).toISOString();

  // ── 1. Loader rows ────────────────────────────────────────────────────────
  /** @type {Array<{entryId: string, moduleName: string, enabled: boolean, phase: string|null, baseUrl?: string, meta?: any}>} */
  const entries = [];
  let loaderAvailable = true;
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry?.options?.group) continue;
      const baseUrl = entry?.parent?.tree?.ctx?.baseUrl;
      const moduleName = String(entry?.options?.name ?? '');
      let meta;
      try {
        const packages = safeGet(ctx, 'pluginPackages');
        if (packages?.metaOf && baseUrl !== undefined) {
          meta = packages.metaOf(moduleName, baseUrl);
        }
      } catch {
        // display metadata is optional
      }
      entries.push({
        entryId: String(entry?.id ?? ''),
        moduleName,
        enabled: !entry?.disabled,
        phase: phaseOf(entry?.fiber),
        ...(baseUrl === undefined ? {} : { baseUrl: String(baseUrl) }),
        ...(meta === undefined ? {} : { meta }),
      });
    }
  } catch (error) {
    loaderAvailable = false;
    warnings.push(`ctx.loader.entries() 不可用：${error instanceof Error ? error.message : String(error)}`);
  }

  // ── 2. Profile + plugin manager ───────────────────────────────────────────
  const profileContext = safeGet(ctx, 'profileContext');
  const profileDir = typeof profileContext?.dir === 'string' ? profileContext.dir : undefined;

  const manager = safeGet(ctx, 'pluginManager');
  let managementAvailable = false;
  /** @type {any[]} */ let bundles = [];
  /** @type {any[]} */ let plugins = [];
  if (manager && typeof manager.listBundles === 'function' && typeof manager.listPlugins === 'function') {
    try {
      const [bundleList, pluginList] = await Promise.all([manager.listBundles(), manager.listPlugins()]);
      bundles = Array.isArray(bundleList) ? bundleList : [];
      plugins = Array.isArray(pluginList) ? pluginList : [];
      managementAvailable = true;
    } catch (error) {
      warnings.push(`pluginManager 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push('pluginManager 服务不可用：无法对照声明（仅展示运行时条目）');
  }

  // ── 3. Profile manifest (read-only) ───────────────────────────────────────
  /** @type {{bundles: string[], dependencies: Record<string, string>} | undefined} */
  let profileManifest;
  if (profileDir !== undefined) {
    try {
      const raw = await readFile(join(profileDir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw);
      profileManifest = {
        bundles: Array.isArray(parsed?.dsh?.profile?.bundles) ? parsed.dsh.profile.bundles.map(String) : [],
        dependencies:
          parsed?.dependencies && typeof parsed.dependencies === 'object' ? { ...parsed.dependencies } : {},
      };
    } catch (error) {
      warnings.push(`读取 profile package.json 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 4. Tools / commands actually registered ───────────────────────────────
  const tools = await bestEffortList('tools', () => {
    const service = safeGet(ctx, 'tools');
    if (!service?.schemas) throw new Error('tools.schemas() 不可用');
    const schemas = service.schemas(undefined);
    return (Array.isArray(schemas) ? schemas : []).map((schema) => ({
      name: String(schema?.name ?? ''),
      ...(typeof schema?.description === 'string' ? { description: schema.description } : {}),
    }));
  }, warnings);

  const commands = await bestEffortList('commands', () => {
    const service = safeGet(ctx, 'commands');
    if (!service?.list) throw new Error('commands.list() 不可用');
    const list = service.list(undefined);
    return (Array.isArray(list) ? list : []).map((command) => {
      const name = typeof command?.name === 'string' ? command.name : String(command?.name ?? '');
      return {
        name,
        ...(typeof command?.description === 'string' ? { description: command.description } : {}),
      };
    });
  }, warnings);

  // ── 5. Recent package changes (mtime heuristic, read-only) ────────────────
  const recent = await collectRecent(profileDir, profileManifest?.dependencies ?? {}, warnings);

  return {
    generatedAt,
    loaderAvailable,
    managementAvailable,
    ...(profileDir === undefined ? {} : { profileDir }),
    ...(profileManifest === undefined ? {} : { profileManifest }),
    entries,
    bundles,
    plugins,
    tools,
    commands,
    recent,
    warnings,
  };
}

/** @param {string} label @param {() => any[]} read @param {string[]} warnings */
async function bestEffortList(label, read, warnings) {
  try {
    return { available: true, items: read() };
  } catch (error) {
    warnings.push(`${label} 枚举失败（该宿主版本未暴露可枚举接口）：${error instanceof Error ? error.message : String(error)}`);
    return { available: false, items: [] };
  }
}

/** @param {string|undefined} profileDir @param {Record<string,string>} dependencies @param {string[]} warnings */
async function collectRecent(profileDir, dependencies, warnings) {
  if (profileDir === undefined) return [];
  const names = Object.keys(dependencies);
  const out = [];
  for (const name of names.slice(0, 200)) {
    const manifestPath = join(profileDir, 'node_modules', name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const info = await stat(manifestPath);
      out.push({ name, version: dependencies[name], modifiedAt: info.mtime.toISOString() });
    } catch {
      // ignore per-package stat failures
    }
  }
  out.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : -1));
  return out.slice(0, 8);
}

/**
 * Static attribution: which installed package declares which tool / command / slot.
 *
 * Why this exists: the runtime registries expose WHAT is registered but not WHO
 * registered it. Names are declared in the plugin's own distribution files
 * (`defineTool({ name: ... })`, `commands.register({ name: ... })`,
 * `slots.register({ name: ... })`), so a bounded read-only scan of installed
 * packages can map runtime names back to their likely source.
 *
 * Limits are deliberate: only built JS/TS candidates, bounded file count and
 * bytes, regex over string literals. A name that appears only through computed
 * keys stays unattributed, and the report says so instead of guessing.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const TOOL_PATTERN = /defineTool\s*\(\s*\{[\s\S]{0,600}?\bname\s*:\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g;
const COMMAND_PATTERN = /commands\.register\s*\(\s*\{[\s\S]{0,400}?\bname\s*:\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g;
const SLOT_PATTERN = /slots\.register\s*\(\s*\{[\s\S]{0,400}?\bname\s*:\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g;

const CANDIDATE_DIRS = ['lib', 'dist', 'build', 'src'];
const CANDIDATE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

/** @param {string} dir @param {number} limit @returns {Promise<string[]>} */
async function listCandidateFiles(dir, limit) {
  /** @type {string[]} */
  const files = [];
  const queue = [{ path: dir, depth: 0 }];
  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const full = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 2 && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push({ path: full, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (CANDIDATE_EXTENSIONS.has(extension)) files.push(full);
      }
    }
  }
  return files;
}

/** @param {Map<string, Set<string>>} map @param {string} name @param {string} owner */
function remember(map, name, owner) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(owner);
}

/** @param {Map<string, Set<string>>} map */
function toObject(map) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [name, owners] of map) out[name] = [...owners].sort();
  return out;
}

/**
 * @param {string} profileDir
 * @param {string[]} packageNames
 * @param {{ maxFilesPerPackage?: number, maxFileBytes?: number, maxTotalBytes?: number }} [options]
 */
export async function scanRegistrations(profileDir, packageNames, options = {}) {
  const maxFilesPerPackage = options.maxFilesPerPackage ?? 40;
  const maxFileBytes = options.maxFileBytes ?? 1_500_000;
  const maxTotalBytes = options.maxTotalBytes ?? 8_000_000;

  /** @type {Map<string, Set<string>>} */ const tools = new Map();
  /** @type {Map<string, Set<string>>} */ const commands = new Map();
  /** @type {Map<string, Set<string>>} */ const slots = new Map();
  /** @type {Array<{package: string, files: number}>} */ const scanned = [];
  /** @type {string[]} */ const warnings = [];
  let totalBytes = 0;

  for (const packageName of packageNames) {
    if (totalBytes >= maxTotalBytes) {
      warnings.push(`扫描预算用尽，剩余包未扫描：${packageNames.slice(packageNames.indexOf(packageName)).join('、')}`);
      break;
    }
    const packageDir = join(profileDir, 'node_modules', packageName);
    try {
      const info = await stat(packageDir);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    const files = await listCandidateFiles(packageDir, maxFilesPerPackage);
    let read = 0;
    for (const file of files) {
      if (totalBytes >= maxTotalBytes) break;
      let fileInfo;
      try {
        fileInfo = await stat(file);
      } catch {
        continue;
      }
      if (!fileInfo.isFile() || fileInfo.size > maxFileBytes) continue;
      if (totalBytes + fileInfo.size > maxTotalBytes) break;
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      totalBytes += fileInfo.size;
      read += 1;
      for (const match of text.matchAll(TOOL_PATTERN)) remember(tools, match[1], packageName);
      for (const match of text.matchAll(COMMAND_PATTERN)) remember(commands, match[1], packageName);
      for (const match of text.matchAll(SLOT_PATTERN)) remember(slots, match[1], packageName);
    }
    scanned.push({ package: packageName, files: read });
  }

  return {
    tools: toObject(tools),
    commands: toObject(commands),
    slots: toObject(slots),
    scanned,
    bytes: totalBytes,
    warnings,
  };
}

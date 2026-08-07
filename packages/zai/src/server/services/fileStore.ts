import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ConfigFile, ConfigTool } from '../../shared/types.js';

const CONFIG_PATHS: Record<ConfigTool, () => string> = {
  nova: () => join(homedir(), '.nova', 'settings.json'),
  opencode: () => join(homedir(), '.config', 'opencode', 'opencode.json'),
  opencc: () => join(homedir(), '.zai', 'settings.json'),
  zai: () => join(homedir(), '.zai', 'settings.json'),
};

// 顶层 JSON 配置文件直读直写 — 与 readConfig/writeConfig 同语义
// (返回 ConfigFile、缺失返回 missing:true、写走 tmp+rename 原子),
// 但不走 ConfigTool 枚举(这两个文件不在用户视角的"工具"分类里)。
// 注:`~/.zai.json` 仍由 mcpConfig.ts 单独读取,不在此处暴露 UI。
const TOP_LEVEL_JSON_PATHS: Record<TopLevelJsonKey, () => string> = {
  'claude-json': () => join(homedir(), '.claude.json'),
  'claude-settings': () => join(homedir(), '.claude', 'settings.json'),
};

export type TopLevelJsonKey = 'claude-json' | 'claude-settings';

export async function readTopLevelJson(key: TopLevelJsonKey): Promise<ConfigFile> {
  const path = TOP_LEVEL_JSON_PATHS[key]();
  try {
    const raw = await readFile(path, 'utf-8');
    return { path, exists: true, content: JSON.parse(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: {}, missing: true };
    }
    throw err;
  }
}

export async function writeTopLevelJson(
  key: TopLevelJsonKey,
  content: Record<string, unknown>,
): Promise<{ ok: true }> {
  const path = TOP_LEVEL_JSON_PATHS[key]();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
  await rename(tmpPath, path);
  return { ok: true };
}

export async function readConfig(tool: ConfigTool): Promise<ConfigFile> {
  const path = CONFIG_PATHS[tool]();
  try {
    const raw = await readFile(path, 'utf-8');
    return { path, exists: true, content: JSON.parse(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: {}, missing: true };
    }
    throw err;
  }
}

export async function writeConfig(
  tool: ConfigTool,
  content: Record<string, unknown>,
): Promise<{ ok: true }> {
  const path = CONFIG_PATHS[tool]();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
  await rename(tmpPath, path);
  return { ok: true };
}

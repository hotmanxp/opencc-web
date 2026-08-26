import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentsMdFile, ConfigFile, ConfigTool } from '../../shared/types.js';

const CONFIG_PATHS: Record<ConfigTool, () => string> = {
  nova: () => join(homedir(), '.nova', 'settings.json'),
  opencode: () => join(homedir(), '.config', 'opencode', 'opencode.json'),
  opencc: () => join(homedir(), '.zai', 'settings.json'),
  zai: () => join(homedir(), '.zai', 'settings.json'),
};

// 顶层 JSON 配置文件直读直写 — 与 readConfig/writeConfig 同语义
// (返回 ConfigFile、缺失返回 missing:true、写走 tmp+rename 原子),
// 但不走 ConfigTool 枚举(这些文件不在用户视角的"工具"分类里)。
// - ~/.zai.json 也由 mcpConfig.ts 读取,UI 通过 /config/zai-json 暴露读写;
//   mcpConfig 的字段过滤逻辑独立维护,不依赖本模块。
const TOP_LEVEL_JSON_PATHS: Record<TopLevelJsonKey, () => string> = {
  'claude-json': () => join(homedir(), '.claude.json'),
  'claude-settings': () => join(homedir(), '.claude', 'settings.json'),
  'zai-json': () => join(homedir(), '.zai.json'),
};

export type TopLevelJsonKey = 'claude-json' | 'claude-settings' | 'zai-json';

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

// AGENTS.md — 4 个 tool 完全互不共享,各自独立路径:
// opencc → ~/.claude/AGENTS.md  (opencc 自身 config home,与 zai 不共享)
// opencode → ~/.config/opencode/AGENTS.md
// nova → ~/.nova/AGENTS.md
// zai → ~/.zai/AGENTS.md       (zai 自身 dataDir,与 opencc 不共享)
// Config 页面 4 个 tab 各暴露一份编辑器,跨 tab 编辑相互独立。
const AGENTS_MD_PATHS: Record<ConfigTool, () => string> = {
  nova: () => join(homedir(), '.nova', 'AGENTS.md'),
  opencode: () => join(homedir(), '.config', 'opencode', 'AGENTS.md'),
  opencc: () => join(homedir(), '.claude', 'AGENTS.md'),
  zai: () => join(homedir(), '.zai', 'AGENTS.md'),
};

/**
 * 读取 tool 对应的 AGENTS.md。ENOENT 视为"缺失",返回
 * `{path, exists:false, content:'', missing:true}` 让前端可走 "新增" 分支。
 * 不区分空文件 vs missing — 空文件按 exists=true + content='' 显示。
 */
export async function readAgentsMd(tool: ConfigTool): Promise<AgentsMdFile> {
  const path = AGENTS_MD_PATHS[tool]();
  try {
    const raw = await readFile(path, 'utf-8');
    return { path, exists: true, content: raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: '', missing: true };
    }
    throw err;
  }
}

/**
 * 原子写 AGENTS.md。原样写入 content(不自动追加 \n,也不 JSON.stringify);
 * 空字符串合法 (=清空文件)。tmp+rename 保证写到一半崩了不会留半截文件。
 */
export async function writeAgentsMd(
  tool: ConfigTool,
  content: string,
): Promise<{ ok: true }> {
  const path = AGENTS_MD_PATHS[tool]();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, path);
  return { ok: true };
}

import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentsMdFile, ConfigFile, ConfigTool } from '../../shared/types.js';
import { atomicWriteFile } from '../utils/atomicWrite.js';
import { threeWayMerge } from '../utils/threeWayMerge.js';
import { mutateZaiSettings, zaiSettingsPath } from './zaiSettingsStore.js';
import type { ZaiSettings } from '../../shared/settings.js';

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
  await atomicWriteFile(path, JSON.stringify(content, null, 2));
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

/**
 * 写 tool 的配置文件。
 *
 * 语义是 **合并,不是整对象覆盖** —— 这是 `settings-tmp-path-collision` 的
 * 主因(见 docs/bugs/fix-plan-10-05.md H1)。Config 页面 PUT 的是**打开编辑器
 * 时读到的整份 JSON**,到点保存时这个缓冲可能已经过时:设置抽屉 / 另一个 zai
 * 进程早就改过同一个文件。按整对象写会把那些改动**静默回滚**。
 *
 * `base` 是编辑器打开时的磁盘快照(由客户端回传)。带 base 时走
 * **三路合并**(`utils/threeWayMerge.ts`):
 *   - 用户改过 / 新增的键 → 写入
 *   - 用户在编辑器里删掉的键 → 从结果删除(浅合并表达不了删除)
 *   - 用户**没动过**的键 → 保留磁盘现值(★ 这一条才是防回滚的关键)
 * 不带 base(旧客户端 / 调用方刚读过 disk 就自己负责全量语义)→ 退回两路浅合并。
 *
 * `zai` / `opencc` 两个 tab 都指向 `~/.zai/settings.json`,与 zaiSettingsStore
 * 是同一个文件 → 走 `mutateZaiSettings`,把「读最新磁盘 → 三路合并」整个放进
 * 它内部的串行 mutation 链(既避免同进程内两个写者互相踩 tmp,又保证合并
 * 基准是队列内的最新值,顺带刷新进程内缓存)。
 */
export async function writeConfig(
  tool: ConfigTool,
  content: Record<string, unknown>,
  base?: Record<string, unknown>,
): Promise<{ ok: true }> {
  const path = CONFIG_PATHS[tool]();
  if (path === zaiSettingsPath()) {
    await mutateZaiSettings((disk) =>
      threeWayMerge(disk as unknown as Record<string, unknown>, base, content) as ZaiSettings,
    );
    return { ok: true };
  }
  const current = await readConfig(tool);
  const merged = threeWayMerge(
    (current.missing ? {} : current.content) as Record<string, unknown>,
    base,
    content,
  );
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(merged, null, 2));
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
  await atomicWriteFile(path, content);
  return { ok: true };
}

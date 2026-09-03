/**
 * factorySettingsCore — core 侧读取 `~/.zai/factory-settings.json`
 * (任务工厂用户级设置,与 ~/.zai/settings.json 平级)。
 *
 * 该文件的写入端在 zai server(`packages/zai/src/server/services/
 * factorySettings.ts` + /api/super-tasks/settings 路由);core 只读不写。
 * 纯 core 环境(无 zai)文件通常缺失 → 返回全部默认值,提示词注入 no-op。
 * 每次构建 systemPrompt 时同步读(文件极小,无缓存需求)。
 *
 * 字段语义见 zai 侧 factorySettings.ts 注释。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CoreFactorySettings {
  docsDir: string
  repoRoot: string
  maxParallelTasks: number
  preferSpawnAgent: 'opencc' | 'dsh' | 'opencode' | null
}

export const CORE_FACTORY_SETTINGS_DEFAULTS: CoreFactorySettings = {
  docsDir: '',
  repoRoot: '',
  maxParallelTasks: 4,
  preferSpawnAgent: null,
}

/** 与 zai paths.ts 的 ZAI_DIR 惯例一致:ZAI_DATA_DIR env 可覆盖(测试用)。 */
export function coreFactorySettingsPath(): string {
  return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'factory-settings.json')
}

/** 逐字段 sanitize:缺失/非法一律回落默认值。文件缺失/坏 JSON → 全默认。 */
export function readCoreFactorySettings(): CoreFactorySettings {
  const out: CoreFactorySettings = { ...CORE_FACTORY_SETTINGS_DEFAULTS }
  try {
    const parsed: unknown = JSON.parse(readFileSync(coreFactorySettingsPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return out
    const o = parsed as Record<string, unknown>
    if (typeof o.docsDir === 'string') out.docsDir = o.docsDir
    if (typeof o.repoRoot === 'string') out.repoRoot = o.repoRoot
    if (
      typeof o.maxParallelTasks === 'number' &&
      Number.isInteger(o.maxParallelTasks) &&
      o.maxParallelTasks >= 2 &&
      o.maxParallelTasks <= 8
    ) {
      out.maxParallelTasks = o.maxParallelTasks
    }
    if (
      o.preferSpawnAgent === 'opencc' ||
      o.preferSpawnAgent === 'dsh' ||
      o.preferSpawnAgent === 'opencode'
    ) {
      out.preferSpawnAgent = o.preferSpawnAgent
    }
  } catch {
    return out
  }
  return out
}

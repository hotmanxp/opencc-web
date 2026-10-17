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
 *
 * zai patch (2026-10-17, oc-002):`coreFactorySettingsPath()` 与 zai 侧的
 * `factorySettingsPath()` **逐字相同**(同一个 `factory-settings.json`),
 * 所以下面的 `preferCliAgent` 取值域必须与 zai 侧一致 —— 否则 zai 写入的值
 * 会被这里**静默丢弃**(读到不认识的值 → 回落默认 null),而用户那边显示
 * 「已保存」。`7c32e4da` 加 `claude` 时只改了 zai 侧的 UI/白名单,这里漏了。
 *
 * ⚠️ **这是全仓唯一做不到单一真相源的地方**:取值域的真源在
 * `packages/zai/src/shared/cliAgents.ts`,但 core 不能反向 import zai 的
 * `@shared`(包边界)。**加 provider 时这里必须与那个文件一起改。**
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CoreFactorySettings {
  docsDir: string
  repoRoot: string
  maxParallelTasks: number
  /** 取值域必须与 zai 侧 `@shared/cliAgents` 一致 —— 见文件头注释。 */
  preferCliAgent: 'opencc' | 'claude' | 'dsh' | 'opencode' | null
}

export const CORE_FACTORY_SETTINGS_DEFAULTS: CoreFactorySettings = {
  docsDir: '',
  repoRoot: '',
  maxParallelTasks: 4,
  preferCliAgent: null,
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
      o.preferCliAgent === 'opencc' ||
      o.preferCliAgent === 'claude' ||
      o.preferCliAgent === 'dsh' ||
      o.preferCliAgent === 'opencode'
    ) {
      out.preferCliAgent = o.preferCliAgent
    }
  } catch {
    return out
  }
  return out
}

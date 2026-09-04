/**
 * factorySettings — 任务工厂用户级设置(`~/.zai/factory-settings.json`)的
 * 读/写/缓存层。与 `~/.zai/settings.json` 平级(用户级,非 task-factory 目录内)。
 *
 * 模式仿 taskFactoryBridge.ts:
 *  - `getFactorySettings()` 异步读取 + 刷新模块缓存;文件缺失/解析失败/字段
 *    非法一律回落默认值(逐字段 sanitize,不让手改坏的 JSON 卡死 UI)。
 *  - `setFactorySettings(patch)` patch 合并 → zod 校验(含 maxParallelTasks
 *    2–8、historyArchiveHours 1–8760 范围) → 写盘 → 更新缓存。非法值抛
 *    FactorySettingsValidationError,由路由层映射为 400。
 *  - `__resetForTests()` 清缓存。
 *
 * 消费端(混合模式):托管循环以 maxParallelTasks 为服务端强约束;
 * docsDir/repoRoot/preferSpawnAgent 为软引导(任务调度官提示词 + 需求讨论 cwd)。
 * core 侧(mainAgents-taskFactory.ts)独立读同一文件,纯 core 环境文件缺失
 * 时全部默认值 no-op。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export interface FactorySettings {
  /** 需求文档目录 = 需求讨论(task-intake)会话的 cwd。空串 = 未配置。 */
  docsDir: string
  /** 代码库单根目录,软引导任务 cwd(不校验不拦截)。空串 = 未配置。 */
  repoRoot: string
  /** 并行执行任务上限,整数 2–8。 */
  maxParallelTasks: number
  /** 委派执行时优先的 spawnAgent;"opencc" | "dsh" | "opencode" | null(未选)。 */
  preferSpawnAgent: 'opencc' | 'dsh' | 'opencode' | null
  /** finished-tasks 终态任务过期自动归档进 history-tasks 的阈值(小时),整数 1–8760。 */
  historyArchiveHours: number
}

export const FACTORY_SETTINGS_DEFAULTS: FactorySettings = {
  docsDir: '',
  repoRoot: '',
  maxParallelTasks: 4,
  preferSpawnAgent: null,
  historyArchiveHours: 48,
}

/** 写端 partial patch 校验 schema(GET/PUT 路由与服务层共用)。 */
export const factorySettingsPatchSchema = z.object({
  docsDir: z.string().optional(),
  repoRoot: z.string().optional(),
  maxParallelTasks: z.number().int().min(2).max(8).optional(),
  preferSpawnAgent: z.enum(['opencc', 'dsh', 'opencode']).nullable().optional(),
  historyArchiveHours: z.number().int().min(1).max(8760).optional(),
})
export type FactorySettingsPatch = z.infer<typeof factorySettingsPatchSchema>

/** patch/合并结果校验失败 —— 路由层捕获后回 400。 */
export class FactorySettingsValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join('; ') || 'factory settings validation failed')
    this.name = 'FactorySettingsValidationError'
    this.issues = issues
  }
}

/**
 * 路径用函数暴露(每次从 env 重读),让测试 ZAI_DATA_DIR 临时目录覆盖生效
 * —— 与 paths.ts 的 weixinAccountsDir() 同款惯例。
 */
export function factorySettingsPath(): string {
  return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'factory-settings.json')
}

/** 逐字段 sanitize:类型/范围非法的字段回落默认值,合法字段保留。 */
function sanitize(raw: unknown): FactorySettings {
  const out: FactorySettings = { ...FACTORY_SETTINGS_DEFAULTS }
  if (typeof raw !== 'object' || raw === null) return out
  const o = raw as Record<string, unknown>
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
  } else if (o.preferSpawnAgent === null) {
    out.preferSpawnAgent = null
  }
  if (
    typeof o.historyArchiveHours === 'number' &&
    Number.isInteger(o.historyArchiveHours) &&
    o.historyArchiveHours >= 1 &&
    o.historyArchiveHours <= 8760
  ) {
    out.historyArchiveHours = o.historyArchiveHours
  }
  return out
}

let cached: FactorySettings | null = null

/** 异步读取 + 刷新缓存。文件缺失 / JSON 解析失败 → 默认值(不写盘)。 */
export async function getFactorySettings(): Promise<FactorySettings> {
  try {
    const raw = JSON.parse(await readFile(factorySettingsPath(), 'utf-8')) as unknown
    cached = sanitize(raw)
    return cached
  } catch {
    cached = { ...FACTORY_SETTINGS_DEFAULTS }
    return cached
  }
}

/** 同步访问最近一次 get/set 的缓存;从未读过 → 默认值(不触发 IO)。 */
export function getFactorySettingsSync(): FactorySettings {
  return cached ?? { ...FACTORY_SETTINGS_DEFAULTS }
}

/**
 * patch 合并到当前缓存(缓存缺失时先读盘)→ 整体 zod 校验 → 写盘 → 更新缓存。
 * 校验失败抛 FactorySettingsValidationError(不落盘)。
 */
export async function setFactorySettings(patch: FactorySettingsPatch): Promise<FactorySettings> {
  const parsedPatch = factorySettingsPatchSchema.safeParse(patch)
  if (!parsedPatch.success) {
    throw new FactorySettingsValidationError(
      parsedPatch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    )
  }
  const base = cached ?? (await getFactorySettings())
  const merged = sanitize({ ...base, ...parsedPatch.data })
  const parsedMerged = factorySettingsPatchSchema.safeParse(merged)
  if (!parsedMerged.success) {
    throw new FactorySettingsValidationError(
      parsedMerged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    )
  }
  const path = factorySettingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(merged, null, 2), 'utf-8')
  cached = merged
  return merged
}

/** 测试用 —— 清模块缓存,让下一个 get/set 重新读盘。 */
export function __resetForTests(): void {
  cached = null
}

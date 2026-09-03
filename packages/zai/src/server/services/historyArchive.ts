/**
 * historyArchive — finished-tasks 终态任务过期自动归档(tf-xrlcxuoi)。
 *
 * `GET /api/super-tasks` handler 返回列表前调一次 `sweepArchiveFinishedTasks()`:
 * 把 finished-tasks 中 status=done/failed 且完成时间超过
 * `historyArchiveHours`(factory-settings.json,默认 48h)的任务整目录
 * `fs.rename` 移入 `~/.zai/task-factory/history-tasks/`。history-tasks 不注册进
 * core 的 TaskBucketName / SuperTasksList / 前端面板 —— 归档后对列表完全透明,
 * 仅文件系统保留收纳作用。
 *
 * 约束(spec 非功能需求):
 *  - 单任务错误(坏 yaml / rename 竞态 / 目标同名)只 console.warn,绝不抛出;
 *  - 模块级 in-flight Promise 去重:前端 3s 轮询重叠时同一时刻只跑一次扫描;
 *  - core 零改动:moveTask / SuperTasksMove 不触发归档。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { getFactorySettings } from './factorySettings.js'

/** 归档桶名(相对 task-factory 根目录;不进 core 的桶枚举)。 */
export const HISTORY_BUCKET = 'history-tasks'
const FINISHED_BUCKET = 'finished-tasks'
const TASK_YAML_FILENAME = 'task.yaml'

/**
 * 与 core 的 taskFactoryRoot() 同款派生:`ZAI_TASK_FACTORY_DIR` 优先,
 * 回落 `~/.zai/task-factory`。函数暴露让测试临时目录覆盖生效。
 */
export function taskFactoryRoot(): string {
  return process.env.ZAI_TASK_FACTORY_DIR ?? join(homedir(), '.zai', 'task-factory')
}

/** completedAt → epoch ms;string(ISO)/Date(js-yaml timestamp)/number 均兼容,非法返回 null。 */
function toTimestampMs(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return null
}

async function doSweep(): Promise<{ archived: string[] }> {
  const archived: string[] = []
  try {
    const root = taskFactoryRoot()
    const finishedDir = join(root, FINISHED_BUCKET)
    const historyDir = join(root, HISTORY_BUCKET)
    let ids: string[]
    try {
      ids = (await readdir(finishedDir)).filter((n) => !n.startsWith('.'))
    } catch {
      // finished-tasks 目录不存在 → 无任务可归档,静默返回
      return { archived }
    }
    await mkdir(historyDir, { recursive: true })
    const { historyArchiveHours } = await getFactorySettings()
    const thresholdMs = historyArchiveHours * 3_600_000
    const now = Date.now()
    for (const id of ids) {
      try {
        const src = join(finishedDir, id)
        const yamlPath = join(src, TASK_YAML_FILENAME)
        let meta: Record<string, unknown> | null = null
        try {
          const parsed = yaml.load(await readFile(yamlPath, 'utf-8')) as unknown
          meta = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
        } catch {
          console.warn(`[historyArchive] ${id}: task.yaml 缺失/解析失败,跳过归档`)
          continue
        }
        if (!meta) {
          console.warn(`[historyArchive] ${id}: task.yaml 内容非对象,跳过归档`)
          continue
        }
        // 仅终态参与归档
        if (meta.status !== 'done' && meta.status !== 'failed') continue
        // 过期基准:completedAt 有效则用之,否则回落 task.yaml 文件 mtime
        let ts = toTimestampMs(meta.completedAt)
        if (ts === null) {
          try {
            ts = (await stat(yamlPath)).mtimeMs
          } catch {
            console.warn(`[historyArchive] ${id}: completedAt 缺失且 task.yaml stat 失败,跳过`)
            continue
          }
        }
        if (now - ts <= thresholdMs) continue
        if (!existsSync(src)) continue // 已被并发移走 → 静默跳过
        const dst = join(historyDir, id)
        if (existsSync(dst)) {
          console.warn(`[historyArchive] ${id}: history-tasks 下已存在同名目录,跳过归档`)
          continue
        }
        await rename(src, dst)
        archived.push(id)
      } catch (err) {
        // 单任务错误只 warn,不影响其余任务与 API 响应
        console.warn(`[historyArchive] ${id}: 归档失败(跳过):`, err)
      }
    }
  } catch (err) {
    console.warn('[historyArchive] sweep 整体异常(已吞掉,不影响 API):', err)
  }
  return { archived }
}

let inFlight: Promise<{ archived: string[] }> | null = null

/**
 * 扫描并归档过期终态任务。永不抛出;in-flight 去重 —— sweep 进行中再次调用
 * 返回同一 Promise(防前端 3s 轮询重叠导致并发扫描)。
 */
export function sweepArchiveFinishedTasks(): Promise<{ archived: string[] }> {
  if (!inFlight) {
    inFlight = doSweep().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** 测试用 —— 清 in-flight 缓存。 */
export function __resetForTests(): void {
  inFlight = null
}

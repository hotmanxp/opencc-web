/**
 * sessionArchive — 会话级 transcript 过期归档。
 *
 * 同一 cwd 下，`<dataDir>/projects/<encoded-cwd>/` 里既不在"最近 keepCount
 * 条"也不在"最近 3 天"内的 transcript，被移到
 * `<dataDir>/archive/projects/<encoded-cwd>/`（保留原始 project 编码路径）。
 *
 * 触发时机只有两个：
 *   1. `initAgentRuntime()` 启动时一次（services/agentRuntime.ts）；
 *   2. `POST /api/agent/sessions/archive`（设置页「立即归档」）手动一次。
 *
 * 约定逐条对齐同目录的 services/historyArchive.ts：
 *   - 单体错误只 console.warn，绝不抛出；
 *   - 目标同名 → warn 跳过（不合并 / 不覆盖 / 不加后缀）；
 *   - 整个 sweep 异常 → warn 吞掉；
 *   - 模块级 in-flight Promise 去重（启动 sweep 未完成时用户已点「立即归档」）。
 *
 * 归档后对 Web UI 完全透明：文件不在 projects/ 下 → 侧栏列表自然不再列出。
 * 无归档列表页 / 无恢复 UI（spec §2 D1）。
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDataDir, sanitizePath } from '@zn-ai/zn-agent-core'
import { readZaiSettings } from './zaiSettingsStore.js'
import type { ZaiSettings } from '../../shared/settings.js'

export const ARCHIVE_KEEP_COUNT_DEFAULT = 20
export const ARCHIVE_KEEP_COUNT_MIN = 1
export const ARCHIVE_KEEP_COUNT_MAX = 1000
/** 保留窗口（天）—— spec §2 D4：只暴露数量阈值，天数固定。 */
export const ARCHIVE_KEEP_DAYS = 3
/** 活跃保护窗：mtime 在此窗口内的文件一律不移动（防扫描/写入撞车）。 */
export const ARCHIVE_PROTECT_WINDOW_MS = 10 * 60_000

const JSONL_EXT = '.jsonl'

/** 源目录：该 cwd 的 transcript 落盘位置。 */
export function projectDirFor(dataDir: string, cwd: string): string {
  return join(dataDir, 'projects', sanitizePath(cwd))
}

/** 目标目录：归档位置，保留原始 project 编码路径段。 */
export function archiveDirFor(dataDir: string, cwd: string): string {
  return join(dataDir, 'archive', 'projects', sanitizePath(cwd))
}

/**
 * 校验 + 归一化一个候选 keepCount。接受 number 或可转数字的字符串
 * （与 PUT /agent/settings/max-visible-messages 的 handler 同款宽容度）。
 * 非法 → null（调用方决定回落值）。
 */
export function toArchiveKeepCount(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(ARCHIVE_KEEP_COUNT_MIN, Math.min(ARCHIVE_KEEP_COUNT_MAX, Math.floor(n)))
}

/** 从 settings 解析保留条数；缺失 / 手编垃圾值 → 20。 */
export function resolveArchiveKeepCount(settings: ZaiSettings): number {
  return toArchiveKeepCount(settings.archive?.keepCount) ?? ARCHIVE_KEEP_COUNT_DEFAULT
}

export type SessionArchiveResult = {
  /** 成功移走的 sessionId 列表。 */
  archived: string[]
  /** 保留集大小（候选数 − 归档集大小）。 */
  kept: number
  /** 进了归档集但因保护窗 / 目标同名 / stat 失败而没被移动的条数。 */
  skipped: number
}

export type SweepOptions = {
  /** 要归档的工作目录（= 实例 cwd）。 */
  cwd: string
  /** 默认 resolveDataDir().resolved。测试注入临时目录。 */
  dataDir?: string
  /** 默认 Date.now()。测试注入固定墙钟。 */
  now?: number
  /** 默认从 ~/.zai/settings.json 解析。测试注入。 */
  keepCount?: number
}

/**
 * rename 优先（同盘原子零拷贝）。捕获 EXDEV（跨设备 —— 例如用户把
 * ~/.zai/archive 做成指向另一块盘的符号链接）→ 降级 cp + rm。
 */
async function movePath(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(src, dst, { recursive: true, preserveTimestamps: true })
    await rm(src, { recursive: true, force: true })
  }
}

async function doSweep(opts: SweepOptions): Promise<SessionArchiveResult> {
  const archived: string[] = []
  let kept = 0
  let skipped = 0
  try {
    const dataDir = opts.dataDir ?? resolveDataDir().resolved
    const now = opts.now ?? Date.now()
    const keepCount =
      opts.keepCount ?? resolveArchiveKeepCount(await readZaiSettings())

    const srcDir = projectDirFor(dataDir, opts.cwd)
    let names: string[]
    try {
      names = await readdir(srcDir)
    } catch {
      // project 目录不存在 → 该 cwd 从没跑过会话，静默返回
      return { archived, kept, skipped }
    }

    // 候选只取 .jsonl；<sid>/ 目录与 memory/ 等都不是候选（<sid>/ 是随行者，
    // 在移动到主文件时一并带走）。
    const candidates: Array<{ sessionId: string; mtimeMs: number }> = []
    for (const name of names) {
      if (!name.endsWith(JSONL_EXT)) continue
      const sessionId = name.slice(0, -JSONL_EXT.length)
      try {
        const s = await stat(join(srcDir, name))
        candidates.push({ sessionId, mtimeMs: s.mtimeMs })
      } catch (err) {
        // 竞态删除 / 权限 → 跳过该条，不影响其余
        console.warn(`[sessionArchive] stat failed for ${name}, skipped:`, err)
      }
    }

    if (candidates.length <= keepCount) {
      return { archived, kept: candidates.length, skipped }
    }

    // 保留集 = 前 keepCount 条 ∪ { mtime >= now - 3天 }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const keepIds = new Set(candidates.slice(0, keepCount).map((c) => c.sessionId))
    const cutoffMs = now - ARCHIVE_KEEP_DAYS * 24 * 60 * 60 * 1000
    const doomed: string[] = []
    for (const c of candidates) {
      if (keepIds.has(c.sessionId)) continue
      if (c.mtimeMs >= cutoffMs) continue
      doomed.push(c.sessionId)
    }
    kept = candidates.length - doomed.length

    if (doomed.length === 0) return { archived, kept, skipped }

    const dstRoot = archiveDirFor(dataDir, opts.cwd)
    await mkdir(dstRoot, { recursive: true })

    for (const sessionId of doomed) {
      try {
        const srcJsonl = join(srcDir, `${sessionId}${JSONL_EXT}`)
        const dstJsonl = join(dstRoot, `${sessionId}${JSONL_EXT}`)

        // 保护窗：扫描与写入撞车时别把正在写的会话抽走。
        // 注意（spec §4.1）：这防的是竞态，防不住"另一实例持有 ≥3 天没写入
        // 的会话" —— 后者是已知限制。
        let mtimeMs: number
        try {
          mtimeMs = (await stat(srcJsonl)).mtimeMs
        } catch {
          skipped++ // 已被并发移走
          continue
        }
        if (now - mtimeMs < ARCHIVE_PROTECT_WINDOW_MS) {
          skipped++
          continue
        }
        if (existsSync(dstJsonl)) {
          console.warn(
            `[sessionArchive] ${sessionId}: 归档目录已存在同名文件，跳过归档`,
          )
          skipped++
          continue
        }

        await movePath(srcJsonl, dstJsonl)

        // 子 Agent transcript 目录随行；不存在就只移单文件。
        // 只移 .jsonl 会把 <sid>/ 留成永远没人认领的孤儿目录。
        const srcSub = join(srcDir, sessionId)
        if (existsSync(srcSub)) {
          const dstSub = join(dstRoot, sessionId)
          if (existsSync(dstSub)) {
            console.warn(
              `[sessionArchive] ${sessionId}: 归档目录已存在同名子目录，` +
                '主文件已归档，子目录留在原地（需人工处理）',
            )
          } else {
            await movePath(srcSub, dstSub)
          }
        }

        archived.push(sessionId)
      } catch (err) {
        // 单会话错误只 warn，不影响其余会话
        console.warn(`[sessionArchive] ${sessionId}: 归档失败(跳过):`, err)
      }
    }
  } catch (err) {
    console.warn('[sessionArchive] sweep 异常(已吞掉):', err)
  }

  // 有归档才打印，避免每次启动都刷一行
  if (archived.length > 0) {
    console.log(
      `[sessionArchive] cwd=${opts.cwd} archived=${archived.length} kept=${kept} skipped=${skipped}`,
    )
  }
  return { archived, kept, skipped }
}

let inFlight: Promise<SessionArchiveResult> | null = null

/**
 * 扫描并归档过期会话。永不抛出；in-flight 去重 —— sweep 进行中再次调用
 * 返回同一 Promise（防"启动 sweep 还没跑完用户就点了立即归档"）。
 */
export function sweepSessionArchive(
  opts: SweepOptions,
): Promise<SessionArchiveResult> {
  if (!inFlight) {
    inFlight = doSweep(opts).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** 测试用 —— 清 in-flight 缓存。 */
export function __resetSessionArchiveForTests(): void {
  inFlight = null
}

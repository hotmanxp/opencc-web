/**
 * 会话迁移工具 — B6 T6.3。
 *
 * 把 opencc 轨道 jsonl 会话翻译为 dsh 事件溯源 log。仅在显式调用 migrateSession()
 * 时运行；默认 dryRun=true，不写目标。
 *
 * 设计动机（主计划 §4.2 + 审查改进 4）：
 * - 双轨数据隔离（`${dataDir}/projects/<cwd>/<sid>.jsonl` ↔ `dsh-sessions/<sid>/`）
 *   在 B0-B5 是不变量；不允许两轨互读。
 * - 但用户必须能在两条轨道间迁移已存在的会话。
 * - 迁移工具是唯一允许跨格式读写的代码，且默认 dry-run + 只读源 + 只写目标 +
 *   幂等 + 校验 + 回滚 + 版本锁定。
 *
 * 关键约束：
 * - **只读源**：opencc jsonl 只解析，绝不修改。
 * - **只写目标**：仅写 dsh-sessions/<sid>/ 下文件。
 * - **dryRun 默认 true**：调用方须显式 `dryRun: false` 才真正落盘。
 * - **版本锁定**：targetDshVersion 必须与 installed('@zn-ai/dsh-bridge').DSH_VERSION
 *   一致，否则报错。避免在版本不匹配的 dsh runtime 下读到无效 log。
 * - **幂等**：重复运行（同一 cwd + sessionId）不产生重复/损坏；目标目录存在且通过
 *   校验时跳过迁移。
 * - **校验**：迁移完成后回读 log 断言关键事件（firstSeq、turn 数）符合预期。
 * - **回滚**：迁移前 snapshot 目标目录（如已存在），失败时恢复。
 * - **不可迁移条目显式列出**：损坏 / 未知事件类型不静默丢弃。
 *
 * 字段映射（jsonl entry → dsh SessionEvent）：
 *   { type: 'user', message: {...} }        → user.message
 *   { type: 'assistant', message: {...} }    → assistant.message
 *   { type: 'tool_use', toolUseId, ...}      → tool/call
 *   { type: 'tool_result', toolUseId, ...}   → tool/result
 *   { type: 'custom-title', customTitle }    → session.meta.customTitle
 *   其它 → unmapped（显式列出）
 *
 * dsh SessionEvent 形状（与 dsh-bridge/src/translate/sessionEvents.ts 兼容）：
 *   {
 *     type: 'session.meta' | 'user.message' | 'assistant.message'
 *         | 'tool/call' | 'tool/result' | 'turn/start' | 'turn/end',
 *     seq: number, ts: number, data: { ... }
 *   }
 *
 * 文件输出（dsh 轨道 layout）：
 *   ${dataDir}/projects/<cwd>/dsh-sessions/<sid>/log.jsonl
 *   ${dataDir}/projects/<cwd>/dsh-sessions/<sid>/header.json
 */

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ─── dsh 版本读取 ────────────────────────────────────────────────────

interface DshBridgePackage {
  DSH_VERSION: string
}

interface DshBridgeModule {
  DSH_VERSION: string
}

/**
 * 读取已安装的 @zn-ai/dsh-bridge 模块的 DSH_VERSION。
 * 用 createRequire 包一层：动态 import 在 vitest mock 下偶尔取不到 export，
 * 这里走 Node require 解析 package.json exports map 拿到的真实版本。
 */
export async function getInstalledDshVersion(): Promise<string> {
  // 先尝试从模块读取（fast path：测试 mock 时优先用）
  try {
    const mod = (await import('@zn-ai/dsh-bridge')) as DshBridgeModule
    if (mod.DSH_VERSION) return mod.DSH_VERSION
  } catch {
    // 忽略，回退到 require
  }
  // 回退路径：通过 createRequire 解析实际安装的 dsh-bridge 版本
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const pkgPath = req.resolve('@zn-ai/dsh-bridge/package.json')
    const pkg = (await import(/* @vite-ignore */ pkgPath)) as DshBridgePackage
    return pkg.DSH_VERSION
  } catch (err) {
    throw new Error(
      `[migrate] 无法读取 @zn-ai/dsh-bridge 版本: ${(err as Error).message}`,
    )
  }
}

// ─── 类型定义 ────────────────────────────────────────────────────────

/** jsonl entry 的最小形状（opencc 侧真实类型非常宽，这里只列翻译器关心的字段）。 */
export interface OpenccJsonlEntry {
  type: string
  message?: {
    role?: string
    content?: unknown
  }
  toolUseId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  customTitle?: string
  // 其它字段都被吞掉，但保留 visibility 便于调试
  [k: string]: unknown
}

/** dsh SessionEvent 的最小子集（实际 dsh 类型见 dsh-session 包，这里只约束我们写的）。 */
export interface DshSessionEvent {
  type:
    | 'session.meta'
    | 'user.message'
    | 'assistant.message'
    | 'tool/call'
    | 'tool/result'
    | 'turn/start'
    | 'turn/end'
  seq: number
  ts: number
  data: Record<string, unknown>
}

export interface MigrateOptions {
  /** 默认 true。true 时只产出统计不写文件。 */
  dryRun?: boolean
  /** 必须与 installed('@zn-ai/dsh-bridge').DSH_VERSION 一致；不一致报错。 */
  targetDshVersion: string
  /** 自定义 dataDir（默认走 ZAI_DATA_DIR 解析）。便于测试。 */
  dataDir?: string
}

export interface MigrateStats {
  /** 输入 jsonl 总行数。 */
  inputLines: number
  /** 成功映射为 dsh SessionEvent 的条目数。 */
  mappedEvents: number
  /** 跳过的不可迁移条目（损坏 / 未知 type）。 */
  unmappedEntries: Array<{ lineNumber: number; reason: string; raw?: string }>
  /** 迁移首个 dsh 事件的 seq。 */
  firstSeq: number
  /** turn 数（user.message + assistant.message 对数）。 */
  turnCount: number
  /** 已存在的目标目录；idempotent 命中时 dryRun 仍返回统计。 */
  alreadyMigrated: boolean
  /** 写入目标时返回绝对路径；dryRun 时为 null。 */
  outputPath: string | null
}

export interface MigrateResult extends MigrateStats {
  /** 校验通过为 true；任何校验失败为 false。 */
  validated: boolean
  /** 校验失败的详情（如有）。 */
  validationErrors: string[]
}

// ─── 核心翻译 ────────────────────────────────────────────────────────

/**
 * 把单条 opencc jsonl entry 翻译成 dsh SessionEvent。
 * 返回 null 表示 unmapped（调用方记录）。
 *
 * seq 分配：seq = base + index（base=1 起步，与 dsh-session 默认从 1 开始一致）。
 * ts：解析 entry.isMeta 等；fallback 用 0 表示无时间。
 */
export function translateJsonlEntry(
  entry: OpenccJsonlEntry,
  seq: number,
): DshSessionEvent | null {
  const ts = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now()

  switch (entry.type) {
    case 'user': {
      return {
        type: 'user.message',
        seq,
        ts,
        data: {
          content: entry.message?.content ?? null,
          // opencc 用 message.role，dsh 把 role 嵌入 type
          raw: entry.message,
        },
      }
    }
    case 'assistant': {
      return {
        type: 'assistant.message',
        seq,
        ts,
        data: {
          content: entry.message?.content ?? null,
          raw: entry.message,
        },
      }
    }
    case 'tool_use': {
      return {
        type: 'tool/call',
        seq,
        ts,
        data: {
          toolUseId: entry.toolUseId,
          toolName: entry.toolName,
          input: entry.input,
        },
      }
    }
    case 'tool_result': {
      return {
        type: 'tool/result',
        seq,
        ts,
        data: {
          toolUseId: entry.toolUseId,
          output: entry.output,
        },
      }
    }
    case 'custom-title': {
      return {
        type: 'session.meta',
        seq,
        ts,
        data: {
          customTitle: entry.customTitle,
        },
      }
    }
    case 'queue-operation':
    case 'last-prompt':
    case 'compact-summary':
    case 'attachment':
    case 'microcompact-footer':
      return null
    default:
      return null
  }
}

/**
 * 解析 opencc jsonl 文件为 dsh SessionEvent 列表 + 不可迁移条目。
 * 单行损坏不抛错 — 计入 unmappedEntries。
 */
export function translateJsonl(raw: string): {
  events: DshSessionEvent[]
  unmapped: Array<{ lineNumber: number; reason: string; raw?: string }>
} {
  const events: DshSessionEvent[] = []
  const unmapped: Array<{ lineNumber: number; reason: string; raw?: string }> = []
  const lines = raw.split('\n')

  let seq = 1 // dsh 事件 seq 从 1 起
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    let entry: OpenccJsonlEntry
    try {
      entry = JSON.parse(line) as OpenccJsonlEntry
    } catch (err) {
      unmapped.push({
        lineNumber: i + 1,
        reason: `JSON parse error: ${(err as Error).message}`,
        raw: line.length > 200 ? line.slice(0, 200) + '…' : line,
      })
      continue
    }

    if (!entry || typeof entry.type !== 'string') {
      unmapped.push({
        lineNumber: i + 1,
        reason: 'missing type field',
        raw: line.length > 200 ? line.slice(0, 200) + '…' : line,
      })
      continue
    }

    const evt = translateJsonlEntry(entry, seq)
    if (evt === null) {
      unmapped.push({
        lineNumber: i + 1,
        reason: `unsupported type: ${entry.type}`,
      })
      continue
    }
    events.push(evt)
    seq++
  }
  return { events, unmapped }
}

/** 算 turn 数（user.message + assistant.message 各算 0.5；向下取整）。 */
export function computeTurnCount(events: DshSessionEvent[]): number {
  let count = 0
  for (const e of events) {
    if (e.type === 'user.message' || e.type === 'assistant.message') count++
  }
  return Math.floor(count / 2)
}

// ─── 路径解析 ────────────────────────────────────────────────────────

/** opencc jsonl 路径：${dataDir}/projects/<sanitized-cwd>/<sessionId>.jsonl */
export function openccJsonlPath(
  dataDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(dataDir, 'projects', sanitizeCwd(cwd), `${sessionId}.jsonl`)
}

/** dsh session dir：${dataDir}/projects/<sanitized-cwd>/dsh-sessions/<sid> */
export function dshSessionDir(
  dataDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(dataDir, 'projects', sanitizeCwd(cwd), 'dsh-sessions', sessionId)
}

/** dsh session log：<dshSessionDir>/log.jsonl */
export function dshSessionLogPath(
  dataDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(dshSessionDir(dataDir, cwd, sessionId), 'log.jsonl')
}

/** dsh session header：<dshSessionDir>/header.json */
export function dshSessionHeaderPath(
  dataDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(dshSessionDir(dataDir, cwd, sessionId), 'header.json')
}

/** 复用 legacyTranscriptStore.ts 的 sanitize 规则（截断 + djb2 hash）。 */
const MAX_SANITIZED_LENGTH = 200
function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}
export function sanitizeCwd(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  const hash = Math.abs(djb2Hash(name)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

// ─── 校验 ────────────────────────────────────────────────────────────

/** 校验 dsh log：firstSeq === 1；event.seq 单调；turn 数与 input 一致。 */
export function validateDshLog(
  events: DshSessionEvent[],
  expectedTurnCount: number,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (events.length === 0) {
    errors.push('empty event list')
  } else {
    if (events[0].seq !== 1) {
      errors.push(`firstSeq mismatch: expected 1, got ${events[0].seq}`)
    }
    for (let i = 1; i < events.length; i++) {
      if (events[i].seq <= events[i - 1].seq) {
        errors.push(`seq not monotonic at index ${i}: ${events[i - 1].seq} → ${events[i].seq}`)
        break
      }
    }
  }

  const actualTurns = computeTurnCount(events)
  if (actualTurns !== expectedTurnCount) {
    errors.push(`turnCount mismatch: expected ${expectedTurnCount}, got ${actualTurns}`)
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

// ─── Snapshot / 回滚 ────────────────────────────────────────────────

/**
 * 把目标目录 snapshot 到 <dir>.bak-<ts>，若失败抛错。
 * 用 rename（原子）实现：先 rename 原目录为 .bak，然后由调用方写新目录。
 * 若迁移失败，调用 rollback() 把 .bak 还原。
 */
export async function snapshotTarget(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null
  const backup = `${dir}.bak-${Date.now()}`
  await rename(dir, backup)
  return backup
}

/** 把 snapshot 还原回 dir；删除新建的（部分写入的）dir。 */
export async function rollback(
  dir: string,
  backup: string | null,
): Promise<void> {
  // 删新建的（部分写入的）dir
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true })
  }
  // 还原 backup
  if (backup && existsSync(backup)) {
    await rename(backup, dir)
  }
}

// ─── 入口函数 ────────────────────────────────────────────────────────

/**
 * 把 opencc jsonl 会话翻译为 dsh 事件溯源 log。
 *
 * - 默认 dryRun=true（不写文件）
 * - targetDshVersion 必须与 installed('@zn-ai/dsh-bridge').DSH_VERSION 一致
 * - 幂等：目标目录存在 + log 校验通过 → 直接返回 alreadyMigrated=true
 * - 校验：迁移完成后回读 log 断言关键事件
 * - 回滚：迁移前 snapshot，失败时恢复
 * - 不可迁移条目显式列出，不静默丢弃
 *
 * 抛错场景：
 * - 版本不匹配
 * - 源文件不存在
 * - 校验失败（除非已迁移）
 */
export async function migrateSession(
  cwd: string,
  sessionId: string,
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const dryRun = opts.dryRun ?? true
  const targetDshVersion = opts.targetDshVersion
  const dataDir =
    opts.dataDir ??
    process.env.ZAI_DATA_DIR ??
    (await import('../paths.js')).ZAI_DIR

  // ── 版本锁定 ─────────────────────────────────────────────────
  const installedVersion = await getInstalledDshVersion()
  if (installedVersion !== targetDshVersion) {
    throw new VersionMismatchError(installedVersion, targetDshVersion)
  }

  // ── 源文件读取 ─────────────────────────────────────────────
  const srcPath = openccJsonlPath(dataDir, cwd, sessionId)
  if (!existsSync(srcPath)) {
    throw new Error(`[migrate] source jsonl not found: ${srcPath}`)
  }
  const raw = await readFile(srcPath, 'utf8')
  const { events, unmapped } = translateJsonl(raw)
  const turnCount = computeTurnCount(events)
  const firstSeq = events.length > 0 ? events[0].seq : 0

  // ── 幂等检查 ───────────────────────────────────────────────
  const targetDir = dshSessionDir(dataDir, cwd, sessionId)
  const targetLog = dshSessionLogPath(dataDir, cwd, sessionId)
  let alreadyMigrated = false
  if (existsSync(targetLog)) {
    // 回读并校验
    const existingRaw = await readFile(targetLog, 'utf8')
    const existingLines = existingRaw
      .split('\n')
      .filter((l) => l.trim())
    let existingEvents: DshSessionEvent[] = []
    try {
      existingEvents = existingLines.map((l) => JSON.parse(l) as DshSessionEvent)
    } catch (err) {
      throw new Error(
        `[migrate] existing target log corrupted, refusing to overwrite: ${(err as Error).message}`,
      )
    }
    const existingTurns = computeTurnCount(existingEvents)
    if (existingTurns === turnCount && existingEvents.length === events.length) {
      alreadyMigrated = true
      return {
        inputLines: raw.split('\n').filter((l) => l.trim()).length,
        mappedEvents: events.length,
        unmappedEntries: unmapped,
        firstSeq,
        turnCount,
        alreadyMigrated: true,
        outputPath: targetLog,
        validated: true,
        validationErrors: [],
      }
    }
    // 已有但不匹配：throw（不静默覆盖）
    throw new Error(
      `[migrate] target session exists but doesn't match source (existing turns=${existingTurns}, source turns=${turnCount}). ` +
        `手动检查 ${targetDir} 后删除重试。`,
    )
  }

  // ── 校验映射结果 ───────────────────────────────────────────
  const validation = validateDshLog(events, turnCount)
  if (!validation.ok) {
    throw new Error(
      `[migrate] 映射结果校验失败: ${validation.errors.join('; ')}`,
    )
  }

  // ── DryRun: 不写文件 ───────────────────────────────────────
  if (dryRun) {
    return {
      inputLines: raw.split('\n').filter((l) => l.trim()).length,
      mappedEvents: events.length,
      unmappedEntries: unmapped,
      firstSeq,
      turnCount,
      alreadyMigrated: false,
      outputPath: null,
      validated: true,
      validationErrors: [],
    }
  }

  // ── 真实落盘 + 回滚保护 ─────────────────────────────────────
  let backup: string | null = null
  try {
    // snapshot 已存在的目录（一般不存在，但防御性）
    if (existsSync(targetDir)) {
      backup = await snapshotTarget(targetDir)
    }
    // 写目标
    await mkdir(targetDir, { recursive: true })
    await writeFile(
      targetLog,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )
    await writeFile(
      dshSessionHeaderPath(dataDir, cwd, sessionId),
      JSON.stringify(
        {
          sessionId,
          cwd,
          createdAt: events[0]?.ts ?? Date.now(),
          source: 'opencc-migration',
          dshVersion: targetDshVersion,
          turnCount,
        },
        null,
        2,
      ),
      'utf8',
    )

    // 校验：回读
    const reread = await readFile(targetLog, 'utf8')
    const rereadEvents = reread
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DshSessionEvent)
    const revalidate = validateDshLog(rereadEvents, turnCount)
    if (!revalidate.ok) {
      throw new Error(`[migrate] 回读校验失败: ${revalidate.errors.join('; ')}`)
    }

    return {
      inputLines: raw.split('\n').filter((l) => l.trim()).length,
      mappedEvents: events.length,
      unmappedEntries: unmapped,
      firstSeq,
      turnCount,
      alreadyMigrated: false,
      outputPath: targetLog,
      validated: true,
      validationErrors: [],
    }
  } catch (err) {
    // 回滚
    try {
      await rollback(targetDir, backup)
    } catch (rollbackErr) {
      // rollback 失败：把错误信息拼到原错
      throw new Error(
        `[migrate] 迁移失败 + 回滚失败: ${(err as Error).message}; ` +
          `rollback: ${(rollbackErr as Error).message}`,
      )
    }
    throw err
  }
}

/**
 * 列出会话目录的所有 opencc jsonl session（用于批量迁移）。
 */
export async function listOpenccSessions(
  dataDir: string,
  cwd: string,
): Promise<string[]> {
  const dir = dirname(openccJsonlPath(dataDir, cwd, '__placeholder__'))
  if (!existsSync(dir)) return []
  const files = await readdir(dir)
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
}

// ─── 错误类型 ────────────────────────────────────────────────────────

export class VersionMismatchError extends Error {
  readonly installed: string
  readonly requested: string
  constructor(installed: string, requested: string) {
    super(
      `[migrate] dsh 版本不匹配: installed='${installed}', requested='${requested}'. ` +
        `升级 @zn-ai/dsh-bridge 后重试，或显式传匹配的 targetDshVersion。`,
    )
    this.name = 'VersionMismatchError'
    this.installed = installed
    this.requested = requested
  }
}
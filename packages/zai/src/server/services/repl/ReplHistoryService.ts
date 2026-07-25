import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { TopCommandEntry } from '../../../shared/repl.js'

/**
 * 全局 Bash REPL 命令历史服务。
 *
 * 设计:
 * - 每条 exec spawn 成功后 appendCommand 一行 JSONL 到 `~/.zai/repl-history.jsonl`。
 * - getTopCommands 读时计算 + 内存 cache(TTL),返回按 command 频次倒序的 topN。
 * - blocklist 拦截包含敏感赋值的命令,不写入磁盘(假阴优先于假阳)。
 * - 文件超 maxBytes 时 rotate 成 `<path>.1`,只读主文件避免无限增长。
 * - 单进程内 append 通过 Promise-chain 串行化,避免 JSONL 行交错。
 *
 * Spec/Plan: docs/superpowers/plans/2026-07-25-zai-bash-repl-top10.md
 */

const DEFAULT_HISTORY_PATH = '~/.zai/repl-history.jsonl'
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/**
 * 敏感赋值模式 — 命令中含 `KEY=...` `PASSWORD=...` `TOKEN=...` 等视为泄漏。
 * 仅匹配"赋值"形态,避免误杀命令名含敏感词(`grep token` 等)的合法命令。
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(password|passwd|pwd|secret|token|api[_-]?key|aws[_-]?key|bearer)\s*=/i,
]

export interface ReplHistoryServiceOptions {
  historyPath?: string
  cacheTtlMs?: number
  maxBytes?: number
}

interface CacheState {
  entries: TopCommandEntry[]
  fetchedAt: number
}

export class ReplHistoryService {
  private readonly historyPath: string
  private readonly cacheTtlMs: number
  private readonly maxBytes: number
  private cache: CacheState | null = null
  /** 串行化同一文件的 append 链(单进程内) */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(opts: ReplHistoryServiceOptions = {}) {
    this.historyPath = opts.historyPath ?? defaultHistoryPath()
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * Append 一条命令到历史 JSONL。
   * - 空白命令 → no-op
   * - blocklist 命中 → no-op
   * - 超 maxBytes → rotate(主文件 → .1),再 append 到主文件
   */
  async appendCommand(command: string, sessionId: string): Promise<void> {
    const trimmed = command.trim()
    if (!trimmed) return
    if (isSensitive(trimmed)) return

    // 串行化:每次 append await 前一个完成
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.historyPath), { recursive: true })
      // 检查文件大小,超 maxBytes 则 rotate
      try {
        const st = await stat(this.historyPath)
        if (st.size >= this.maxBytes) {
          await this.rotate()
        }
      } catch (err: any) {
        // 文件不存在是正常路径,ENOENT → 继续
        if (err?.code !== 'ENOENT') throw err
      }
      const line =
        JSON.stringify({ ts: Date.now(), command: trimmed, sessionId }) + '\n'
      await appendFile(this.historyPath, line, 'utf-8')
    })
    await this.writeChain
  }

  /**
   * 读 JSONL 计算 topN。
   * - cache hit (TTL 内) → 直接返回
   * - prefix 过滤在读取后内存做(server 权威,前端只做 UX 优化)
   * - 损坏行(JSON.parse 失败)静默跳过
   */
  async getTopCommands(limit: number, prefix?: string): Promise<TopCommandEntry[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.applyPrefix(this.cache.entries, prefix).slice(0, limit)
    }
    const entries = await this.computeTopCommands(prefix)
    this.cache = { entries, fetchedAt: Date.now() }
    return entries.slice(0, limit)
  }

  /** 清缓存,下次 getTopCommands 强制重读。 */
  invalidateCache(): void {
    this.cache = null
  }

  // ----- internal -----

  private applyPrefix(
    entries: TopCommandEntry[],
    prefix: string | undefined,
  ): TopCommandEntry[] {
    if (!prefix) return entries
    return entries.filter((e) => e.command.startsWith(prefix))
  }

  private async computeTopCommands(prefix?: string): Promise<TopCommandEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.historyPath, 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') return []
      throw err
    }
    const counts = new Map<string, number>()
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as { command?: string }
        if (typeof parsed.command !== 'string') continue
        if (prefix && !parsed.command.startsWith(prefix)) continue
        counts.set(parsed.command, (counts.get(parsed.command) ?? 0) + 1)
      } catch {
        /* 损坏行跳过 */
      }
    }
    const entries: TopCommandEntry[] = Array.from(counts.entries()).map(
      ([command, count]) => ({ command, count }),
    )
    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      // 频次相同时按字典序,确保返回稳定
      return a.command < b.command ? -1 : a.command > b.command ? 1 : 0
    })
    return entries
  }

  /**
   * Rotate:主文件 → .1。简单可靠:总共存主 + .1 两个文件,跨多次 rotate 后最早数据丢失是可接受的(10MB 主 + 10MB .1 上限对常见场景够用)。
   */
  private async rotate(): Promise<void> {
    const rotated = `${this.historyPath}.1`
    await rename(this.historyPath, rotated)
  }
}

function isSensitive(command: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(command))
}

function defaultHistoryPath(): string {
  return `${homedir()}/.zai/repl-history.jsonl`
}

// ----- 单例 -----

let _singleton: ReplHistoryService | null = null

export function getReplHistoryService(): ReplHistoryService {
  if (!_singleton) _singleton = new ReplHistoryService()
  return _singleton
}

/** 测试 seam:清空单例。 */
export function __resetReplHistoryServiceForTest(): void {
  _singleton = null
}
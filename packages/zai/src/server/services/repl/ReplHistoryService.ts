import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveZaiDir } from '../paths.js'
import type { TopCommandEntry } from '../../../shared/repl.js'

/**
 * 全局 Bash REPL 命令历史服务。
 *
 * 设计:
 * - 每条 exec spawn 成功后 appendCommand 一行 JSONL 到
 *   `<resolveZaiDir()>/repl-history.jsonl`(设了 `ZAI_DATA_DIR` 时落在隔离目录)。
 * - getTopCommands 读时计算 + 内存 cache(TTL),返回按 command 频次倒序的 topN。
 * - blocklist 拦截包含敏感赋值的命令,不写入磁盘(假阴优先于假阳)。
 * - 文件超 maxBytes 时 rotate 成 `<path>.1`,只读主文件避免无限增长。
 * - 单进程内 append 通过 Promise-chain 串行化,避免 JSONL 行交错。
 *
 * Spec/Plan: docs/superpowers/plans/2026-07-25-zai-bash-repl-top10.md
 */

// zai patch (2026-10-17, cl-003):原先有个 `DEFAULT_HISTORY_PATH =
// '~/.zai/repl-history.jsonl'` 常量,但它**从未被引用** —— 真正的默认路径
// 走下面的 defaultHistoryPath(),而后者硬写 `${homedir()}/.zai/…`。留着它
// 会让人以为改这个常量就能改行为。已删除。
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
  /** 显式注入的路径(测试口子);未给则每次现算 defaultHistoryPath()。 */
  private readonly explicitHistoryPath?: string
  private readonly cacheTtlMs: number
  private readonly maxBytes: number
  private cache: CacheState | null = null
  /** 串行化同一文件的 append 链(单进程内) */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(opts: ReplHistoryServiceOptions = {}) {
    this.explicitHistoryPath = opts.historyPath
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * 惰性解析:默认路径**每次现算**。
   *
   * zai patch (2026-10-17, cl-003):此前是构造函数一次性捕获进
   * `this.historyPath`,而 `getReplHistoryService()` 是惰性单例 —— 即使把
   * 默认路径改成走 `resolveZaiDir()`,「首次使用 REPL 那一刻的 env」也会被
   * 永久冻结,隔离目录对它无效。
   */
  private get historyPath(): string {
    return this.explicitHistoryPath ?? defaultHistoryPath()
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

/**
 * 默认历史文件路径 — 走 `resolveZaiDir()`。
 *
 * zai patch (2026-10-17, cl-003):此前是
 * `` `${homedir()}/.zai/repl-history.jsonl` `` —— **模板串写法绕开了
 * `join(homedir(), '.zai'` 这个 grep 特征**,所以 `d66d09f5` 的「收口全部
 * 调用点」清单里没有它(上一届 tc-002 栽在同一类模板串上)。设了
 * `ZAI_DATA_DIR` 的实例每次执行 REPL 都会 append 到**用户真实**的
 * `~/.zai/repl-history.jsonl`,超限时 `rotate()` 还会 rename 覆盖用户真实的
 * `.1` 文件。
 */
function defaultHistoryPath(): string {
  return join(resolveZaiDir(), 'repl-history.jsonl')
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
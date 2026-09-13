/**
 * WeixinPendingStore — 入站消息「不丢」落盘 + 幂等重放(D6 / P2)。
 *
 * 问题:adapter 的 poll loop 在**派发之前**就推进 iLink 游标
 * (`WeixinAdapter._pollLoop`:先 `syncStore.save(newBuf)`,再 fire-and-forget
 * 派发 `_processMessageSafe`)。进程在「派发」与「注入 agent」之间崩溃 →
 * 消息永久丢失(游标已过,服务端不再重发)。内存去重表重启即失忆。
 *
 * 修法:入站消息**通过鉴权、注入之前**先原子落盘到
 * `~/.zai/weixin/inbox-pending/<safe(messageId)>.json`;注入成功(replay 也
 * 包含)后删除该文件。启动时扫描目录、按 `receivedAt` 重放。
 *
 * 幂等:`processed.json` 记录已成功注入的 messageId(保留 7 天)。崩溃窗口
 * 内可能「已注入但未删 pending」,重放时靠它跳过,保证「只注入一次」。
 *
 * 注意:**不要**改成「处理完再推进游标」—— iLink 的 get_updates_buf 是
 * 服务端续读游标,推迟太久会让下次 getUpdates 重复拉大批历史。
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { weixinDataDir, weixinPendingDir } from '../paths.js'

const FILE_MODE = 0o600
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60_000

export interface PendingInbound {
  messageId: string
  accountId: string
  chatType: 'dm' | 'group'
  chatId: string
  senderId: string
  text: string
  mediaPaths: string[]
  mediaTypes: string[]
  contextToken: string | null
  receivedAt: number
}

interface ProcessedFile {
  ids: Record<string, number>
}

function safeName(messageId: string): string {
  const safe = messageId.replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 180)
  return safe.length > 0 ? safe : 'unknown'
}

function processedFilePath(): string {
  return join(weixinPendingDir(), 'processed.json')
}

export class WeixinPendingStore {
  private processed = new Map<string, number>()
  private processedLoaded = false
  private writeChain: Promise<void> = Promise.resolve()

  private pendingPathFor(messageId: string): string {
    return join(weixinPendingDir(), `${safeName(messageId)}.json`)
  }

  private async ensureProcessedLoaded(): Promise<void> {
    if (this.processedLoaded) return
    this.processedLoaded = true
    const path = processedFilePath()
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<ProcessedFile>
      const now = Date.now()
      for (const [id, ts] of Object.entries(raw.ids ?? {})) {
        if (typeof ts === 'number' && now - ts <= PROCESSED_TTL_MS) this.processed.set(id, ts)
      }
    } catch {
      // 损坏 → 空集
    }
  }

  /** 原子写入一条待注入消息。同 messageId 覆盖写。 */
  async save(entry: PendingInbound): Promise<void> {
    await mkdir(weixinPendingDir(), { recursive: true })
    const path = this.pendingPathFor(entry.messageId)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(entry, null, 2), { mode: FILE_MODE })
    await rename(tmp, path)
  }

  async remove(messageId: string): Promise<void> {
    try {
      await unlink(this.pendingPathFor(messageId))
    } catch {
      /* 已删除 */
    }
  }

  /** 按 receivedAt 升序列出待重放消息(损坏项跳过)。 */
  async list(): Promise<PendingInbound[]> {
    const dir = weixinPendingDir()
    if (!existsSync(dir)) return []
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'processed.json')
    } catch {
      return []
    }
    const out: PendingInbound[] = []
    for (const f of files) {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), 'utf-8')) as Partial<PendingInbound>
        if (!raw.messageId || !raw.chatId) continue
        out.push({
          messageId: raw.messageId,
          accountId: raw.accountId ?? '',
          chatType: raw.chatType === 'group' ? 'group' : 'dm',
          chatId: raw.chatId,
          senderId: raw.senderId ?? '',
          text: raw.text ?? '',
          mediaPaths: raw.mediaPaths ?? [],
          mediaTypes: raw.mediaTypes ?? [],
          contextToken: raw.contextToken ?? null,
          receivedAt: raw.receivedAt ?? 0,
        })
      } catch {
        // 损坏项:删掉,避免每次启动都重扫
        try { await unlink(join(dir, f)) } catch { /* ignore */ }
      }
    }
    return out.sort((a, b) => a.receivedAt - b.receivedAt)
  }

  async count(): Promise<number> {
    const dir = weixinPendingDir()
    if (!existsSync(dir)) return 0
    try {
      return (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'processed.json').length
    } catch {
      return 0
    }
  }

  async isProcessed(messageId: string): Promise<boolean> {
    await this.ensureProcessedLoaded()
    return this.processed.has(messageId)
  }

  /** 标记已成功注入(幂等键)。 */
  async markProcessed(messageId: string, now = Date.now()): Promise<void> {
    await this.ensureProcessedLoaded()
    this.processed.set(messageId, now)
    this.writeChain = this.writeChain.then(() => this.persistProcessed()).catch(() => { /* ignore */ })
  }

  private async persistProcessed(): Promise<void> {
    await mkdir(weixinPendingDir(), { recursive: true })
    const now = Date.now()
    for (const [id, ts] of this.processed) {
      if (now - ts > PROCESSED_TTL_MS) this.processed.delete(id)
    }
    const path = processedFilePath()
    const tmp = `${path}.tmp`
    const payload: ProcessedFile = { ids: Object.fromEntries(this.processed) }
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: FILE_MODE })
    await rename(tmp, path)
  }

  /** 等待所有排队中的落盘完成(测试 teardown / 停机前 flush)。 */
  async flush(): Promise<void> {
    await this.writeChain
  }

  reset(): void {
    this.processed.clear()
    this.processedLoaded = false
  }
}

let _instance: WeixinPendingStore | null = null

export function getWeixinPendingStore(): WeixinPendingStore {
  if (!_instance) _instance = new WeixinPendingStore()
  return _instance
}

export function resetWeixinPendingStoreForTests(): void {
  if (_instance) _instance.reset()
  _instance = null
}

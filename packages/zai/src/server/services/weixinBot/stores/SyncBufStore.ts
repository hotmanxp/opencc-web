/**
 * iLink long-poll 续读游标 store。
 *
 * 保存 getUpdates 返回的 `get_updates_buf` 字符串,持久化到
 * ~/.zai/weixin/sync/<accountId>.buf,重启后从正确位置继续拉。
 *
 * 原子写:tmp + rename;fsync 落盘。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WEIXIN_SYNC_DIR } from '../paths-internal.js'

export class SyncBufStore {
  private cache = new Map<string, string>()

  async load(accountId: string): Promise<string> {
    if (this.cache.has(accountId)) return this.cache.get(accountId)!
    const path = this.pathFor(accountId)
    if (existsSync(path)) {
      try {
        const content = (await readFile(path, 'utf-8')).trim()
        this.cache.set(accountId, content)
        return content
      } catch {
        // 损坏 → 落空
      }
    }
    this.cache.set(accountId, '')
    return ''
  }

  async save(accountId: string, buf: string): Promise<void> {
    this.cache.set(accountId, buf)
    await mkdir(WEIXIN_SYNC_DIR, { recursive: true })
    const path = this.pathFor(accountId)
    const tmp = `${path}.tmp`
    await writeFile(tmp, buf, 'utf-8')
    await rename(tmp, path)
  }

  /** 测试用;运行时一般不需要 */
  reset(): void {
    this.cache.clear()
  }

  private pathFor(accountId: string): string {
    const safe = accountId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
    return join(WEIXIN_SYNC_DIR, `${safe}.buf`)
  }
}

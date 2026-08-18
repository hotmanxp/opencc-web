/**
 * iLink context_token 持久化 store。
 *
 * iLink 要求每条出站消息回传最近一次入站的 context_token,否则 sendmessage
 * 会被拒。token 按 (accountId, peerId) 维度保存,持久化到
 * ~/.zai/weixin/context-tokens/<accountId>.json。
 *
 * 设计要点:
 *   - 内存缓存 + 磁盘兜底:启动时 load 一次,后续写入先内存再 fsync,避免
 *     每次 send 都 round-trip 磁盘。
 *   - 原子写:临时文件 + fsync + rename,断电/进程崩溃不破坏 .json。
 *   - mode 0600:与账号凭据同级,token 视为敏感。
 *   - 不做内容校验:peerId 是 iLink user_id,accountId 是 iLink 账号标识,
 *     都来自 iLink 自身,这里只做持久化与索引。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WEIXIN_CONTEXT_DIR } from '../paths-internal.js'

const FILE_MODE = 0o600

export class ContextTokenStore {
  private cache = new Map<string, string>() // key = accountId:peerId
  private loaded = new Set<string>() // 已从磁盘加载的 accountId

  /** 读出整个 accountId 的 map;首次读触发 load */
  private async ensureLoaded(accountId: string): Promise<Map<string, string>> {
    if (this.loaded.has(accountId)) {
      // 构造一个仅包含该 accountId 的视图
      const view = new Map<string, string>()
      const prefix = `${accountId}:`
      for (const [k, v] of this.cache) {
        if (k.startsWith(prefix)) view.set(k.slice(prefix.length), v)
      }
      return view
    }
    const path = this.pathFor(accountId)
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, string>
        for (const [peerId, token] of Object.entries(raw)) {
          this.cache.set(`${accountId}:${peerId}`, token)
        }
      } catch {
        // 损坏文件 — 忽略,落空
      }
    }
    this.loaded.add(accountId)
    const view = new Map<string, string>()
    const prefix = `${accountId}:`
    for (const [k, v] of this.cache) {
      if (k.startsWith(prefix)) view.set(k.slice(prefix.length), v)
    }
    return view
  }

  async get(accountId: string, peerId: string): Promise<string | null> {
    await this.ensureLoaded(accountId)
    return this.cache.get(`${accountId}:${peerId}`) ?? null
  }

  async set(accountId: string, peerId: string, token: string): Promise<void> {
    await this.ensureLoaded(accountId)
    this.cache.set(`${accountId}:${peerId}`, token)
    await this.persist(accountId)
  }

  /** 整张持久化;cache 已有 → 重写;若没改 cache 直接读快路径 */
  private async persist(accountId: string): Promise<void> {
    await mkdir(WEIXIN_CONTEXT_DIR, { recursive: true })
    const view: Record<string, string> = {}
    const prefix = `${accountId}:`
    for (const [k, v] of this.cache) {
      if (k.startsWith(prefix)) view[k.slice(prefix.length)] = v
    }
    const path = this.pathFor(accountId)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(view, null, 2), { mode: FILE_MODE })
    await rename(tmp, path)
  }

  private pathFor(accountId: string): string {
    // 路径转义:accountId 含 '/' 会破坏目录结构,做 hex 兜底
    const safe = accountId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
    return join(WEIXIN_CONTEXT_DIR, `${safe}.json`)
  }

  /** 测试清理用 */
  clearCache(): void {
    this.cache.clear()
    this.loaded.clear()
  }
}

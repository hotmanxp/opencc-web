/**
 * WeixinSessionMap — 微信会话 ↔ zai sessionId 的持久化映射表(D1)。
 *
 * 为什么不直接把 `weixin:<acct>:<chatType>:<chatId>` 当 sessionId:
 *   zai 全仓库对 sessionId 的隐含契约是 `sess-<uuid>` / 字符集
 *   `[a-z0-9-]`,并且有代码显式依赖 —— transcript 文件名直接拼 sessionId
 *   (`compat/transcript/legacyTranscriptStore.ts` → `${sessionId}.jsonl`)、
 *   `compat/taskListStore.ts` 的 sanitize 注释明写假设该字符集、前端
 *   session 列表 / URL 全链路。带 `:` 的 ID 会一路漏到文件名与 URL。
 *
 * 所以这里用一张显式映射表换正确性:
 *   - sessionId 合规 → transcript / Web UI / 前端零特判;
 *   - 出站按 sessionId **O(1) 精确反查** conversationKey,取代过去
 *     `sid.split(':').slice(3).join(':')` 的脆弱 hack;
 *   - 「这个微信对话绑定到哪个 project cwd」有了显式落点,直接决定
 *     Web UI 里能不能看到这个对话;
 *   - 重启后同一微信用户延续同一个 session,对话历史不断。
 *
 * 持久化:`~/.zai/weixin/sessions.json`(mode 0600,原子写)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { WeixinSessionBinding } from '../../../shared/weixin.js'
import { weixinDataDir, weixinSessionsFile } from '../paths.js'

const FILE_MODE = 0o600

export interface ResolveWeixinSessionInput {
  accountId: string
  chatType: 'dm' | 'group'
  chatId: string
  senderId: string
  displayName?: string
}

/** `${accountId}:${chatType}:${chatId}` —— 与 iLink 会话天然一一对应。 */
export function conversationKeyOf(input: {
  accountId: string
  chatType: 'dm' | 'group'
  chatId: string
}): string {
  return `${input.accountId}:${input.chatType}:${input.chatId}`
}

export class WeixinSessionMap {
  private byConversation = new Map<string, WeixinSessionBinding>()
  private bySessionId = new Map<string, WeixinSessionBinding>()
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  /** 轮转 TTL(ms);null/0 = 永不轮转。由 manager 从 settings 注入。 */
  private rotationTtlMs: number | null = null
  /** 轮转事件待消费队列:conversationKey → 轮转信息(bridge 取走后清除)。 */
  private pendingRotations = new Map<
    string,
    { fromSessionId: string; toSessionId: string; reason: string; at: number }
  >()

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = weixinSessionsFile()
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8')) as unknown
      const list = Array.isArray(raw) ? raw : []
      for (const item of list) {
        const b = item as Partial<WeixinSessionBinding>
        if (!b.conversationKey || !b.sessionId) continue
        const binding: WeixinSessionBinding = {
          conversationKey: b.conversationKey,
          sessionId: b.sessionId,
          cwd: b.cwd ?? '',
          accountId: b.accountId ?? '',
          chatType: b.chatType === 'group' ? 'group' : 'dm',
          chatId: b.chatId ?? '',
          senderId: b.senderId ?? '',
          ...(b.displayName ? { displayName: b.displayName } : {}),
          createdAt: b.createdAt ?? Date.now(),
          lastActiveAt: b.lastActiveAt ?? Date.now(),
        }
        this.byConversation.set(binding.conversationKey, binding)
        this.bySessionId.set(binding.sessionId, binding)
      }
    } catch {
      // 损坏文件 — 视为空表(不阻断启动)
    }
  }

  /** 查已有绑定(不创建)。 */
  async lookupByConversationKey(key: string): Promise<WeixinSessionBinding | null> {
    await this.ensureLoaded()
    return this.byConversation.get(key) ?? null
  }

  /** 出站反查:sessionId → 绑定。O(1)。 */
  async lookupBySessionId(sessionId: string): Promise<WeixinSessionBinding | null> {
    await this.ensureLoaded()
    return this.bySessionId.get(sessionId) ?? null
  }

  /** 同步快照(已加载后可用),给出站热路径省一次 await。 */
  lookupBySessionIdSync(sessionId: string): WeixinSessionBinding | null {
    return this.bySessionId.get(sessionId) ?? null
  }

  /**
   * 注入轮转策略。ttlMs <= 0 或 null 表示永不轮转。
   * manager 在 start() 时从 settings.weixinBot.sessionTtlHours 换算传入。
   */
  setRotationPolicy(opts: { ttlMs: number | null }): void {
    this.rotationTtlMs = opts.ttlMs != null && opts.ttlMs > 0 ? opts.ttlMs : null
  }

  /**
   * 取走并清除该会话的待处理轮转事件(若有)。
   * bridge 在 resolveOrCreate 后调用:有返回值说明刚发生了轮转,
   * 应触发旧会话的记忆沉淀。
   */
  takeRotation(
    conversationKey: string,
  ): { fromSessionId: string; toSessionId: string; reason: string; at: number } | null {
    const evt = this.pendingRotations.get(conversationKey) ?? null
    this.pendingRotations.delete(conversationKey)
    return evt
  }

  /**
   * 把 conversationKey 的绑定迁到新 sess-uuid。
   * 旧绑定保留在 bySessionId 里(在途 runtime 事件的出站镜像不断链),
   * 但从 byConversation 摘除 —— 新消息走新 session。
   * 不存在绑定时返回 null(无事可轮转)。
   */
  async rotate(
    conversationKey: string,
    reason: string,
  ): Promise<{ old: WeixinSessionBinding; fresh: WeixinSessionBinding } | null> {
    await this.ensureLoaded()
    const oldBinding = this.byConversation.get(conversationKey)
    if (!oldBinding) return null
    const now = Date.now()
    const fresh: WeixinSessionBinding = {
      ...oldBinding,
      sessionId: `sess-${randomUUID()}`,
      createdAt: now,
      lastActiveAt: now,
    }
    // 旧绑定从 conversation 索引摘除但保留 sessionId 索引;
    // 持久化文件只写 byConversation(values),旧绑定重启后自然淡出。
    this.byConversation.set(conversationKey, fresh)
    this.bySessionId.set(fresh.sessionId, fresh)
    this.pendingRotations.set(conversationKey, {
      fromSessionId: oldBinding.sessionId,
      toSessionId: fresh.sessionId,
      reason,
      at: now,
    })
    await this.enqueuePersist()
    return { old: oldBinding, fresh }
  }

  /**
   * 取该微信会话的绑定;不存在则新建一个合规 sessionId 并落盘。
   * `cwd` 只在首次创建时写入 —— 后续不覆盖,避免服务重启换了 cwd 之后
   * 老对话被"搬走"到另一个 project。
   *
   * 轮转:绑定存在且存活超过 rotationTtlMs → 自动迁入新 session,
   * 并在 pendingRotations 留事件供 bridge 消费(记忆沉淀)。
   */
  async resolveOrCreate(
    input: ResolveWeixinSessionInput,
    cwd: string,
  ): Promise<WeixinSessionBinding> {
    await this.ensureLoaded()
    const key = conversationKeyOf(input)
    const now = Date.now()
    const existing = this.byConversation.get(key)
    if (existing) {
      if (this.rotationTtlMs != null && now - existing.createdAt >= this.rotationTtlMs) {
        const rotated = await this.rotate(key, 'ttl')
        if (rotated) return rotated.fresh
      }
      let changed = false
      if (existing.senderId !== input.senderId) {
        existing.senderId = input.senderId
        changed = true
      }
      if (input.displayName && existing.displayName !== input.displayName) {
        existing.displayName = input.displayName
        changed = true
      }
      existing.lastActiveAt = now
      if (changed) await this.enqueuePersist()
      else this.schedulePersist()
      return existing
    }
    const binding: WeixinSessionBinding = {
      conversationKey: key,
      sessionId: `sess-${randomUUID()}`,
      cwd,
      accountId: input.accountId,
      chatType: input.chatType,
      chatId: input.chatId,
      senderId: input.senderId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      createdAt: now,
      lastActiveAt: now,
    }
    this.byConversation.set(key, binding)
    this.bySessionId.set(binding.sessionId, binding)
    await this.enqueuePersist()
    return binding
  }

  /** 更新最近活跃时间(不立即落盘 —— lastActiveAt 丢了无害)。 */
  touch(sessionId: string): void {
    const b = this.bySessionId.get(sessionId)
    if (!b) return
    b.lastActiveAt = Date.now()
    this.schedulePersist()
  }

  /** 列出全部绑定(供 Web 面板 / 诊断)。 */
  async list(): Promise<WeixinSessionBinding[]> {
    await this.ensureLoaded()
    return [...this.byConversation.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  async size(): Promise<number> {
    await this.ensureLoaded()
    return this.byConversation.size
  }

  /** 等待所有排队中的落盘完成(测试 teardown / 停机前 flush)。 */
  async flush(): Promise<void> {
    await this.writeChain
  }

  /** 测试 / 运维:清空映射(不删文件)。 */
  reset(): void {
    this.byConversation.clear()
    this.bySessionId.clear()
    this.pendingRotations.clear()
    this.loaded = false
  }

  private schedulePersist(): void {
    void this.enqueuePersist()
  }

  /**
   * 所有落盘都串行经过 writeChain —— 否则两个 persist 并发写同一个
   * `<file>.tmp` 会互相 rename 掉对方(ENOENT)。
   */
  private enqueuePersist(): Promise<void> {
    const next = this.writeChain.then(() => this.persist()).catch(() => { /* 落盘失败不阻断 */ })
    this.writeChain = next
    return next
  }

  private async persist(): Promise<void> {
    await mkdir(weixinDataDir(), { recursive: true })
    const path = weixinSessionsFile()
    // 唯一 tmp 名 —— 即便有未知的并发路径也不会互相覆盖。
    const tmp = `${path}.${process.pid}.${Date.now()}.${(this.tmpSeq += 1)}.tmp`
    const payload = JSON.stringify([...this.byConversation.values()], null, 2)
    await writeFile(tmp, payload, { mode: FILE_MODE })
    await rename(tmp, path)
  }

  private tmpSeq = 0
}

let _instance: WeixinSessionMap | null = null

export function getWeixinSessionMap(): WeixinSessionMap {
  if (!_instance) _instance = new WeixinSessionMap()
  return _instance
}

export function resetWeixinSessionMapForTests(): void {
  if (_instance) _instance.reset()
  _instance = null
}

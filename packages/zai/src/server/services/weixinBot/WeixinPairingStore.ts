/**
 * WeixinPairingStore — 微信 DM 配对鉴权(P1 / D5)。
 *
 * 背景(高危):`accessPolicy.ts` 的 `dmPolicy: 'pairing'` 原本是**无条件放行**
 * —— 注释写「首次扫码后接受所有 DM」,但没有配对码、没有持久化配对表、没有
 * 待批准流程。个人微信号 bot 一旦被陌生人加好友,对方就能驱动本机 agent
 * 执行 bash / 读写文件 —— 这是远程代码执行面,不是体验问题。
 *
 * 本 store 把 pairing 变成真正的准入:
 *   1. 未配对用户发消息 → **不注入 agent**,回一条配对码提示;
 *   2. Web 面板显示待批准列表,管理员批准 / 拒绝;
 *   3. 批准后写入 `allowed`,后续消息正常注入;
 *   4. `allowlist` 策略与 `allowed` 取并集(静态配置 + 动态批准)。
 *
 * 配对码:6 位数字,TTL 10 分钟,单 senderId 最多 3 次申领 / 3 次回码尝试,
 * 防暴力枚举。
 *
 * 持久化:`~/.zai/weixin/pairings.json`(mode 0600,原子写)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import type { WeixinPairingAllowed, WeixinPairingPending, WeixinPairings } from '../../../shared/weixin.js'
import { weixinDataDir, weixinPairingsFile } from '../paths.js'

const FILE_MODE = 0o600
export const PAIRING_CODE_TTL_MS = 10 * 60_000
/** 单 senderId 在 1 小时内最多申领次数 */
export const PAIRING_MAX_REQUESTS_PER_HOUR = 3
/** 单 senderId 最多回码尝试次数 */
export const PAIRING_MAX_VERIFY_ATTEMPTS = 3
const REQUEST_WINDOW_MS = 60 * 60_000

interface PairingsFile {
  allowed: WeixinPairingAllowed[]
  pending: WeixinPairingPending[]
  /** senderId → 最近一小时的申领时间戳,用于限次 */
  requests?: Record<string, number[]>
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface PairingRequestResult {
  code: string
  expiresAt: number
  /** true = 复用了未过期的既有码;false = 新生成 */
  reused: boolean
  /** 超出申领上限时为 true,此时不返回新码 */
  rateLimited?: boolean
}

export class WeixinPairingStore {
  private allowed = new Map<string, WeixinPairingAllowed>()
  private pending = new Map<string, WeixinPairingPending>()
  private requests = new Map<string, number[]>()
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = weixinPairingsFile()
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<PairingsFile>
      for (const a of raw.allowed ?? []) {
        if (a?.senderId) this.allowed.set(a.senderId, { ...a, approvedVia: a.approvedVia ?? 'web' })
      }
      for (const p of raw.pending ?? []) {
        if (p?.senderId) this.pending.set(p.senderId, { ...p, attempts: p.attempts ?? 0 })
      }
      for (const [k, v] of Object.entries(raw.requests ?? {})) {
        if (Array.isArray(v)) this.requests.set(k, v)
      }
    } catch {
      // 损坏文件 → 空表(不阻断启动)
    }
  }

  private prunePending(now = Date.now()): boolean {
    let changed = false
    for (const [senderId, p] of this.pending) {
      if (p.expiresAt <= now) {
        this.pending.delete(senderId)
        changed = true
      }
    }
    for (const [senderId, list] of this.requests) {
      const kept = list.filter((ts) => now - ts <= REQUEST_WINDOW_MS)
      if (kept.length !== list.length) {
        if (kept.length === 0) this.requests.delete(senderId)
        else this.requests.set(senderId, kept)
        changed = true
      }
    }
    return changed
  }

  async list(): Promise<WeixinPairings> {
    await this.ensureLoaded()
    if (this.prunePending()) this.schedulePersist()
    return {
      allowed: [...this.allowed.values()],
      pending: [...this.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt),
    }
  }

  async isAllowed(senderId: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.allowed.has(senderId)
  }

  /** 同步视图 —— 给 WeixinAdapter 的动态 allowlist provider 用(热路径无 await)。 */
  allowedSenderIds(): string[] {
    return [...this.allowed.keys()]
  }

  /**
   * 申领配对码。同一 senderId 在码未过期时复用同一码(避免刷屏)。
   * 超过 1 小时 3 次申领 → `rateLimited`。
   */
  async requestPairing(
    senderId: string,
    displayName?: string,
    now = Date.now(),
  ): Promise<PairingRequestResult> {
    await this.ensureLoaded()
    this.prunePending(now)

    const existing = this.pending.get(senderId)
    if (existing) {
      if (displayName && existing.displayName !== displayName) {
        existing.displayName = displayName
      }
      return { code: existing.code, expiresAt: existing.expiresAt, reused: true }
    }

    const history = this.requests.get(senderId) ?? []
    const withinWindow = history.filter((ts) => now - ts <= REQUEST_WINDOW_MS)
    if (withinWindow.length >= PAIRING_MAX_REQUESTS_PER_HOUR) {
      return { code: '', expiresAt: 0, reused: false, rateLimited: true }
    }
    withinWindow.push(now)
    this.requests.set(senderId, withinWindow)

    const entry: WeixinPairingPending = {
      senderId,
      ...(displayName ? { displayName } : {}),
      code: generateCode(),
      requestedAt: now,
      expiresAt: now + PAIRING_CODE_TTL_MS,
      attempts: 0,
    }
    this.pending.set(senderId, entry)
    await this.enqueuePersist()
    return { code: entry.code, expiresAt: entry.expiresAt, reused: false }
  }

  /** Web 面板批准:把待批准项(或直接指定 senderId)移入白名单。 */
  async approve(senderId: string, via: 'web' | 'code' = 'web', now = Date.now()): Promise<boolean> {
    await this.ensureLoaded()
    const p = this.pending.get(senderId)
    this.pending.delete(senderId)
    this.requests.delete(senderId)
    const entry: WeixinPairingAllowed = {
      senderId,
      ...(p?.displayName ? { displayName: p.displayName } : {}),
      pairedAt: now,
      approvedVia: via,
    }
    this.allowed.set(senderId, entry)
    await this.enqueuePersist()
    return true
  }

  async reject(senderId: string): Promise<boolean> {
    await this.ensureLoaded()
    const had = this.pending.delete(senderId)
    if (had) await this.enqueuePersist()
    return had
  }

  /** 移除已批准用户(吊销)。 */
  async revoke(senderId: string): Promise<boolean> {
    await this.ensureLoaded()
    const had = this.allowed.delete(senderId)
    if (had) await this.enqueuePersist()
    return had
  }

  /**
   * 回码校验(用户在微信里回「配对码 123456」)。命中且未过期且尝试次数
   * 未超限 → 直接批准。失败累计 attempts,超限作废该码。
   */
  async verifyCode(
    senderId: string,
    code: string,
    now = Date.now(),
  ): Promise<{ ok: boolean; reason: string }> {
    await this.ensureLoaded()
    const p = this.pending.get(senderId)
    if (!p) return { ok: false, reason: 'no-pending' }
    if (p.expiresAt <= now) {
      this.pending.delete(senderId)
      await this.enqueuePersist()
      return { ok: false, reason: 'expired' }
    }
    if (p.attempts >= PAIRING_MAX_VERIFY_ATTEMPTS) {
      this.pending.delete(senderId)
      await this.enqueuePersist()
      return { ok: false, reason: 'too-many-attempts' }
    }
    if (p.code !== code.trim()) {
      p.attempts += 1
      if (p.attempts >= PAIRING_MAX_VERIFY_ATTEMPTS) this.pending.delete(senderId)
      await this.enqueuePersist()
      return { ok: false, reason: 'mismatch' }
    }
    await this.approve(senderId, 'code', now)
    return { ok: true, reason: 'approved' }
  }

  /** 等待所有排队中的落盘完成(测试 teardown / 停机前 flush)。 */
  async flush(): Promise<void> {
    await this.writeChain
  }

  reset(): void {
    this.allowed.clear()
    this.pending.clear()
    this.requests.clear()
    this.loaded = false
  }

  private schedulePersist(): void {
    void this.enqueuePersist()
  }

  /**
   * 所有落盘都串行经过 writeChain —— 否则并发的 persist 会争抢同一个
   * `<file>.tmp` 互相 rename 掉对方(ENOENT)。
   */
  private enqueuePersist(): Promise<void> {
    const next = this.writeChain.then(() => this.persist()).catch(() => { /* ignore */ })
    this.writeChain = next
    return next
  }

  private async persist(): Promise<void> {
    await mkdir(weixinDataDir(), { recursive: true })
    const path = weixinPairingsFile()
    const tmp = `${path}.${process.pid}.${Date.now()}.${(this.tmpSeq += 1)}.tmp`
    const payload: PairingsFile = {
      allowed: [...this.allowed.values()],
      pending: [...this.pending.values()],
      requests: Object.fromEntries(this.requests),
    }
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: FILE_MODE })
    await rename(tmp, path)
  }

  private tmpSeq = 0
}

let _instance: WeixinPairingStore | null = null

export function getWeixinPairingStore(): WeixinPairingStore {
  if (!_instance) _instance = new WeixinPairingStore()
  return _instance
}

export function resetWeixinPairingStoreForTests(): void {
  if (_instance) _instance.reset()
  _instance = null
}

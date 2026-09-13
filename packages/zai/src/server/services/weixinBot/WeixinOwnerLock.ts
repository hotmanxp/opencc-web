/**
 * WeixinOwnerLock — 全局单实例锁(P5)。
 *
 * 语义(用户硬约束):
 *   一台电脑上,同一时刻**只有一个**助手实例可以「接收 / 处理 / 发送」
 *   微信消息,并与用户对接。其余实例必须待命(standby),不得 poll
 *   iLink、不得订阅出站、不得发送任何消息。
 *
 * 与 `AccountLock` 的区别:
 *   - `AccountLock` 是按 **token** 粒度的锁,只保证「同一个 bot 不被两个
 *     poller 抢」;两个不同 token / 不同 ZAI_DATA_DIR 的实例仍可各跑各的。
 *   - `WeixinOwnerLock` 是**机器级**锁(固定在 `~/.zai/weixin/locks/`,
 *     不随 ZAI_DATA_DIR 漂移),保证「一台机器只有一个助手」这个更强的
 *     不变量 —— 覆盖接收 + 处理 + 出站 + 用户对接的全部通道。
 *
 * 实现:proper-lockfile 目录锁(跨平台,stale 自动回收)。
 *   - `owner.lock`   互斥体(proper-lockfile 维护)
 *   - `owner.json`   持有者元数据(pid / instanceId / port / cwd / accountId),
 *                    供 Web 面板与 `GET /api/weixin/status` 展示「谁在持有」。
 *   持有者进程死亡 → 锁在 stale 窗口后自动可回收;`owner.json` 保留,
 *   `read()` 会标 `live: false`,供面板提示「可接管」。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import lockfile from 'proper-lockfile'
import { weixinOwnerFile, weixinOwnerLockFile, weixinOwnerLockRoot } from '../paths.js'

/** 持有者元数据。 */
export interface WeixinOwnerInfo {
  /** ZAI_INSTANCE_ID(instanceSupervisor 托管时为 inst_xxx;顶层 supervisor 为 'current') */
  instanceId: string
  pid: number
  supervisorPid: number | null
  port: number | null
  cwd: string
  accountId: string
  hostname: string
  startedAt: number
}

export interface WeixinOwnerHandle {
  readonly info: WeixinOwnerInfo
  /** 元数据变更(例如 QR 确认后 accountId 落定)时刷新 owner.json。 */
  update(patch: Partial<WeixinOwnerInfo>): Promise<void>
  release(): Promise<void>
}

export type WeixinOwnerAcquireResult =
  | { ok: true; handle: WeixinOwnerHandle }
  | { ok: false; heldBy: WeixinOwnerInfo | null; reason: string }

export interface WeixinOwnerSnapshot {
  info: WeixinOwnerInfo
  /** proper-lockfile 是否仍认为锁被真实持有(stale 检测)。 */
  live: boolean
  self: boolean
}

/** 长任务持有者需要持续刷新 mtime;30s stale + 10s update 给足容错。 */
const OWNER_STALE_MS = 30_000
const OWNER_UPDATE_MS = 10_000

async function readOwnerFile(): Promise<WeixinOwnerInfo | null> {
  const path = weixinOwnerFile()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Partial<WeixinOwnerInfo>
    if (typeof raw.pid !== 'number') return null
    return {
      instanceId: raw.instanceId ?? 'unknown',
      pid: raw.pid,
      supervisorPid: raw.supervisorPid ?? null,
      port: raw.port ?? null,
      cwd: raw.cwd ?? '',
      accountId: raw.accountId ?? '',
      hostname: raw.hostname ?? '',
      startedAt: raw.startedAt ?? 0,
    }
  } catch {
    return null
  }
}

async function writeOwnerFile(info: WeixinOwnerInfo): Promise<void> {
  await mkdir(weixinOwnerLockRoot(), { recursive: true })
  await writeFile(weixinOwnerFile(), JSON.stringify(info, null, 2), { mode: 0o600 })
}

async function isLockLive(): Promise<boolean> {
  const lockPath = weixinOwnerLockFile()
  if (!existsSync(lockPath)) return false
  try {
    return await lockfile.check(lockPath, { stale: OWNER_STALE_MS })
  } catch {
    return false
  }
}

export class WeixinOwnerLock {
  private released = false

  private constructor(
    private readonly releaseFn: () => Promise<void>,
    private _info: WeixinOwnerInfo,
  ) {}

  get info(): WeixinOwnerInfo {
    return this._info
  }

  async update(patch: Partial<WeixinOwnerInfo>): Promise<void> {
    if (this.released) return
    this._info = { ...this._info, ...patch }
    try {
      await writeOwnerFile(this._info)
    } catch {
      // 元数据刷新失败不影响锁的持有性
    }
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    // 先撤元数据再放锁:顺序反过来会出现「锁已释放但 owner.json 仍在」
    // 的窗口,read() 会误报一个不存在的持有者。撤失败也不阻断放锁。
    try {
      await unlink(weixinOwnerFile())
    } catch {
      /* 元数据文件可能已被 forceTakeover 清掉 */
    }
    try {
      await this.releaseFn()
    } catch {
      // 释放失败 → 锁会被 stale 回收
    }
  }

  /**
   * 尝试成为机器级 owner。失败不抛 —— 调用方应把它当作「另一实例持有,
   * 本进程待命」的正常分支处理,而不是启动失败。
   */
  static async acquire(info: WeixinOwnerInfo): Promise<WeixinOwnerAcquireResult> {
    const lockPath = weixinOwnerLockFile()
    try {
      await mkdir(weixinOwnerLockRoot(), { recursive: true })
      if (!existsSync(lockPath)) {
        await writeFile(lockPath, '', { mode: 0o600 })
      }
    } catch (err) {
      return { ok: false, heldBy: await readOwnerFile(), reason: `prepare failed: ${(err as Error).message}` }
    }

    let releaseFn: (() => Promise<void>) | null = null
    try {
      releaseFn = await lockfile.lock(lockPath, {
        stale: OWNER_STALE_MS,
        update: OWNER_UPDATE_MS,
        // fail-fast:owner 是机器级单例,等待重试没有意义 —— 拿到就干活,
        // 拿不到就进入 standby,由用户决定是否接管。
        retries: { retries: 1, minTimeout: 50, maxTimeout: 120 },
        realpath: false,
      })
    } catch (err) {
      const heldBy = await readOwnerFile()
      return {
        ok: false,
        heldBy,
        reason: heldBy
          ? `held by pid=${heldBy.pid} instance=${heldBy.instanceId}`
          : `lock busy: ${(err as Error).message}`,
      }
    }

    try {
      await writeOwnerFile(info)
    } catch (err) {
      // 写元数据失败不应让锁悬空(会导致无人 poll 但别人也拿不到)
      try { await releaseFn() } catch { /* ignore */ }
      return { ok: false, heldBy: await readOwnerFile(), reason: `write owner.json failed: ${(err as Error).message}` }
    }
    return { ok: true, handle: new WeixinOwnerLock(releaseFn, info) }
  }

  /** 读当前持有者快照(无论死活)。锁目录不存在 → null。 */
  static async read(): Promise<WeixinOwnerSnapshot | null> {
    const info = await readOwnerFile()
    if (!info) return null
    const live = await isLockLive()
    return { info, live, self: info.pid === process.pid }
  }

  /**
   * 强制清除一个**非存活**持有者留下的锁与元数据(P7 手动接管)。
   *
   * 若锁仍被真实进程持有,直接拒绝 —— 避免把正在工作的实例踢掉,
   * 造成「两个实例都以为自己该 poll」的脑裂。
   */
  static async forceTakeover(): Promise<{ ok: boolean; reason: string }> {
    const snapshot = await WeixinOwnerLock.read()
    if (snapshot && snapshot.live && !snapshot.self) {
      return { ok: false, reason: `owner pid=${snapshot.info.pid} still alive` }
    }
    const lockPath = weixinOwnerLockFile()
    try {
      if (existsSync(lockPath)) {
        await lockfile.unlock(lockPath, { realpath: false })
      }
    } catch {
      // 已释放 / 已 stale → 视为成功
    }
    try {
      await unlink(weixinOwnerFile())
    } catch {
      /* ignore */
    }
    return { ok: true, reason: 'cleared' }
  }
}

/** 构造本进程的 owner 身份元数据。 */
export function buildSelfOwnerInfo(args: { cwd: string; accountId: string; port?: number | null }): WeixinOwnerInfo {
  const supervisorPidRaw = process.env.ZAI_SUPERVISOR_PID
  const supervisorPid = supervisorPidRaw && Number.isFinite(Number(supervisorPidRaw)) ? Number(supervisorPidRaw) : null
  return {
    instanceId: process.env.ZAI_INSTANCE_ID ?? 'current',
    pid: process.pid,
    supervisorPid,
    port: args.port ?? (Number(process.env.ZAI_PORT) || null),
    cwd: args.cwd,
    accountId: args.accountId,
    hostname: hostname(),
    startedAt: Date.now(),
  }
}

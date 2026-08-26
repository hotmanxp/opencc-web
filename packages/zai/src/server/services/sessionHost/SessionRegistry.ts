/**
 * SessionRegistry —— 全局 `Map<sessionId, SessionHost>`,每个 zai 会话
 * 一个常驻子进程。spawn 是**会话级**不是请求级(spec §5.5.1):用户发多条
 * prompt 复用同一 host 写 stdin;只有新会话 / 子进程死亡恢复 / model 切换
 * 才会 spawn 新 host。
 */

import { SessionHost } from './SessionHost.js'
import type { SessionHostState } from './types.js'

export interface SpawnHostOpts {
  cwd: string
  model?: string
  /** 是否从 JSONL hydrate(Phase C 使能;Phase A 恒 false)。 */
  resume?: boolean
}

export class SessionRegistry {
  private hosts = new Map<string, SessionHost>()

  /** 获取(必要)并 spawn 会话 host。已存在且正常 → 直接返回。 */
  getOrSpawn(sid: string, opts: SpawnHostOpts): SessionHost {
    const existing = this.hosts.get(sid)
    if (existing && existing.isAlive()) {
      // model 切换 → kill 旧 host + spawn 新 host(子进程 model 是启动时
      // 一次性写入,见 spec §5.5.1)。
      const oldModel = existing.getModel()
      if (opts.model && oldModel !== opts.model) {
        console.warn(
          `[SessionRegistry] session ${sid} model 切换 ${oldModel ?? 'default'} -> ${opts.model},respawn`,
        )
        existing.kill()
        this.hosts.delete(sid)
      } else {
        return existing
      }
    } else if (existing) {
      // 旧 host 已死(崩溃 / 被 kill):淘汰,spawn 新 host。resume 由上层
      // 决定 —— 子进程 --no-session-persistence 不落盘,Phase A 直接新建。
      console.warn(
        `[SessionRegistry] session ${sid} 旧 host 已死,重建`,
      )
      this.hosts.delete(sid)
    }
    const host = new SessionHost(sid, { ...opts, sessionId: sid })
    host.spawn()
    this.hosts.set(sid, host)
    return host
  }

  get(sid: string): SessionHost | undefined {
    return this.hosts.get(sid)
  }

  /** 全部已登记 sessionId(调试 / 健康检查用)。 */
  list(): string[] {
    return Array.from(this.hosts.keys())
  }

  /** 终止指定会话 host(不抛异常,幂等)。 */
  kill(sid: string, reason?: string): void {
    const host = this.hosts.get(sid)
    if (!host) return
    if (reason) {
      console.debug(`[SessionRegistry] kill ${sid} reason=${reason}`)
    }
    host.kill()
    this.hosts.delete(sid)
  }

  /** 终止全部会话 host(zai server SIGTERM / runtime.shutdown 时调用)。 */
  async killAll(reason?: string): Promise<void> {
    const hosts = Array.from(this.hosts.values())
    if (hosts.length > 0) {
      console.log(
        `[SessionRegistry] killAll ${
          reason ? `reason=${reason} ` : ''
        }hosts=${hosts.length}`,
      )
    }
    for (const host of hosts) host.kill()
    this.hosts.clear()
  }

  /** 当前活跃 host 数。 */
  get size(): number {
    return this.hosts.size
  }
}

export type { SessionHostState }
/**
 * weixinRuntimeBoot — 微信通道的启动策略(P6)。
 *
 * 硬约束(用户要求):微信通道**只由 supervisor 拉起的进程**启动。
 *
 * 为什么:微信通道持有的是「本机 agent 的远程入口」——消息一来就在本机跑
 * bash / 读写文件。它必须挂在**受管生命周期**下(supervisor 负责重启、
 * 心跳、实例回收);裸进程(`pnpm dev` / 直接 `node dist/cli/index.js start`
 * 且 `ZAI_NO_MANAGED=1`)启的通道既不会被监管,也容易和受管实例抢消息。
 *
 * 判定锚点:`isManagedChild()`(`ZAI_SUPERVISOR_PID` 存在且为合法数字)。
 * 两条 supervisor 链路都会注入它:
 *   - `cli/supervisor.ts`(顶层单进程)
 *   - `server/services/instanceSupervisor.ts`(多实例,额外带 ZAI_INSTANCE_ID)
 *
 * 非受管进程**不会**连接 iLink、不会注册出站订阅、不会发送任何消息。
 */
import { isManagedChild } from '../../../cli/managedChild.js'

export type WeixinBootReason =
  | 'started'
  | 'supervisor_required'
  | 'disabled'
  | 'unconfigured'
  | 'standby'
  | 'failed'

export interface WeixinBootResult {
  attempted: boolean
  reason: WeixinBootReason
  detail?: string
}

/**
 * 受管进程启动时的自动拉起入口。
 *
 * 非受管 → 直接返回 `supervisor_required`,不触碰 manager(不建 adapter,
 * 也就不会 poll)。受管 → 交给 `WeixinBotManager.start()` 继续做
 * settings 校验 + 全局 owner 锁竞争 + adapter connect。
 */
export async function maybeAutoStartWeixinBot(): Promise<WeixinBootResult> {
  if (!isManagedChild()) {
    console.warn(
      '[weixin.boot] skipped: this process was not launched by a supervisor ' +
        '(ZAI_SUPERVISOR_PID missing). Weixin channel only runs under supervisor-managed processes.',
    )
    return { attempted: false, reason: 'supervisor_required' }
  }
  try {
    const { getWeixinBotManager } = await import('./WeixinBotManager.js')
    const manager = getWeixinBotManager()
    await manager.start()
    const state = manager.state()
    const reason: WeixinBootReason =
      state === 'connected'
        ? 'started'
        : state === 'standby'
          ? 'standby'
          : state === 'disabled'
            ? 'disabled'
            : state === 'unconfigured'
              ? 'unconfigured'
              : 'failed'
    if (reason !== 'started') {
      console.warn(
        `[weixin.boot] auto-start finished with state=${state}${manager.status().lastError ? ` lastError=${manager.status().lastError}` : ''}`,
      )
    }
    return { attempted: true, reason, ...(manager.status().lastError ? { detail: manager.status().lastError } : {}) }
  } catch (err) {
    const detail = (err as Error).message
    console.warn('[weixin.boot] auto-start threw:', err)
    return { attempted: true, reason: 'failed', detail }
  }
}

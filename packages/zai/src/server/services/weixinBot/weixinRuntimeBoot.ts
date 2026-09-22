/**
 * weixinRuntimeBoot — 微信通道的启动策略(P6 + 2026-09-13 专用实例化)。
 *
 * 两条硬约束(用户要求):
 *   1) 微信通道**只由 supervisor 拉起的进程**启动;
 *   2) 并且**只有 `app=weixin` 的专用实例**才处理消息。
 *
 * 为什么必须挂在受管生命周期下:微信通道持有的是「本机 agent 的远程入口」——
 * 消息一来就在本机跑 bash / 读写文件。它必须由 supervisor 负责重启、心跳、
 * 实例回收;裸进程(`pnpm dev` / 直接 `node dist/cli/index.js start`
 * 且 `ZAI_NO_MANAGED=1`)启的通道既不会被监管,也容易和受管实例抢消息。
 *
 * 为什么必须收窄到专用实例:主实例是用户日常访问的 Web 服务。微信入站消息的
 * agent turn 必须和通道**同进程**(`sessionInbox` / `eventBus` 都是进程内内存态,
 * 见 weixinInboundBridge 的注入与 WeixinBotManager 的出站订阅),所以不能再让
 * 通道"谁先启动谁拿锁"地漂到主实例上。通道整体搬进一个 `app=weixin` 的独立
 * 受管实例,由主实例按配置拉起(见 weixinDedicatedInstance.ts)。
 *
 * 判定锚点(两道门禁都在 `WeixinBotManager.start()` 里,本模块只负责触发):
 *   - `isManagedChild()`:`ZAI_SUPERVISOR_PID` 存在且为合法数字。两条 supervisor
 *     链路都会注入它 —— `cli/supervisor.ts`(顶层单进程)与
 *     `server/services/instanceSupervisor.ts`(多实例,额外带 ZAI_INSTANCE_ID)。
 *   - `isWeixinChannelHost()`:`ZAI_APP === 'weixin'`(见 channelProfile.ts)。
 *
 * 因此非受管进程 / 非 weixin profile 进程**不会**连接 iLink、不会注册出站订阅、
 * 不会发送任何消息 —— 它们最多只跑到凭据探测那一步。
 */
import { isManagedChild } from '../../../cli/managedChild.js'
import { weixinDiag } from './debug.js'

export type WeixinBootReason =
  | 'started'
  | 'supervisor_required'
  /** 本进程不是 `app=weixin` 专用实例 —— 通道归专用实例,本进程不碰。 */
  | 'dedicated_instance_required'
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
 * 也就不会 poll)。
 *
 * 其余进程(含主实例)都要调一次 `manager.start()` —— 它会在**专用实例门禁**
 * 处立即返回(不建 adapter、不取 owner 锁、不 poll、不出站),但这次调用顺带
 * 完成了「本机有没有可用凭据(accountId + token)」的探测:`WeixinBotManager`
 * 的 `configured` 字段就来自那里,面板靠它决定显示"扫码登录"还是"设置"。
 * 跳过 start() 会让主实例的面板永远停在扫码形态 —— 连专用实例的端口 / 目录
 * 配置项都看不见。
 */
export async function maybeAutoStartWeixinBot(): Promise<WeixinBootResult> {
  if (!isManagedChild()) {
    weixinDiag(
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
          : state === 'dedicated_instance_required'
            ? 'dedicated_instance_required'
            : state === 'disabled'
              ? 'disabled'
              : state === 'unconfigured'
                ? 'unconfigured'
                : 'failed'
    // 启动日志默认静默(`ZAI_DEBUG=1` / `WEIXIN_DEBUG=1` 才输出):`unconfigured`
    // (没配凭据)、`disabled`(用户关掉开关)、`standby` / `dedicated_instance_required`
    // 都是设计上的正常稳态,每次启动都打会把日志淹掉 —— 2026-09-22 用户明确要求
    // 取消这些打印。只有 `failed` 才值得在无 debug 时也留痕。
    const bootLine = `[weixin.boot] auto-start finished with state=${state}${
      manager.status().lastError ? ` lastError=${manager.status().lastError}` : ''
    }`
    if (reason === 'failed') console.warn(bootLine)
    else if (reason !== 'started') weixinDiag(bootLine)
    return { attempted: true, reason, ...(manager.status().lastError ? { detail: manager.status().lastError } : {}) }
  } catch (err) {
    const detail = (err as Error).message
    console.warn('[weixin.boot] auto-start threw:', err)
    return { attempted: true, reason: 'failed', detail }
  }
}

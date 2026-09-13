/**
 * channelProfile — 微信通道宿主的 profile 判定(单一事实来源)。
 *
 * 用户硬约束(2026-09-13):**只有 `app=weixin` 的实例处理微信消息**。
 *
 * 演进背景:
 *   - 旧模型(P5/P6):通道归属靠"谁先启动谁抢到机器级 owner 锁",于是绝大多数
 *     情况下通道挂在用户日常访问的**主服务进程**上 —— 微信的 agent turn 和
 *     Web 会话挤在同一个进程里,且所有权随启动顺序漂移。
 *   - 新模型:主实例不再自己跑通道,而是按 `settings.weixinBot.enabled` 拉一个
 *     `app=weixin` 的受管子实例独占通道(见 weixinDedicatedInstance.ts)。
 *     其余进程(主实例 / task-factory 实例 / 任何无 profile 实例)一律
 *     `dedicated_instance_required`,不 poll、不出站、不处理入站。
 *
 * 本模块刻意零依赖 —— 既被 `weixinRuntimeBoot` 静态引用(必须在 import
 * manager 之前就能判定),也被 `WeixinBotManager` 引用(防御路由层直调
 * `manager.start()`),不能反过来依赖它们以避免循环依赖。
 */

/** 微信通道宿主实例的 profile 值(`zai start --app weixin` → `ZAI_APP`)。 */
export const WEIXIN_CHANNEL_PROFILE = 'weixin'

/**
 * 专用实例默认端口从零依赖的 shared 文件透出(前端面板表单初值也用同一常量)。
 * 见 shared/weixinInstance.ts —— 显式 pin、不静默换端口。
 */
export { DEFAULT_WEIXIN_INSTANCE_PORT } from '../../../shared/weixinInstance.js'

/**
 * 本进程是否是微信通道宿主。
 *
 * 判据只有 `process.env.ZAI_APP === 'weixin'` —— 该 env 由 `cli/index.ts`
 * 从 `--app` 落到进程上,而 `--app` 由 supervisor spawn 时按实例定义透传
 * (见 instanceSupervisor.doStart)。
 */
export function isWeixinChannelHost(): boolean {
  return process.env.ZAI_APP === WEIXIN_CHANNEL_PROFILE
}

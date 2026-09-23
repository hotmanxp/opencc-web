/**
 * weixinCommands — 微信入站指令解析(可扩展注册表)。
 *
 * 设计:
 *   - 入站文本以 `/` 开头 → parseWeixinCommand 提取 `name args`;
 *     命中注册表 → handler 全权处理(自行发回执),bridge 终止注入;
 *     未命中 → **原样穿透**给 agent(避免把用户正文的 "/etc/hosts"
 *     这类内容误吞)。
 *   - 新增指令 = registerWeixinCommand({name, description, handle}),
 *     无需改 bridge 代码。
 *   - handler 拿到的 ctx 已完成准入(gate),且带当前绑定。
 *
 * 现有指令:
 *   /new      立即轮转该对话到新 sess-uuid(上下文清零,旧会话归档并
 *             触发记忆沉淀;摘要将在新会话首条消息注入)。
 *   /restart  重启当前 `app=weixin` 专用实例(channel 重连后继续可用)。
 */
import type { WeixinSessionBinding } from '../../../shared/weixin.js'
import type { WeixinSessionMap } from './WeixinSessionMap.js'

export interface WeixinCommandContext {
  /** 原始入站消息(已过准入闸门)。 */
  msg: { chatId: string; chatType: 'dm' | 'group'; senderId: string; text: string }
  /** 当前绑定(resolveOrCreate 结果)。 */
  binding: WeixinSessionBinding
  /** 发回执给该 chat。 */
  reply: (text: string) => Promise<unknown> | void
  /** 会话映射表(轮转用)。 */
  sessionMap: WeixinSessionMap
  /** 指令名后的参数串(已 trim,可空)。 */
  args: string
}

export interface WeixinCommand {
  name: string
  description: string
  handle: (ctx: WeixinCommandContext) => Promise<void>
}

const registry = new Map<string, WeixinCommand>()

/** 注册指令(重名覆盖 —— 测试友好;生产不要重名)。 */
export function registerWeixinCommand(cmd: WeixinCommand): void {
  registry.set(cmd.name.toLowerCase(), cmd)
}

export function listWeixinCommands(): WeixinCommand[] {
  return [...registry.values()]
}

export interface ParsedWeixinCommand {
  name: string
  args: string
}

/**
 * 解析 `/name args` 形态。仅接受 `/` 紧跟 [A-Za-z0-9_-] —— `/etc/hosts`
 * 这类路径(斜杠后是非命令字符集开头之外的多段路径)不会被误判:
 * 第一段 `/etc` 会被解析成 name=etc,若未注册则穿透,安全。
 */
export function parseWeixinCommand(text: string): ParsedWeixinCommand | null {
  const m = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
}

/** 查注册表;未注册返回 null(调用方应穿透为普通消息)。 */
export function findWeixinCommand(name: string): WeixinCommand | null {
  return registry.get(name.toLowerCase()) ?? null
}

/** 测试:清空注册表。 */
export function resetWeixinCommandsForTests(): void {
  registry.clear()
}

// ─── 内置指令 ────────────────────────────────────────────────────────

export interface WeixinCommandDeps {
  /** 预留:后续指令可能需要的注入点。记忆沉淀统一由 bridge 在
   * takeRotation 流程处理,/new 不自带钩子以免双触发。 */
  onRotated?: (args: { conversationKey: string; oldSessionId: string; cwd: string }) => void
  /**
   * `/restart` 触发的进程级重启 hook。生产由 `WeixinBotManager` 注入
   * `runtimeLifecycle.sendRestart('user_action')` —— 该函数向 supervisor
   * 发 IPC,supervisor 沿用当前 instance 定义(cwd / 端口已持久化)respawn
   * 本进程,新进程 `weixinRuntimeBoot` 自动重连通道,无需重建实例定义。
   * 测试注入 `vi.fn()` 即可断言调用,无需真实 supervisor IPC。
   */
  onRestart?: (reason: 'user_action') => boolean
}

/**
 * 注册内置指令。bridge configure/start 时调用一次(deps 注入记忆钩子)。
 */
export function registerBuiltinWeixinCommands(deps: WeixinCommandDeps = {}): void {
  registerWeixinCommand({
    name: 'new',
    description: '开启新会话:上下文清零,旧会话归档并沉淀记忆',
    handle: async (ctx) => {
      const rotated = await ctx.sessionMap.rotate(ctx.binding.conversationKey, 'command:/new')
      if (!rotated) {
        await ctx.reply('当前还没有可重开的会话,直接发消息即可。')
        return
      }
      // 记忆沉淀不在过里做 —— bridge 在 takeRotation 流程统一处理
      // (TTL 轮转和 /new 轮转同一条路径,避免双触发)。
      void deps
      await ctx.reply(
        `已开启新会话。\n旧会话(${rotated.old.sessionId.slice(0, 12)}…)已归档,` +
          `上下文摘要将随后自动沉淀。\n长期记忆不受影响。`,
      )
    },
  })

  registerWeixinCommand({
    name: 'restart',
    description: '重启微信专用实例:通道断开重连,几秒后恢复',
    handle: async (ctx) => {
      // 先回 ack —— 通道马上就要断,这是用户最后一次看到 bot 响应的机会。
      await ctx.reply('正在重启微信通道...')
      const restart = deps.onRestart
      if (!restart) {
        console.warn('[weixin.commands] /restart: no restart hook wired; ignoring')
        return
      }
      try {
        const ok = restart('user_action')
        if (ok) {
          console.warn('[weixin.commands] /restart: supervisor restart requested by user')
        } else {
          // sendRestart() 返回 false = 当前进程不是 supervisor 拉起的 child,
          // IPC 通道不可用。这是预期(裸 dev / 直连),但 /restart 是 weixin-only
          // 路径,跑到这里说明生产路径异常,留给面板 / 日志排查。
          console.warn('[weixin.commands] /restart: supervisor IPC unavailable (not a managed child?)')
        }
      } catch (err) {
        console.warn('[weixin.commands] /restart: restart hook threw:', err)
      }
    },
  })
}

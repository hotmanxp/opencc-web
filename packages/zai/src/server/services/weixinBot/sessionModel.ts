/**
 * sessionModel — 把微信渠道配置的模型打进会话的 `transcript.meta`。
 *
 * 为什么走「打会话标记」而不是「注入进程 env」:
 *   `resolveModel` 的层级是 sessionModel > env > settings.model > 内置兜底
 *   (lib/resolveModel.ts:151)。sessionModel 是**唯一带 providerId 的一层**
 *   —— env 只能塞一个模型名,同一个模型名挂在多条 provider 线路上时
 *   matcher 只能按名字 first-match 猜。走 transcript.meta 则 model /
 *   providerId / effort 三者一起锁死,与用户在 Web 端用模型按钮选的效果
 *   完全一致。
 *
 * 为什么不直接 import agentRuntime:
 *   `agentRuntime → weixin boot → bridge` 已经成环(见 weixinInboundBridge
 *   里 serverCwd provider 的注释)。bridge 取 transcript store 走同样的
 *   注册点模式,见 `setWeixinTranscriptStoreProvider`。
 *
 * 覆盖时机:每条入站消息在 `resolveOrCreate` 之后调用。这一处就够 ——
 * 普通入站、TTL 轮转(resolveOrCreate 内部 rotate)、`/new` 轮转后的
 * 首条消息,三条路径都会经过,不需要在指令里另开钩子。
 */
import { readFileSync } from 'node:fs'
import { WeixinBotSettingsSchema } from '../../../shared/weixin.js'
import { zaiSettingsPath } from '../zaiSettingsStore.js'

/**
 * 读磁盘上的 settings —— **不用 `getCachedZaiSettingsSync`**。
 *
 * 踩过的坑:settings 写入走 tmp+rename,而 `zaiSettingsCache` 的
 * `fs.watch` 监听的是**文件 inode**,rename 替换 inode 后监听失联
 * (zaiSettingsCache.ts:88)。微信专用实例(9199)启动时磁盘上还没有
 * `weixinBot.model`,之后主实例(9201)在面板存了模型 —— 磁盘上有值了,
 * 但 9199 的缓存永远停在启动时的空值,于是这里一直拿到 `model: ''`,
 * seeding 静默早退,bot 回落到全局 BUILTIN_FALLBACK_MODEL。
 *
 * 专用实例是唯一"别人改配置、我要立刻看到"的进程,每条入站消息多读一次
 * 几 KB 的文件完全可接受 —— 换来的是"面板保存 → 下一条微信消息生效"
 * 这条用户路径真的通。
 */
function readWeixinBotSettingsFromDisk(): Record<string, unknown> {
  try {
    const raw = readFileSync(zaiSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as { weixinBot?: Record<string, unknown> }
    return parsed.weixinBot ?? {}
  } catch {
    return {}
  }
}

/**
 * bridge 实际用到的 transcript store 形状(只声明用到的方法)。
 * 与 `agentRuntime.getTranscriptStore()` 的返回类型兼容 —— 注册点那侧
 * 传真实实例,测试那侧传 vi.fn() 桩。
 */
export interface WeixinTranscriptStoreLike {
  read(sessionId: string, opts: { cwd: string }): Promise<{ meta?: unknown } | null | undefined>
  patch(sessionId: string, patch: Record<string, unknown>, opts: { cwd: string }): Promise<unknown>
}

let transcriptStoreProvider: (() => WeixinTranscriptStoreLike) | null = null

/**
 * transcript store 注册点。`agentRuntime` 初始化时注册(紧挨现有的
 * `setWeixinServerCwdProvider`),避免 bridge 静态 import agentRuntime
 * 造成循环依赖。
 */
export function setWeixinTranscriptStoreProvider(
  fn: (() => WeixinTranscriptStoreLike) | null,
): void {
  transcriptStoreProvider = fn
}

/** 测试:清空注册点。 */
export function __resetWeixinTranscriptStoreProviderForTests(): void {
  transcriptStoreProvider = null
}

/** 解析要写入的模型三元组;未配置 model 时返回 null(= 跟随全局默认)。 */
function resolveDesiredModel(): { model: string; providerId?: string; effort?: string } | null {
  const parsed = WeixinBotSettingsSchema.safeParse(readWeixinBotSettingsFromDisk())
  if (!parsed.success) return null
  const model = (parsed.data.model ?? '').trim()
  if (!model) return null
  const providerId = (parsed.data.providerId ?? '').trim()
  const effort = (parsed.data.effort ?? '').trim()
  return {
    model,
    ...(providerId ? { providerId } : {}),
    ...(effort ? { effort } : {}),
  }
}

/**
 * 把渠道配置的模型种子化进会话 —— **仅在该会话尚无明确模型时**。
 *
 * 语义对齐同层的 `seedSessionCwd`(weixinInboundBridge.ts):只在"还没选过"
 * 时补默认值,绝不覆盖已有选择。已有 model 的会话有两种来源 ——
 * 面板配了模型后这个会话已经种过一次,或用户在 9199 专用实例的 Web UI
 * 上用模型按钮手动选过;后者必须赢,否则面板配置会把他手选的模型冲掉。
 *
 * 全程吞异常:模型打不上不该让用户的消息投递失败(那比"用错模型"严重
 * 得多),退化成全局默认即可。
 */
export async function seedSessionModel(sessionId: string, cwd: string): Promise<void> {
  try {
    const desired = resolveDesiredModel()
    if (!desired) return
    if (!transcriptStoreProvider) return
    const store = transcriptStoreProvider()

    const existing = await store.read(sessionId, { cwd })
    const current = (existing?.meta as { model?: string } | undefined)?.model
    if (current && current !== 'unknown') return

    // patch 对尚无 transcript 文件的 sessionId 不会 404:store 会重建
    // REGISTRY 条目并写出 JSONL session-meta 行(legacyTranscriptStore)。
    await store.patch(sessionId, desired, { cwd })
  } catch (err) {
    console.warn('[weixin.sessionModel] seed failed (falling back to global model):', err)
  }
}

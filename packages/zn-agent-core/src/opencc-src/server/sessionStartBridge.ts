/**
 * zai patch (2026-10-11, SessionStart 接线)—— SessionStart hook 产出的上下文存储。
 *
 * ## 为什么需要这个模块
 *
 * `processSessionStartHooks` 的唯一调用方是 `main.tsx`(交互式 REPL 的入口),
 * headless 路径(zai 走的 `createOpenccRuntime` → `createHeadlessContextImpl`)
 * **从不经过**它 —— 这和当初 `loadMods` 的缺口是同一形状:vendor 把某条链挂在
 * REPL 上,headless 侧没人调。结果是 mod 注册了 SessionStart handler,却一次都
 * 收不到事件。
 *
 * ## 为什么不直接调 processSessionStartHooks 就完事
 *
 * 因为它返回的 `HookResultMessage[]` 需要有人接收 —— REPL 是把它塞进本会话的
 * 消息流,而 headless 侧没有这个位置。产出的东西丢弃等于白跑。
 *
 * 所以走 vendor 已有的注入通道:`registerExtraReminderProvider`
 * (`utils/daemon/preApiCallReminders.ts`)。query loop 在**每次 LLM API call
 * 前**调用这些 provider,把返回值作为 `<system-reminder>` prepend 到 prompt。
 * zai 的 inbox reminder 已经这么用了(`agentRuntime.ts` 的
 * `registerExtraReminderProvider((sid) => drainInboxReminder(sid))`),不是新机制,
 * 是复用。
 *
 * 语义对得上:SessionStart hook 的产出按定义就是「会话启动时给模型看的上下文」,
 * 每次 API call 前注入正是它该去的地方。
 */

/** 本进程最后一次 SessionStart hook 产出的附加上下文(去重后的快照)。 */
let sessionStartContexts: string[] = []

/**
 * 记下 SessionStart hook 的产出,供 pre-API-call reminder provider 注入。
 *
 * 用「替换」而非「累加」:这是最后一次派发的结果,重复调用应覆盖,否则每次
 * reload 都会往里堆一份同样的内容。
 */
export function setSessionStartContexts(contexts: string[]): void {
  sessionStartContexts = [...new Set(contexts.filter(c => typeof c === 'string' && c.trim() !== ''))]
}

/** 读回当前上下文。返回副本,外部改动不污染模块级状态。 */
export function getSessionStartContexts(): readonly string[] {
  // 必须拷贝:`sessionStartContexts` 是进程级单例,provider 每次 API call 前
  // 都会读它,若把内部数组直接交出去,任何调用方的 push/splice 都会永久改掉
  // 后续所有会话注入的内容。
  return [...sessionStartContexts]
}

/**
 * 从 `processSessionStartHooks` 的返回值里抽出附加上下文。
 *
 * 它可能返回两类东西:hook 自己产出的 message,以及统一包成
 * `hook_additional_context` 附件的 context 列表。这里只取后者 —— 前者是给
 * REPL 的消息流用的,headless 侧没有对应位置。
 */
export function extractAdditionalContexts(
  messages: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const out: string[] = []
  for (const m of messages) {
    const attachment = m.attachment as
      | { type?: string; content?: unknown }
      | undefined
    if (attachment?.type !== 'hook_additional_context') continue
    const content = attachment.content
    if (Array.isArray(content)) {
      for (const c of content) if (typeof c === 'string') out.push(c)
    } else if (typeof content === 'string') {
      out.push(content)
    }
  }
  return out
}

/** 清空存储。For tests only. */
export function __resetSessionStartContextsForTesting(): void {
  sessionStartContexts = []
}
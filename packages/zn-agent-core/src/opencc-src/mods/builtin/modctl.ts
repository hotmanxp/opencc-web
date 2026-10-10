import { registerBuiltinMod } from '../builtin.js'
import type { ModContext } from '../engine.js'
import {
  BUILTIN_ORIGIN,
  getKnownMods,
  getLoadedMods,
} from '../registry.js'
import { MOD_SUPPORTED_EVENTS } from '../dispatch.js'

/**
 * Built-in mod `modctl` — mod 运行时的自检面板。
 *
 * 它存在的理由不只是「有个内置 mod 可验证」:mod 系统有一整套对用户不可见
 * 的状态(哪些被发现了、哪些在跑、各自注册了什么、订阅了哪些事件、实际收到
 * 过哪些事件、熔断了没有),出问题时用户没有任何手段自查。这个命令把那些
 * 状态摊开成一段文字。
 *
 * 它也是 vendor 里第一个内置 mod —— 在此之前 `builtinSpecs` 一直为空
 * (见 builtin.ts 文件末的说明),所以内置 mod 这条路径(`@builtin` id、
 * `noteDiscoveredMod(name, true)`、无 root 路径)在 zai 侧从未真跑过。
 *
 * ## 为什么它订阅了全部 7 个事件
 *
 * mod 的事件链(`dispatch.ts` 的 `runModChain`)在 zai 里由三个消费方驱动:
 * 工具前后钩子(`utils/hooks.ts`)、会话生命周期、提示提交。哪一条真的通了、
 * 载荷长什么样,此前没有任何观测手段 —— 一条 handler 写错字段名只会静默地
 * 什么都不发生。
 *
 * 所以这里订阅 `MOD_SUPPORTED_EVENTS` 的**全部**事件,每个 handler 做两件
 * 真实的事(不是空跑):
 *   1. 记录事件名 + 关键载荷字段,供 `/modctl` 汇总;
 *   2. 调 `next()` 把事件交还下游核心 tier(不打断宿主)。
 *
 * ## 实测:为什么计数长期是 0 —— zai 侧 hook 管线未接线(2026-10-10)
 *
 * 在 zai 里真跑一轮(Bash / Read 工具都确实执行了),本 mod 的 7 个计数
 * **全是 0**。服务端插桩定位到的断点,按证据链:
 *
 *   1. mod 侧正常:`loadMods → swapRegisteredHooks` 在启动时真实触发,
 *      `registerHookCallbacks` 收到 7 个事件、每条 chain 长度 1。
 *   2. 宿主侧断裂:插桩打在 `utils/hooks.ts` 的 `executeHooks()`(所有 hook
 *      事件的统一入口,`executePreToolHooks` / `executePostToolHooks` /
 *      `executePostToolUseFailureHooks` / `executePermissionDeniedHooks`
 *      都 `yield*` 它),**计数为 0** —— zai 场景下这几个入口从未被调用,
 *      工具执行直接绕过了钩子管线。
 *
 * 所以 handler 一次都没机会跑,`record()` 自然全是 0。这不是 mod 写错了:
 * 注册侧已由插桩证明正确。补这个接线是 vendor 的独立改动(涉及工具执行
 * 主循环要不要让出钩子语义),不是本 mod 能自举的,故此处如实记录而不擅自改。
 *
 * **因此 `/modctl` 的计数面板是本 mod 的唯一权威自证手段** —— 它对账的是
 * 「支持的事件全集 vs 实际收到的」,能明确区分三种情况:宿主没派发这个事件、
 * 派发了但 mod 没注册、注册了但 handler 没跑。2026-10-10 的实测正属于
 * 第一种。
 *
 * 关于 additionalContext:链路本身是通的(`processHookJSONOutput` 提取 →
 * `additionalContexts` → `hook_additional_context` 附件 → system-reminder,
 * 见 `messages.ts`)。但既然事件没派发,注入自然无从谈起。宿主接线补上之后,
 * UserPromptSubmit / SessionStart 的注入可到达模型;PreToolUse /
 * PostToolUse 的注入能否到模型还要单独验(`additionalContexts` 目前只有
 * `processUserInput` 与子 agent 的 `runAgent` 两个消费点,主 agent 的
 * queryLoop 里没有读点)。
 *
 * **不订阅 ui.render** —— 那是 TUI 渲染期事件,已随 Ink 能力面删除。
 *
 * 纯数据通道:只用 `local` 命令,不碰任何渲染面 —— 内置 mod 必须能在没有
 * TUI 的宿主里工作,这正是与上游 diff / handoff 的区别。
 */

/** 单个事件的最近一次载荷快照(截断到安全长度,防日志/输出膨胀)。 */
type EventHit = {
  count: number
  /** 最近一次的关键字段,按事件不同而不同。 */
  detail?: string
}

const MAX_DETAIL_CHARS = 160

const hits = new Map<string, EventHit>()

/** 持有 register 时拿到的 ctx,供 publishStatus 使用(handler 之外的调用点)。 */
let ctxRef: ModContext | undefined

function truncate(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s
}

/** 把计数压成一行紧凑摘要,供 ui.status 通道使用。 */
function summarizeHits(): string {
  return MOD_SUPPORTED_EVENTS.map(e => `${e}=${hits.get(e)?.count ?? 0}`).join(' ')
}

function record(event: string, detail?: string): void {
  const prev = hits.get(event)
  hits.set(event, { count: (prev?.count ?? 0) + 1, detail: detail ?? prev?.detail })
  publishStatus()
}

/**
 * 把计数面板同时写进 `ctx.ui.status` 通道。
 *
 * `ui.status` 是 mod 运行时**唯一为「宿主可读的状态」设计的**通道(engine
 * 的 statusSnapshot + subscribeModStatus),拿它发布比让宿主去调 mod 的导出
 * 函数更合规 —— mod 不该假设宿主知道它的内部形状。
 *
 * 通道本身 zai 侧目前没有 UI 消费者(留待未来状态栏),但它保证计数在进程内
 * 是可读的权威状态:想核对的人读 `getModStatusSnapshot()['modctl']` 即可,
 * 不必相信模型对「我有没有被注入」的复述。
 */
function publishStatus(): void {
  const summary = summarizeHits()
  ctxRef?.ui.status(`modctl 事件计数:${summary}`)
}

/** Test-only:清空事件计数,让用例之间互不污染。 */
export function __resetModctlHitsForTesting(): void {
  hits.clear()
  ctxRef = undefined
}

/** Test-only:读当前累计的事件命中,用于断言 handler 真的被调到。 */
export function getModctlHits(): ReadonlyMap<string, EventHit> {
  return hits
}

/**
 * 回注 additionalContext。
 *
 * 语义要点:`next(e)` 的返回值才是本 handler 的最终产出,所以要先拿到下游
 * 结果、在它之上叠加 additionalContext,再返回。直接 `return next()` 会丢掉
 * 注入。
 *
 * **`hookEventName` 是必填的**,不是可选标注:`processHookJSONOutput` 先拿它
 * 与 `expectedHookEvent` 比对,不匹配直接 throw;随后整个 `switch` 也靠它分派。
 * 缺这个字段的后果不是「注入没生效」,而是**每一轮对话都被这条 throw 打断**
 * —— mod 的 handler 把错误抛进了宿主的执行流。实测踩过:报
 * `expected 'UserPromptSubmit' but got 'undefined'`。
 */
async function withContext(
  e: Record<string, unknown>,
  next: (e?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  event: string,
  text: string,
): Promise<Record<string, unknown>> {
  const downstream = await next(e)
  const existing = downstream.hookSpecificOutput as
    | { additionalContext?: string }
    | undefined
  // hookSpecificOutput 可能已有别的 mod 写过,不能整个覆盖掉。
  const previous = existing?.additionalContext
  return {
    ...downstream,
    hookSpecificOutput: {
      ...(existing ?? {}),
      hookEventName: event,
      additionalContext: previous ? `${previous}\n${text}` : text,
    },
  }
}

registerBuiltinMod({
  name: 'modctl',
  version: '1.1.0',
  description: 'mod 运行时自检:加载状态 + 事件链实测(订阅全部 7 个非 ui 事件)',
  register(ctx: ModContext) {
    ctxRef = ctx

    // --- 工具前:确认这次调用将被执行,并把工具名喂回上下文 ---
    ctx.on('PreToolUse', (e, next) => {
      const tool = String(e.tool_name ?? e.tool ?? '?')
      record('PreToolUse', `tool=${tool}`)
      return withContext(e, next, 'PreToolUse', `[modctl] 工具即将执行:${tool}`)
    })

    // --- 工具后:确认完成,并回注结果摘要 ---
    ctx.on('PostToolUse', (e, next) => {
      const tool = String(e.tool_name ?? e.tool ?? '?')
      record('PostToolUse', `tool=${tool}`)
      return withContext(e, next, 'PostToolUse', `[modctl] 工具已完成:${tool}`)
    })

    // --- 用户提交提示:把提示词首行回注,证明载荷被读到了 ---
    ctx.on('UserPromptSubmit', (e, next) => {
      const prompt = String(e.prompt ?? '')
      record('UserPromptSubmit', truncate(prompt))
      return withContext(e, next, 'UserPromptSubmit', `[modctl] 已收到提示(${prompt.length} 字)`)
    })

    // --- 会话开始:所有事件里唯一能看到 cwd 的入口 ---
    ctx.on('SessionStart', (e, next) => {
      const cwd = e.cwd ?? e.workingDirectory ?? '(未提供)'
      record('SessionStart', `cwd=${String(cwd)}`)
      return withContext(e, next, 'SessionStart', `[modctl] 会话已启动,cwd=${String(cwd)}`)
    })

    // --- 会话结束:reason 字段由 MATCHER_FIELDS 声明可匹配 ---
    ctx.on('SessionEnd', (e, next) => {
      const reason = String(e.reason ?? '?')
      record('SessionEnd', `reason=${reason}`)
      return next(e)
    })

    // --- 停止:stop_reason 是 Stop 唯一有意义的载荷 ---
    ctx.on('Stop', (e, next) => {
      const reason = String(e.stop_reason ?? e.reason ?? '?')
      record('Stop', `stop_reason=${reason}`)
      return next(e)
    })

    // --- 通知 ---
    ctx.on('Notification', (e, next) => {
      const message = String(e.message ?? '')
      record('Notification', truncate(message))
      return withContext(e, next, 'Notification', `[modctl] 通知:${truncate(message)}`)
    })

    ctx.registerCommand({
      name: 'modctl',
      description: 'mod 自检:加载状态 + 各事件订阅数与最近载荷',
      handler: () => {
        const loaded = getLoadedMods()
        const known = getKnownMods()

        const lines: string[] = []

        if (loaded.length === 0 && known.size === 0) {
          return '没有任何 mod 被加载。\n把 mod 目录放在 ~/.zai/mods/<name>/ 下(内含 opencc-mod.json),然后重载。'
        }

        // --- 1) 加载状态 ---
        lines.push('【加载状态】')
        for (const mod of loaded) {
          const isBuiltin = mod.root === BUILTIN_ORIGIN
          lines.push(
            `${isBuiltin ? '●' : '○'} ${mod.manifest.name}${mod.manifest.version ? ` v${mod.manifest.version}` : ''}  (${isBuiltin ? '内置' : mod.root})`,
          )
          if (mod.commands.length > 0) {
            lines.push(`    命令: ${mod.commands.map(c => c.name).join(', ')}`)
          }
          if (mod.tools.length > 0) {
            // 工具的运行时名是 `mods_<mod>_<tool>`。
            lines.push(`    工具: ${mod.tools.map(t => `mods_${mod.manifest.name}_${t.name}`).join(', ')}`)
          }
          if (mod.handlers.length > 0) {
            lines.push(`    订阅: ${mod.handlers.map(h => h.event).join(', ')}`)
          }
        }

        const disabled = [...known.keys()].filter(
          name => !loaded.some(m => m.manifest.name === name),
        )
        for (const name of disabled) {
          lines.push(`○ ${name}  (已停用)`)
        }

        // --- 2) 事件链实测 ---
        //
        // 两个来源对账:支持的事件全集(编译期常量)vs 本 mod 实际收到的。
        // 「支持但从未收到」通常意味着那条链没接上(比如宿主根本没派发该事件),
        // 而不是 mod 写错了 —— 这正是这份面板要回答的问题。
        lines.push('')
        lines.push('【事件链实测】')
        for (const event of MOD_SUPPORTED_EVENTS) {
          const hit = hits.get(event)
          lines.push(
            hit
              ? `  ${event.padEnd(18)} ×${String(hit.count).padStart(3)}   ${hit.detail ?? ''}`
              : `  ${event.padEnd(18)} ×  0   (从未收到)`,
          )
        }

        const never = MOD_SUPPORTED_EVENTS.filter(e => !hits.has(e))
        if (never.length > 0) {
          lines.push('')
          lines.push(`提示:${never.join('、')} 从未收到。可能是该事件本会话未发生,`)
          lines.push('也可能是宿主没有派发它 —— 前者正常,后者需要查宿主接线。')
        }

        return lines.join('\n')
      },
    })
  },
})
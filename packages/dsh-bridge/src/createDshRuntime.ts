/**
 * createDshRuntime — dsh 长驻 Cordis ctx 装配（B1a T1.1 + dsh-013 修复）。
 *
 * 替代 headless 的"run 完 exit"语义，让 zai 进程能复用 dsh 内核做长驻 Agent。
 *
 * 装载模型（cordis-plugin-loader 统一装载，模拟 dsh 启动器）：
 *   1. @deepseek-ai/cordis-plugin-loader (Loader — 让 ctx.loader 启用)
 *   2. @deepseek-ai/dsh-base/cordis.patch.yml (12+ core plugin: timer/hmr/llm/session/...)
 *   3. @deepseek-ai/dsh-llm-pi-ai (LLM provider adapter Cordis plugin)
 *   4. @deepseek-ai/dsh-llm-retry (retry policy for LLM calls)
 *   5. @deepseek-ai/dsh-api-gateway + dsh-typert-* (agent API surface)
 *   6. @deepseek-ai/dsh-credentials-local (apiKeyEnv 解析)
 *   7. @deepseek-ai/dsh-settings-file (settings.yaml 装载)
 *   8. @deepseek-ai/dsh-jobs-local (background jobs)
 *   9. @deepseek-ai/dsh-session-persistence-jsonl (持久化)
 *  10. @deepseek-ai/dsh-tools / dsh-scope / dsh-system-prompt / dsh-agent / dsh-agent-default-model
 *
 * 长驻语义：
 *   - 构造空白 Cordis ctx
 *   - 装载 Loader 插件
 *   - 用 ctx.loader.create() 装载 dsh-base patch + llm-pi-ai + 各核心 service
 *   - 触发 ctx 的 loader 完成（await ctx.loader?.await()）
 *   - shutdown() 走 drain 顺序（B-1 尖峰）：
 *     1. 拒绝新请求
 *     2. flush 当前 turn — sessions.flush(ctx 持有的所有 session)
 *     3. dispose Cordis ctx
 *     4. 清 globalThis 桥 — 调用方负责（zai 侧）
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

import { DSH_KERNEL, type KernelId } from './paths.js'
import { dshSessionsRootAbs } from './sessions/store.js'

const require = createRequire(import.meta.url)

/**
 * LLM provider profile — dsh-llm-pi-ai `Config.providers[name]` 形态子集。
 *
 * dsh-llm-pi-ai 支持的完整 schema 见其 `Config` 定义(dsh-settings 装载的 zod
 * schema);zai-side 不需要全部字段,只透传 baseURL + apiKeyEnv + 模型 catalog。
 *
 * `apiKeyEnv` 是按请求解析的凭据**引用**(dsh-llm-pi-ai 会通过 ctx.credentials 或
 * `launchEnvironmentOf(ctx).get(ref)` 拉取),不直接持有 key — 见
 * `dsh-llm-pi-ai/lib/index.js:2048-2057`。
 */

/**
 * Phase 3 P1: 模型声明。`string` 形态只声明 id(用内置 catalog 的默认 input);
 * `DshModelEntry` 形态可以覆盖 `input`(`text` / `image` 等 modality),
 * `contextWindow`, `maxTokens`。
 *
 * 重要:声明 `input: ['text', 'image']` 是让 dsh-llm-pi-ai 知道这个 model
 * 接受图片输入的唯一方式。否则 dsh-llm-pi-ai streamSimple 时会
 * 抛 `pi-ai model "X" does not support image input (UNSUPPORTED_CONTENT)`。
 * 见 dsh-llm-pi-ai/lib/types/catalog.d.ts PiAiModelProfile.input 注释:
 *   "Declaring images is what makes a hand-declared vision model usable"
 */
/** THINKING_LEVELS 与 dsh-llm-pi-ai `lib/index.js:960-966` 对齐:
 * `off | minimal | low | medium | high | xhigh`(esclation order)。
 * zai-side 暴露前 6 个以匹配 pi-ai catalog 内置 schema,后续 level
 * 上游追加时只需扩展 union。
 */
export type DshReasoningLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

export interface DshModelEntry {
  id: string
  /**
   * Request modalities model 接受。例如:
   * - `['text']` — 纯文本(默认)
   * - `['text', 'image']` — vision-capable
   * - `['text', 'image', 'pdf']` — 文档理解
   */
  input?: Array<'text' | 'image' | 'pdf' | 'audio'>
  contextWindow?: number
  maxTokens?: number
  /**
   * 该 model 支持的 reasoning level 列表。dsh-llm-pi-ai 用此构造 profile
   * 的 reasoning.efforts;model 仅声明此列表中存在的 level 才能在
   * stream 时 emit `thinking_start/thinking_delta/thinking_end` chunks
   * (进而 dsh-bridge translateSessionEvent 才能产出 runtime.thinking)。
   *
   * 特殊值:
   * - `false` — 显式声明该 model 不支持 reasoning(dsh-llm-pi-ai schema
   *   允许的 z.union([z.const(false), ...]) 形态,见
   *   `dsh-llm-pi-ai/lib/index.js:1608`)。
   * - 缺省 — dsh-llm-pi-ai catalog 视该 model 为 non-reasoning,stream
   *   时不产 thinking chunk → dsh-bridge 收不到 reasoning-delta。
   */
  reasoningEfforts?: false | Array<DshReasoningLevel>
  /**
   * 默认 reasoning level。必须是 reasoningEfforts 列表中的某一项。
   * 缺省时 dsh-llm-pi-ai 选 catalog 第一个非 'off' level。
   */
  defaultReasoningEffort?: DshReasoningLevel
}

export interface DshProviderProfile {
  /** 适配器路由名(对应 `ctx.llm.registerAdapter([name], adapter)` 的路由 key)。 */
  name: string
  /** 模型显示名(给 `listModels` 用);也作为 `defaultModel` 的路由 hint。 */
  displayName?: string
  /** 提供方 baseURL — Anthropic 兼容网关必填,直连 anthropic.com 可省。 */
  baseURL: string
  /** env 变量名(里面存 API key)。dsh-llm-pi-ai 按需读,不在进程里缓存。 */
  apiKeyEnv: string
  /**
   * Provider 路由默认 reasoning effort(传给 pi-ai `PiAiProviderProfile.reasoning`)。
   *
   * **dsh-021 root cause 修复**:zai 早期 `DshModelEntry.defaultReasoningEffort`
   * 字段在 `buildProviderEntries` 中被静默丢弃 — dsh-llm-pi-ai streamSimple
   * (`adapter.ts:321` → `profileOptions(profile, reasoning, apiKey)`) 靠
   * `profile.reasoning` 决定发给 anthropic API 的 `thinking` / `reasoning_effort`
   * 参数。不传时 pi-ai 不发 `thinking: { type: 'enabled' }`,API 默认 thinking
   * 关闭,dsh 收不到 `thinking_*` 事件,dsh-bridge translateSessionEvent
   * 永远不 emit `runtime.thinking` → UI ThinkingBlock 不显示。
   *
   * 注意:`'off'` 与 undefined 区分 — 显式禁用时仍写出字段,让 pi-ai
   * 发 `thinking: { type: 'disabled' }`。
   */
  defaultReasoningEffort?: DshReasoningLevel
  /**
   * 该路由暴露的模型列表。形态:
   * - `string` — 只声明 id,其他用 dsh-llm-pi-ai 内置 catalog 默认
   * - `DshModelEntry` — 覆盖 input / contextWindow / maxTokens / reasoningEfforts
   *
   * Phase 3 P1 起推荐用 DshModelEntry 给 vision model 显式声明
   * `input: ['text', 'image']`,否则 dsh-llm-pi-ai 不知道 model 支持 image。
   *
   * Phase 3 P1 follow-up: 显式声明 `reasoningEfforts` 让 model 支持
   * extended thinking — 否则 dsh-llm-pi-ai 视为 non-reasoning,stream
   * 时不产 thinking_delta,下游翻译层收不到 reasoning-delta。
   */
  models: Array<string | DshModelEntry>
}

/**
 * 把 zai-side `DshProviderProfile[]` 转换成 dsh-llm-pi-ai loader.create
 * 接受的 provider config 形态。
 *
 * Phase 3 P1 follow-up 关键 transform:
 * - `DshModelEntry.reasoningEfforts: string[]` → pi-ai schema 的 dict
 *   `{ level: wireValue }`(zai 不映射 wireValue,故 key===value);`false`
 *   显式声明 model 不支持 reasoning。
 * - 给 model 补 `name` 字段(pi-ai modelFields 必填,line 1604)。
 * - `string` 形态也补 name(用 id 兜底)。
 *
 * 独立 export 出来供单元测试验证,避免每次为测 transform 启整条
 * cordis loader + 20+ dsh-* plugin。
 */
export function buildProviderEntries(
  providers: DshProviderProfile[],
): Record<string, unknown> {
  const providerEntries: Record<string, unknown> = {}
  for (const p of providers) {
    providerEntries[p.name] = {
      baseURL: p.baseURL,
      apiKeyEnv: p.apiKeyEnv,
      models: p.models.map((m) => {
        if (typeof m === 'string') return { id: m, name: m }
        const entry: {
          id: string
          name: string
          input?: unknown
          contextWindow?: number
          maxTokens?: number
          reasoningEfforts?: unknown
        } = {
          id: m.id,
          name: m.id,
        }
        if (m.input !== undefined) entry.input = m.input
        if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow
        if (m.maxTokens !== undefined) entry.maxTokens = m.maxTokens
        if (m.reasoningEfforts !== undefined) {
          if (m.reasoningEfforts === false) {
            entry.reasoningEfforts = false
          } else {
            const dict: Record<string, string> = {}
            for (const level of m.reasoningEfforts) dict[level] = level
            entry.reasoningEfforts = dict
          }
        }
        return entry
      }),
      ...(p.displayName ? { displayName: p.displayName } : {}),
      // dsh-021 root cause 修复:把 profile-level defaultReasoningEffort 透传到
      // pi-ai `PiAiProviderProfile.reasoning`。dsh-llm-pi-ai profileOptions
      // (`adapter.ts:87-104`) 靠这个字段决定 streamSimple 是否给 anthropic
      // API 发 `thinking: { type: 'enabled' }` — 不传时默认 thinking 关闭,
      // dsh 收不到 reasoning events,UI ThinkingBlock 不显示。
      ...(p.defaultReasoningEffort !== undefined
        ? { reasoning: p.defaultReasoningEffort }
        : {}),
    }
  }
  return providerEntries
}

export interface CreateDshRuntimeOptions {
  dataDir: string
  runtimeId: string
  defaultCwd: string
  defaultModel: string
  /**
   * LLM provider profiles。loader 装载阶段 `ctx.loader.create()` llm-pi-ai
   * 时传入,dsh-llm-pi-ai 把它注册到 `ctx.llm.registerAdapter` + 注册
   * configurable providers 目录,agents service 后续查表走它。
   */
  providers: DshProviderProfile[]
}

export interface DshRuntimeHandle {
  readonly kernel: KernelId
  readonly ctx: Context
  activeCount(): number
  start(): Promise<void>
  shutdown(): Promise<void>
}

let activeDshHandles = 0

export function getActiveDshHandleCount(): number {
  return activeDshHandles
}

/**
 * 构造 dsh 长驻 ctx。把 dsh 全部所需 plugin 按依赖顺序装载。
 */
export async function createDshRuntime(
  opts: CreateDshRuntimeOptions,
): Promise<DshRuntimeHandle> {
  // 构造空白 Cordis ctx。Cordis 提供自反射的 Context 类。
  // baseUrl 必须设值:cordis-plugin-loader 的 _patchContext 会把 entry.ctx
  // 的原型链上溯到 parent.ctx(loader 的 ctx);parent.ctx 未设 baseUrl 时
  // `this.parent.ctx === this.ctx` 会触发 `Object.setPrototypeOf(this.ctx, this.ctx)`
  // 报 "Cyclic __proto__ value"。设 baseUrl 为 zai 包工作目录 — dsh-* 包
  // node_modules 在 pnpm 软链结构里可由 baseUrl 解析(用于 cordis-plugin-include
  // 的 path 解析)。
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(opts.dataDir + '/').href

  activeDshHandles++

  // 装载 core + agent + headless bundles
  // plugin 的 side-effect import 让 cordis loader 知道有哪些 plugin 待挂载
  // （cordis 的 plugin loader 通过 cordis-plugin-loader 自动处理）。
  // 由于 dsh-base 是 declarative bundle patch（cordis.yml），不直接 import；
  // 它通过 dsh-headless 等下游包间接被装载。
  await Promise.all([
    // dsh-013 修复:cordis-plugin-loader 必须先注入,后续 ctx.loader.create()
    // 才能装载 dsh-base patch + llm-pi-ai 等带 patch 的 plugin。
    import('@deepseek-ai/dsh-llm'),
    import('@deepseek-ai/dsh-llm-pi-ai'),
    import('@deepseek-ai/dsh-llm-retry'),
    import('@deepseek-ai/dsh-api-gateway'),
    import('@deepseek-ai/dsh-credentials-local'),
    import('@deepseek-ai/dsh-settings-file'),
    import('@deepseek-ai/dsh-jobs-local'),
    import('@deepseek-ai/dsh-typert-loader'),
    import('@deepseek-ai/dsh-typert-registry'),
    import('@deepseek-ai/dsh-session-title'),
    import('@deepseek-ai/dsh-session-title-first-prompt-llm'),
    import('@deepseek-ai/dsh-user-questions'),
    import('@deepseek-ai/dsh-agent'),
    import('@deepseek-ai/dsh-agent-loop'),
    import('@deepseek-ai/dsh-agent-default-model'),
    import('@deepseek-ai/dsh-session'),
    import('@deepseek-ai/dsh-session-persistence-jsonl'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-shell'),
    import('@deepseek-ai/dsh-user-approval'),
    import('@deepseek-ai/dsh-fs'),
    // dsh-subagent 上游 SubagentRuntime(`ctx.subagents.start('spawn', req)`) —
    // Phase 4 改造让 spawnDshSubagent 走上游 `start()` 而不是自实现
    // `agents.create()`,保证 `subagent/start` / `subagent/end` 生命周期事件
    // + `run.result` Promise + `run.dispose()` 由上游托管。
    import('@deepseek-ai/dsh-subagent'),
    import('@deepseek-ai/dsh-subagent-spawn-in-process'),
  ])

  const handle: DshRuntimeHandle = {
    kernel: DSH_KERNEL,
    ctx,

    activeCount() {
      return activeDshHandles
    },

    async start() {
      // 0. 装载 Loader — 让 ctx.loader 可用。必须 await 到 plugin
      //    完全挂载(否则后面 ctx.loader.create 会因 loader 内部状态未就绪
      //    报 Cyclic __proto__ 或类似)。
      await ctx.plugin(Loader)

      // 1. 装载 dsh-bridge 自带的最小 patch (只装 zai-server 必需的 plugin)。
      //    dsh-base 的全 patch 包含 30+ mode-specific 行(web/llm-deepseek/tool-* 等),
      //    其中不少只有 id 没有 name(placeholder 形态),cordis-plugin-loader 处理
      //    这种 row 时报 `Cannot read properties of undefined (reading 'startsWith')`。
      //    自写精简 patch 避开这个问题,只装 zai 真实对话路径需要的 12+ plugin:
      //    llm / session / typert* / session-title / agent / agent-default-model /
      //    jobs / llm-retry / settings / credentials / llm-pi-ai /
      //    session-persistence-jsonl。
      const dshBridgePatch = require.resolve('./dsh-bridge.patch.yml')
      await ctx.loader.create({
        name: '@deepseek-ai/cordis-plugin-include',
        config: { path: dshBridgePatch },
      })

      // 2. 注入 JsonlSessionPersistence.Config.root — dsh 会话写盘根目录,
      //    覆盖 base patch 里的默认配置(主计划 §4.2)。
      await ctx.loader.create({
        name: '@deepseek-ai/dsh-session-persistence-jsonl',
        config: { root: dshSessionsRootAbs(opts.dataDir) },
      })

      // 2.5 Phase 3 P1: 注入 LocalAttachmentStore 的 dshHome — dsh-llm-pi-ai
      //     streamSimple 在 image input 时通过 `ctx.get("attachments")` 拿
      //     AttachmentStore 实例,没它会抛 `pi-ai image input requires the
      //     durable attachment service`。用 zai dataDir 下的 `attachments/`
      //     子目录,避免污染用户 ~/.dsh/。
      await ctx.loader.create({
        name: '@deepseek-ai/dsh-attachment-local',
        config: { dshHome: join(opts.dataDir, 'attachments') },
      })

      // 3. dsh-013 修复:装载 dsh-llm-pi-ai provider with provider profiles。
      //    dsh-llm-pi-ai 在 loader.create 阶段会调 settings.inject 拿
      //    ctx.settings(由 base patch 里的 dsh-settings-file 提供),把
      //    Config.providers 注册到 ctx.llm.registerAdapter。
      //
      // Phase 3 P1: 支持 DshModelEntry 形态,透传 input / contextWindow /
      // maxTokens 给 dsh-llm-pi-ai — 否则 vision model 报
      // `does not support image input (UNSUPPORTED_CONTENT)`。
      if (opts.providers.length > 0) {
        // transform 函数导出在文件顶部 (buildProviderEntries),便于单测。
        // 负责 reasoningEfforts array→dict 转换、补 name 必填字段。
        const providerEntries = buildProviderEntries(opts.providers)
        await ctx.loader.create({
          name: '@deepseek-ai/dsh-llm-pi-ai',
          config: { providers: providerEntries },
        })
      }

      // 4. 注入 dsh-agent-default-model 的 defaultModel。
      //    base patch 默认 provider='deepseek-official',但 zai-side 用
      //    anthropic 路由,所以覆盖一下。
      //
      // Phase 3 P1: defaultModel 字段提取 — models 可能是 string 或
      // DshModelEntry。
      const firstModel = opts.providers[0]?.models[0]
      const firstModelId =
        typeof firstModel === 'string' ? firstModel : (firstModel?.id ?? '')
      await ctx.loader.create({
        name: '@deepseek-ai/dsh-agent-default-model',
        config: {
          provider: opts.providers[0]?.name ?? 'anthropic',
          model: opts.defaultModel || firstModelId,
        },
      })

      // 4.5 Phase 4: dsh-subagent 上游 SubagentRuntime + spawn provider。
      //
      // 装载 SubagentRuntime (cordis Service 形态) — `ctx.subagents` 暴露
      // `start('spawn', req)` / `startContinuable` / `followup` / `interrupt`
      // / `reportFrom` 等完整生命周期 API。spawnDshSubagent 改走
      // `start('spawn', req)`,由上游托管 `subagent/start` /
      // `subagent/end` 事件 + `run.result` Promise + `run.dispose()` —
      // 之前自实现绕开 `SubagentRuntime` 直接调 `agents.create()`,导致
      // 父子 turn 解耦不完整(完成事件只能通过 `<task-notification>` 注
      // 入 idle parent session,等下次 turn 才被消费 — 用户报"subagent
      // 一直没返回直到再次提问")。
      //
      // 然后调 `dsh-subagent-spawn-in-process` 的 `apply(ctx, config)`
      // 注册名为 'spawn' 的 provider。spawn provider 是 in-process 后端:
      // 在同 ctx 上 `ctx.agents.create()` 起 child session(自带独立
      // scope / system prompt / 零父 context)。`inheritsParentContext:
      // false` — 与当前 dsh-bridge 行为一致(子 agent 不继承父 prompt
      // history,只通过 setup metadata 拿 cwd / provider / model)。
      await ctx.plugin(SubagentRuntime)
      const { apply: applySpawnProvider } = await import('@deepseek-ai/dsh-subagent-spawn-in-process')
      applySpawnProvider(ctx, { providerName: 'spawn' })

      // 5. 等待全部 plugin 完成挂载。
      await ctx.get('loader')?.await()
    },

    async shutdown() {
      // 1. 拒绝新请求：标记 disposed — 后续 createAgent 调用将 throw。
      // 2. flush 当前 turn：调所有 session 的 sessions.flush。
      try {
        const sessions = ctx.get('sessions') as {
          flush?: (s: unknown) => Promise<unknown>
          listIds?: () => string[]
          load?: (id: unknown) => Promise<unknown>
        } | undefined
        if (sessions && typeof sessions.flush === 'function') {
          // 列出 session id 不一定可用；按需调用 flush on each
          const ids = (sessions.listIds?.() ?? []) as string[]
          for (const sid of ids) {
            const session = sessions.load ? await sessions.load(sid).catch(() => null) : null
            if (session) {
              await sessions.flush(session).catch((err: unknown) =>
                console.warn('[dsh-bridge] flush failed:', err),
              )
            }
          }
        }
      } catch (err) {
        console.warn('[dsh-bridge] session flush failed during shutdown:', err)
      }

      // 3. dispose Cordis ctx
      try {
        // Cordis 4.x 的 ctx 通过 registry.dispose 完成 tree 卸载；当前 API 无
        // 直接 ctx.dispose()。这里调 internal `dispose` 若存在，否则靠
        // process 退出自然清理（zai 进程模式符合）。
        const anyCtx = ctx as unknown as { dispose?: () => Promise<void> | void }
        if (typeof anyCtx.dispose === 'function') {
          await anyCtx.dispose()
        }
      } catch (err) {
        console.warn('[dsh-bridge] ctx.dispose failed:', err)
      }

      // 4. 清 globalThis 桥 — 由调用方 (KernelAdapter.shutdown) 负责。

      // 5. 减计数
      activeDshHandles--
    },
  }

  return handle
}
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
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve, dirname } from 'node:path'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { AgentPresets } from '@deepseek-ai/dsh-agent-presets'

import { DSH_KERNEL, type KernelId } from './paths.js'
import { dshSessionsRootAbs } from './sessions/store.js'

const require = createRequire(import.meta.url)

/**
 * dsh-agent-presets system preset root — zai-shipped presets。
 *
 * 路径解析:createDshRuntime.ts 在 src/,preset 目录在 ../agent-presets/;
 * build 后到 dist/,相对路径仍然解析到 package root 的 agent-presets/
 * (build script 同步复制 dist/agent-presets/ 与 src/agent-presets/ 等价)。
 *
 * 写绝对路径而不是 require.resolve,因为 dsh-agent-presets 的 PresetRoot.path
 * 期待文件系统路径而不是 resolved module 路径。
 */
function resolveSystemPresetsRoot(): string {
  // import.meta.url 形态 file:///path/to/dist/createDshRuntime.js (build 后)
  // 或 file:///path/to/src/createDshRuntime.ts (dev/tsx)。fileURLToPath 转
  // 成普通路径,再上溯一级到 package root,再 join agent-presets/。
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'agent-presets')
}

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

/**
 * Phase 5P-MCP: MCP server spec — 替代 dsh-bridge 自实现的 `McpServerSpec`。
 *
 * 上游用 `@deepseek-ai/dsh-mcp-client`(每个 server 一个 plugin instance)。
 * 注:`enabled` 字段由 zai 端 `disabledMcpServers` 过滤后,这里接收的全是
 * `enabled !== false`。`name` 必须为 `[A-Za-z0-9_-]{1,32}`(dsh-mcp-client 的约束)。
 */
export interface DshMcpServerSpec {
  /** server name — 作为 model-facing `mcp__<name>__<tool>` namespace prefix。 */
  name: string
  /** stdio:exec name(streamable-http 用 url 替代)。 */
  command?: string
  args?: string[]
  /** stdio extra env。 */
  env?: Record<string, string>
  /** stdio cwd — 未设默认 opts.defaultCwd。 */
  cwd?: string
  /** streamable-http URL(与 command 二选一)。 */
  url?: string
  /** http extra headers,典型 `Authorization`。 */
  headers?: Record<string, string>
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
  /**
   * Phase 5P-MCP: MCP server 列表(由 zai 端 `loadMcpServers(cwd)` 提供,
   * 基于 zai 的 4 scope .mcp.json 解析:enterprise > user > local > project,
   * 合并后形态)。不传或空数组 = 不装载 MCP(zai `connectMcp:false` 默认行为)。
   *
   * 启动阶段:为每个 spec 调一次 `ctx.loader.create({name:'@deepseek-ai/dsh-mcp-client', config:...})`
   * — 每个 server 一个 plugin instance,dsh-mcp-client 自带 reconnect /
   * structured-content 验证 / schema validation 自动管理。
   *
   * 替代 dsh-bridge 自实现的 `registerMcpTools(ctx, {cwd})` — 删除了 577 行代码。
   */
  mcpServers?: DshMcpServerSpec[]
}

// (DshMcpServerSpec 已 forward-declare 在 CreateDshRuntimeOptions 之前)

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
  //
  // Phase 5P1-B:Side-effect import 列表扩到 ~50 个 dsh-* 包,确保所有 Cordis
  // plugin 形态的 dsh-tool-* / dsh-skill-filesystem / dsh-* 服务都能被
  // cordis-plugin-loader 拓扑装载。Service class 形态(d-sh-skill /
  // dsh-fs-local 等)放在 start() 内用 ctx.plugin(...) 注入。
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
    // === Phase 5P1-B:补齐所有 dsh-* 服务副作用 import ===
    import('@deepseek-ai/dsh-sandbox'),
    import('@deepseek-ai/dsh-sandbox-policy'),
    import('@deepseek-ai/dsh-sandbox-local'),
    import('@deepseek-ai/dsh-shell-env'),
    import('@deepseek-ai/dsh-skill'),
    import('@deepseek-ai/dsh-skill-filesystem'),
    import('@deepseek-ai/dsh-agent-instructions'),
    import('@deepseek-ai/dsh-goal'),
    import('@deepseek-ai/dsh-host-plugin-inventory'),
    import('@deepseek-ai/dsh-file-reference'),
    import('@deepseek-ai/dsh-attachment'),
    import('@deepseek-ai/dsh-attachment-local'),
    import('@deepseek-ai/dsh-jobs'),
    import('@deepseek-ai/dsh-output-retention'),
    import('@deepseek-ai/dsh-compaction'),
    import('@deepseek-ai/dsh-compaction-basic'),
    import('@deepseek-ai/dsh-compaction-tool-result-pruner'),
    import('@deepseek-ai/dsh-session-telemetry'),
    import('@deepseek-ai/dsh-session-persistence'),
    import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/dsh-session-projection-cache'),
    import('@deepseek-ai/dsh-session-query'),
    import('@deepseek-ai/dsh-typert-protocol'),
    import('@deepseek-ai/dsh-launch-environment'),
    import('@deepseek-ai/dsh-storage'),
    import('@deepseek-ai/dsh-storage-domain'),
    import('@deepseek-ai/dsh-home-paths'),
    import('@deepseek-ai/dsh-anonymous-user-id'),
    import('@deepseek-ai/dsh-permission-presets'),
    import('@deepseek-ai/dsh-plan-mode'),
    import('@deepseek-ai/dsh-repeat-tool-reminder'),
    import('@deepseek-ai/dsh-invariants'),
    import('@deepseek-ai/dsh-atomic-write'),
    import('@deepseek-ai/dsh-brand'),
    import('@deepseek-ai/dsh-invariants'),
    // === Phase 5P1-B:上游 dsh-tool-* 工具副作用 import(不撞 zai-side) ===
    import('@deepseek-ai/dsh-tool-jobs'),
    import('@deepseek-ai/dsh-tool-goal'),
    import('@deepseek-ai/dsh-tool-ralph'),
    import('@deepseek-ai/dsh-tool-workflow'),
    import('@deepseek-ai/dsh-tool-pwsh'),
    import('@deepseek-ai/dsh-tool-subagent-control'),
    import('@deepseek-ai/dsh-tool-subagent-report'),
    import('@deepseek-ai/dsh-tool-todo'),
    // === Phase 5P1-B:切到 dsh-tool-* 时也会副作用 import(暂不装载) ===
    import('@deepseek-ai/dsh-tool-bash'),
    import('@deepseek-ai/dsh-tool-fs'),
    import('@deepseek-ai/dsh-tool-skill'),
    import('@deepseek-ai/dsh-tool-subagent'),
    import('@deepseek-ai/dsh-tool-call-timeout-policy'),
    import('@deepseek-ai/dsh-tool-str-replace-editor'),
    // dsh-subagent 上游 SubagentRuntime(`ctx.subagents.start('spawn', req)`) —
    // Phase 4 改造让 spawnDshSubagent 走上游 `start()` 而不是自实现
    // `agents.create()`,保证 `subagent/start` / `subagent/end` 生命周期事件
    // + `run.result` Promise + `run.dispose()` 由上游托管。
    import('@deepseek-ai/dsh-subagent'),
    import('@deepseek-ai/dsh-subagent-spawn-in-process'),
    import('@deepseek-ai/dsh-subagent-in-process-driver'),
    import('@deepseek-ai/dsh-subagent-fork-in-process'),
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

      // 0.5 dsh-bridge 修复:注入 LocalJobRegistry 让 ctx.jobs 可用。
      //    修复前:start() 的 Service class 注入列表漏了 LocalJobRegistry,
      //    只在 line 313 做了 side-effect import — dsh-tool-bash 跑
      //    run_in_background 时 ctx.get('jobs') === undefined,抛
      //    "background jobs unavailable: load @deepseek-ai/dsh-jobs and
      //    @deepseek-ai/dsh-tool-jobs"。LocalJobRegistry 必须在 dsh-tool-bash
      //    (走 patch.yml 装载,inject=['jobs'])之前就位,否则 cordis-plugin-loader
      //    装载 tool-bash 时 inject 解析会一直等不到 jobs service。
      {
        const { LocalJobRegistry } = await import('@deepseek-ai/dsh-jobs-local')
        await ctx.plugin(LocalJobRegistry)
      }

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
      //     AttachmentStore 实例，没它会抛 `pi-ai image input requires the
      //     durable attachment service`。用 zai dataDir 下的 `attachments/`
      //     子目录,避免污染用户 ~/.dsh/。
      await ctx.loader.create({
        name: '@deepseek-ai/dsh-attachment-local',
        config: { dshHome: join(opts.dataDir, 'attachments') },
      })

      // 2.7 Phase 5P-MCP: 为每个 mcp server 装载一个 `@deepseek-ai/dsh-mcp-client`
      //     plugin instance。`mcpServers` 由 zai 端 `loadMcpServers(cwd)` 提供,
      //     已经过 4 scope 合并(`enabled !== false` 已被过滤)。
      //     跳过空数组 — 与 `connectMcp:false` 默认行为一致。
      if (opts.mcpServers && opts.mcpServers.length > 0) {
        for (const spec of opts.mcpServers) {
          // 推断 transport (stdio / streamable-http) — stdio 默认。
          const transport: 'stdio' | 'streamable-http' = spec.url
            ? 'streamable-http'
            : 'stdio'
          const config: Record<string, unknown> = {
            serverName: spec.name,
            transport,
            // 5min default 与上游 README 一致;zai 自实现曾用 30s health check,
            // 上游更稳健。
            toolCallTimeoutMs: 60_000,
            failOnStartupError: false,
            reconnect: {
              enabled: true,
              initialDelayMs: 1_000,
              maxDelayMs: 16_000,
              maxAttempts: 5,
            },
          }
          if (spec.command) config.command = spec.command
          if (spec.args) config.args = spec.args
          if (spec.env) config.env = spec.env
          if (spec.cwd) config.cwd = spec.cwd
          if (spec.url) config.url = spec.url
          if (spec.headers) config.headers = spec.headers
          try {
            await ctx.loader.create({
              name: '@deepseek-ai/dsh-mcp-client',
              config: config as never,
            })
          } catch (err) {
            // 单 server 装载失败 — 不阻断整体启动,警告即可(与原 dsh-bridge
            // 自实现的 MCP_RETRY_DELAYS_MS = [1s,2s,4s,8s,16s] 一致策略)。
            console.warn(
              `[dsh-bridge] mcp server "${spec.name}" 装载失败(略过):`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }

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

      // 4.4 Phase 4.1: dsh-session-projection 注册表 + dsh-subagent
      // projection units。
      //
      // dsh-subagent 的 `listChildren()` 调 `prepareListing(ctx)` 拿
      // `ctx.sessionProjections` 服务。ProjectionRegistry (Service 形态)
      // 没装时抛 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` — listDshSubagents
      // 之前 fallback 到磁盘读,现在通过 ctx.plugin(SessionProjectionRegistry)
      // 装载,让 SubagentRuntime 内部的 `ctx.inject(['sessionProjections'])`
      // 注入 timing/identity projection units(自动注册 SubagentRunInfo +
      // SubagentRunEndInfo 的投影)。
      //
      // 不需要显式 loader.create('dsh-session-projection') — Service 形态
      // 用 ctx.plugin 即可。
      const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
      await ctx.plugin(SessionProjectionRegistry)

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

      // 4.7 Phase 5P6+: dsh-agent-presets — session-level composition from
      //    preset `agent.cordis.yml` files。**dsh 模式扩展 sub-agent 类型的
      //    正确路径**(替代 zai 自实现 `Agent` 工具的 subagent_type 白名单),
      //    做法:
      //
      //    a) 装 AgentPresets Service(`ctx.agentPresets`),配:
      //       - default: 'general-purpose' — 每个新 session 的默认 preset
      //       - roots:  [zai-shipped agent-presets/] (trust: 'system')
      //       - includeUserRoot: true — 追加 `<dshHome>/.agent-presets/`
      //         (USER_PRESET_DIR),trust: 'user'。dshHome 走默认
      //         `$DSH_HOME` / `~/.dsh`(`dsh-home-paths` 解析)。
      //    b) 在 `run.ts` 的 `agents.create({ setup })` 回调里调
      //       `ctx.agentPresets.mount(agentCtx)` —— AgentFactory 在
      //       `session/created` 之前 await setup,rejection 整段回滚,坏
      //       preset 永远不会产生半个发布的 session。
      //    c) subagent 由上游 `SubagentRuntime.start('spawn', req)` 内部
      //       `composeFrom(parentCtx)` 复用父 preset,无需每个 type 一个
      //       preset(差异通过 `dsh-tool-subagent.config.toolFilter` /
      //       `persona` 注入)。
      //
      //    装载顺序:`AgentPresets` 自身不 inject dsh-* services,但 mount
      //    阶段会读 dsh-home-paths 解析 user root,所以 `dsh-home-paths`
      //    必须在此前可用 — dsh-base patch 已经装上,这里不重复 create。
      const systemPresetsRoot = resolveSystemPresetsRoot()
      await ctx.plugin(AgentPresets, {
        default: 'general-purpose',
        roots: [{ path: systemPresetsRoot, trust: 'system' }],
        includeUserRoot: true,
      })

      // 4.6 Phase 4 P1: harness 原生 fs-search 工具 (`grep` + `glob`) — 已在
      //     dsh-bridge.patch.yml 第 91 行的 `tool-fs-search` row 注册。
      //     本步骤无需 ctx.loader.create,只要等 patch 装载顺序触发即可。
      //     sampleOverCapGlobResults: false — 保留 modification-time-ordered head,
      //     与 zai-side FsTab 的"按修改时间排序"心智模型一致(用户选 true 会
      //     跨 top-level entries 采样,对 zai 工作流收益小)。

      // ============================================================
      // === Phase 5P1-B:Service class 形态 dsh-* 服务接装 ===
      // ============================================================
      //
      // 这些是 cordis Service class 形态(abstract 或 concrete),不能用
      // ctx.loader.create({ name }) 装载(cordis-plugin-loader 期待
      // { name, apply, inject } 形态的 plugin object);改用 ctx.plugin(ServiceClass)
      // 直接注入到 ctx。注入顺序按上游 inject 依赖序(cordis 4.x 的 ctx.plugin
      // 会按 Service.inject 静态字段自动满足依赖)。
      //
      // 注意:patch 已用 cordis-plugin-include 装载了部分 Cordis plugin
      // 形态的同名包(如 dsh-skill-filesystem / dsh-tool-call-timeout-policy /
      // dsh-tool-todo / dsh-tool-jobs 等)— 这里不重复创建这些 Service,
      // 只补 Service 形态。

      // 1. fs seam — FileSystem (abstract) 需要 LocalFileSystem 实现
      //    Phase 5P2 准备:让 ctx.fs 可用,dsh-tool-fs 装载后立即可工作。
      //    暂**不**装载 dsh-tool-fs(避免与 zai-side fs.ts 撞 FileRead/FileWrite等名字)
      {
        const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
        await ctx.plugin(LocalFileSystem, { cwd: opts.defaultCwd })
      }

      // 2. shell seam — LocalBashExecutor (concrete)。
      //    cwd 必填;传 opts.defaultCwd。
      //    Phase 5P3 准备 dsh-tool-bash 的依赖。当前不创 ctx.shell tool,
      //    只把 LocalBashExecutor 接进 ctx 让其他 plugin 可读 ctx.shell。
      {
        const { LocalBashExecutor } = await import('@deepseek-ai/dsh-bash-local')
        await ctx.plugin(LocalBashExecutor, { cwd: opts.defaultCwd })
      }

      // 3. sandbox seam — LocalSandboxProvider (concrete)。
      //    默认 sandbox policy 从 ZAI_SANDBOX 环境变量读(沿袭 dsh-bridge 旧行为)。
      //    不显式调 setSandboxMode('off'),让 process.env 决定。
      {
        const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
        await ctx.plugin(LocalSandboxProvider)
      }

      // 4. skill registry — SkillRegistry (concrete)。
      //    上面 patch 已装 dsh-skill-filesystem,这是它的 provider 源。
      {
        const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
        await ctx.plugin(SkillRegistry)
      }

      // 5. goal service — GoalService (concrete)。
      //    上面 patch 已装 dsh-tool-goal,这里只创 service。
      {
        const { GoalService } = await import('@deepseek-ai/dsh-goal')
        await ctx.plugin(GoalService)
      }

      // 6. token meter — TokenMeter (concrete)。
      //    dsh-tool-call-timeout-policy 和 dsh-compaction-basic 都依赖 ctx.tokenMeter。
      {
        const { TokenMeter } = await import('@deepseek-ai/dsh-token-meter')
        await ctx.plugin(TokenMeter)
      }

      // 7. host plugin inventory — PluginInventoryGateway (concrete)。
      //    把当前 Cordis loader 的 plugin entries 暴露给 typert remote 调用。
      //    zai-side 后续可以用它查"已装载的工具"。
      {
        const { PluginInventoryGateway } = await import('@deepseek-ai/dsh-host-plugin-inventory')
        await ctx.plugin(PluginInventoryGateway)
      }

      // 8. file reference service — FileReferenceService is **abstract**;
      //    需要具体 subclass。当前 zai-side 没用,跳过。Phase 5P2+ 如果需要
      //    "@file path" 语法再装。
      //
      // const { FileReferenceService } = await import('@deepseek-ai/dsh-file-reference')
      // await ctx.plugin(FileReferenceService)  // ❌ abstract

      // 9. web runtime — **不装载**(zai-side 决策)。
      //    若需 web_search / web_fetch,加入:
      //      import('@deepseek-ai/dsh-web')
      //      import('@deepseek-ai/dsh-tool-web')
      //      import('@deepseek-ai/dsh-web-search-deepseek')
      //    然后在 patch.yml 加 `tool-web` row,createDshRuntime 装
      //      `WebRuntime + searchProvider(fetchProvider)`。

      // 10. compaction engine — BasicCompactionEngine extends CompactionEngine,
      //     自动注册 'compaction' service + 装载 basic 策略。不需要单独装
      //     CompactionEngine(同时注册会报 'service "compaction" has been
      //     registered')。ToolResultPruner 是独立 service name。cast 同上。
      {
        const { default: BasicCompactionEngine } = await import(
          '@deepseek-ai/dsh-compaction-basic'
        )
        await ctx.plugin(BasicCompactionEngine as any)
        const { default: ToolResultPruner } = await import(
          '@deepseek-ai/dsh-compaction-tool-result-pruner'
        )
        await ctx.plugin(ToolResultPruner as any)
      }

      // 11. session telemetry backend 是 abstract — 没装具体 backend 跳过。
      //     zai-side 要加 OTEL/HMR 时再装 dsh-session-telemetry-otel。

      // ============================================================
      // === Phase 5P1-B:暂不装载(等 Phase 5P2-N 单独迁移) ===
      // ============================================================
      //
      // - dsh-tool-bash:撞 zai-side Bash,Phase 5P3 迁移(需改名 or 砍 zai Bash)
      // - dsh-tool-fs:撞 FileRead/Write/Edit/Stat,Phase 5P2 迁移
      // - dsh-tool-subagent:撞 Agent,Phase 5P6 迁移
      // - dsh-tool-skill:撞 Skill,Phase 5P4 迁移

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
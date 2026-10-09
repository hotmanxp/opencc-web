// @zn-ai/zn-agent-core
export const VERSION = '0.1.0'
export * from './compat/permissions.js'
export * from './compat/permissionMode.js'
export * from './compat/commands/index.js'
export * from './compat/commands/handoffFs.js'
export {
  setDefaultSandboxManager,
  getDefaultSandboxManager,
} from './compat/sandboxManager.js'
export { RequestApproveTool } from './compat/requestApproveTool/RequestApproveTool.js'
export { REQUEST_APPROVE_TOOL_NAME } from './compat/requestApproveTool/prompt.js'
export type { RequestApproveInput, RequestApproveOutput } from './compat/requestApproveTool/schema.js'
export { enableOpenccConfigs } from './compat/openccInit.js'
// Runtime types (Batch 1: pure types/constants)
export type {
  AskRegistryLike,
  ApproveRegistryLike,
  ModelCaller,
  QueryOptions,
  RuntimeConfig,
  SandboxConfig,
  Tool,
  UserMessage,
} from './compat/runtime/types.js'
export type { AskUserAnswers } from './compat/runtime/types.js'

// Runtime event contract (Batch 2a)
export type {
  ErrorCategory,
  RuntimeEvent,
  RuntimeErrorEvent,
  RuntimeDoneEvent,
  RuntimeAbortedEvent,
} from './compat/runtime/events.js'

// Background runtime (Batch 2a: persistence + scheduler compat shims)
export * from './compat/background/index.js'

// MCP client pool + related (Batch 2b)
export * from './compat/mcp/index.js'

// Plugin runtime (Batch 2c)
export * from './compat/plugins/index.js'

// DefaultAgentRuntime (Batch 2d) — removed in Task 6. The new server
// runtime (opencc-src/server's createOpenccRuntime, exposed via the
// main entry through bundle-entry.ts) replaces the `DefaultAgentRuntime`
// path entirely; callers migrated in commit da4c50e5 (Task 5). The
// `AgentRuntime` interface itself is preserved for back-compat re-export.
// (no more exports here)

// TranscriptStore (compat) — Task 6 removed the *synthetic* compat store,
// not this class. The name `legacyTranscriptStore` is misleading: the class
// is a fully-implemented, live transcript accessor, NOT a stub. Empirical
// shape (verified against on-disk JSONL, 2026-10-08):
//
//   vendor 环  ──写──►  JSONL  user / assistant / tool_use / tool_result
//                        （自动压缩的 postCompactMessages 也走这条，占 ~96%）
//   zai 侧     ──写──►  JSONL  session-meta / custom-title / last-prompt
//                        + 可见 slash 指令行（appendMessageEntry 通道），
//                        + /compact 与 /clear 的整文件覆盖（replace）
//   zai 侧     ──读──►  JSONL  read / list —— 唯一的读回通道
//
// `append()` 单独是 no-op（消息行由 vendor 环写，见该方法注释）；其余方法
// 全部真实落盘。routes/agent.ts 等有 30+ 处活跃调用，勿当死代码清理。
//
// `opencc-src/server/sessionFacade.ts` 实现了另一套 session API，但 zai
// 侧零调用（仅注释提及）——见 sessionFacade-impl.ts 顶部的未接入标注。
// compat/transcript/persistence.ts 另有一个仅供类型用的 structural
// `TranscriptStore` interface，让既有的 zai 测试导入仍能编译。
export { TranscriptStore } from './compat/runtime/legacyTranscriptStore.js'
// zai 侧会话归档服务用同一个路径编码（见该文件的 sanitizePath 注释）。
export { sanitizePath } from './compat/runtime/legacyTranscriptStore.js'

// Data directory helpers
export { resolveDataDir } from './compat/data/dataDir.js'
export type { DataDirConfig } from './compat/data/dataDir.js'

// Skills runtime (Batch 3a)
export * from './compat/runtime/skills-index.js'

// zai patch (2026-09-23): vendor skill/command 目录热更新 watcher 的 types
// stub —— 与上面的 queryModelWithStreaming 同模式。
//
// 运行时真值是 esbuild bundle(dist/opencc-core.mjs)里 vendor
// `opencc-src/utils/skills/skillChangeDetector.ts` 的实现,经 bundle-entry.ts
// 显式 re-export 暴露;这里只给 zai 端 tsc 一个可用契约表面(主 tsconfig
// exclude 了 src/opencc-src,直接引用会触发 TS6307)。bundle-entry.d.ts 的
// re-export 目标由 scripts/bundle-opencc.ts 的 DTS_PATH_REWRITE 镜像到
// ./index.js,所以本声明必须与 vendor 实现保持同名同形。
//
// vendor 语义: 监听 ~/.agents/skills、~/.agents/commands、项目 .zai/{skills,
// commands}、--add-dir 的 .zai/skills;变更 1s 防抖后清 skill/command 缓存 +
// 重置模型侧 skill_listing 去重,再 emit。
export declare const skillChangeDetector: {
  initialize(): Promise<void>
  dispose(): Promise<void>
  subscribe(listener: () => void): () => void
}

// zai-native AskUserQuestion executor. The tool the model actually calls is
// vendor's, wrapped by compat/tools/opencc/AskUserQuestionTool.ts and injected
// at opencc-src/server/createHeadlessContext-impl.ts:290.
export { askUserQuestionTool } from './compat/tools/index.js'

// zai patch (2026-10-08, P3-1): 移除了 `compactSession` 的 re-export。
//
// `compat/runtime/compactService.ts` 是 v0 遗留 shim,要求调用方显式注入
// `modelCaller` —— 而 commit da5956c3 已移除 zai 自建 modelCaller,所以它恒
// 报「未配置」,从建立起就没有任何生产调用方(全仓只有这里的 re-export 和
// `builtin.compact.test.skip.ts` 里的注释提及)。
//
// 手动 /compact 的当前实现在 `packages/zai/src/server/services/commands/
// builtin/compact.ts`,已改走 vendor `compactViaVendor`(见 compat/compact/
// compactBridge.ts)。连同 compactService.ts 一并删除。
//
// 注意:不要连带删 `opencc-src/server/sessionFacade-impl.ts` —— 它同样是
// 「未接入」状态,但性质不同(是待启用的新 API,而 compactService 是已被
// 取代的旧实现)。

// Memory helpers (already in compat/memory/loader.js; re-export for main entry)
export { clearMemoryCache, loadMemoryForPrompt } from './compat/memory/loader.js'
export type { MemoryFile, MemoryType } from './compat/memory/loader.js'

// zai patch (2026-08-09): vendor queryModelWithStreaming 的 types stub。
//
// 运行时 esbuild bundle (`dist/opencc-core.mjs`) 把 vendor 的
// queryModelWithStreaming / asSystemPrompt 编入 bundle 并通过 re-export
// 暴露(zai/src/server/services/commands/builtin/compact.ts 直接 import,
// 拿 runtime 值)。types 不走 dist/opencc-src/** — 主 tsconfig.json 把
// src/opencc-src 排除(vendor 有未修的 ts 错误),让 src/index.ts 引用
// ./opencc-src/** 会触发 TS6307 错误(transitive file 不在项目文件列表)。
//
// 这里 declare-only 的签名是 zai 端 compact 调用所需的最小契约:
//   - messages: vendor 的 Message[]
//   - systemPrompt: branded readonly string[] (用 asSystemPrompt 构造)
//   - thinkingConfig / tools / signal / options: 调 vendor 的标准参数
//
// runtime 调用的是 esbuild bundle 里的真实实现,types 只是给 zai tsc 看的
// 契约表面,签名不匹配处 zai 端用 `as` cast 即可。
export type Message = {
  type: string
  content: string
  message?: { content: string | unknown[]; role?: string }
  uuid?: string
  parentUuid?: string | null
  timestamp?: string | number
}

export type SystemPrompt = readonly string[] & { readonly __brand: 'SystemPrompt' }

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}

export declare function queryModelWithStreaming(args: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: { type: 'disabled' | 'enabled'; budgetTokens?: number }
  tools: unknown[]
  signal: AbortSignal
  options: {
    model: string
    querySource: string
    isNonInteractiveSession: boolean
    hasAppendSystemPrompt: boolean
    agents: unknown[]
    mcpTools: unknown[]
    getToolPermissionContext: () => Promise<unknown>
    [key: string]: unknown
  }
}): AsyncIterable<unknown>

// zai patch (2026-10-08, 手动 /compact 接线 P0): 压缩后缓存清理。
// 与上面的 queryModelWithStreaming 同模式 —— declare-only 契约，运行时真值
// 由 esbuild bundle 经 bundle-entry.ts 的 re-export 提供(见
// scripts/bundle-opencc.ts 的 DTS_PATH_REWRITE 镜像)。
//
// vendor 语义(postCompactCleanup.ts):压缩成功后清理
// microcompact 追踪状态、getUserContext / getMemoryFiles memo、
// systemPromptSections、分类器审批、Bash 权限推测、beta tracing、
// sessionMessages cache。querySource 可选,undefined 视为主线程。
export declare function runPostCompactCleanup(querySource?: string): void

// zai patch (2026-10-08, 手动 /compact 接线 P0): 抑制「距下次 auto-compact
// 还剩多少」提示。同 declare-only 模式。vendor 参考实现在
// commands/compact/compact.ts:128 成功压缩后调用。
export declare function suppressCompactWarning(): void

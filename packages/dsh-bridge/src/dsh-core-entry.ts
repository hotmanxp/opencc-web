/**
 * dsh-core bundle entry — esbuild 把这里 import 的所有 dsh-side 模块
 * 静态解析并内联到 dist/dsh-core.mjs 单文件。
 *
 * **范围**:
 * - 只 re-export dsh-side named symbols,**不打 dsh-bridge 自身**(对齐
 *   opencc-core.mjs 范式 —— vendor runtime 单文件,compat/adapter 留在
 *   外层 tsc 编译产物)。zai-side 看到的 `@zn-ai/dsh-bridge` 主入口
 *   dist/index.js 仍是 tsc 编译产物,**对外 API 零变化**。
 *
 * **Phase A PoC**:
 * - 入口聚合 dsh-bridge/src 静态 import 用到的所有 dsh-side named symbols
 * - esbuild 静态追踪所有 transitive 依赖,自动 inline 到 dsh-core.mjs
 * - external 列表见 scripts/bundle-dsh.ts(必要 external:koffi /
 *   cordis-plugin-loader / zod / @modelcontextprotocol/sdk)
 *
 * **不参与 bundle 改造**(保留原样):
 * - `createDshRuntime.ts:323-408` 的 80+ 行 `await import('@deepseek-ai/dsh-xxx')`
 *   是 **副作用触发 import**(Phase 5P1-B 引入,目的是触发 plugin 顶层
 *   `ctx.plugin(...)` 装饰器注册的 ESM cache miss),这些改写会破坏
 *   cordis-plugin-loader 的 plugin 拓扑装载。
 * - `ctx.loader.create({ name: '@deepseek-ai/dsh-xxx', config })` 中的
 *   `name` 字符串是 cordis-plugin-loader 的模块解析 key,改写会让
 *   Loader 找不到模块。
 * - `@deepseek-ai/cordis` 类型 import(`Context`):纯类型,无运行时引用,
 *   编译擦除后无副作用,无需 bundle。
 *
 * **双实例权衡**(Phase B/C 解决):
 * - 静态 import 走 bundle subpath → dsh-core.mjs 内单实例
 * - 动态 import + Loader create 走 node_modules → 独立 instance
 * - 两份 instance 共享同一源码(同包名版本),功能相同但 JS identity 不同
 *   (类的 `instanceof` 检查会失败)。Phase A 只验证 bundle 链路,不验证
 *   完整 dsh 模式启动;Phase B 设计 exports map 多 subpath 让 Loader
 *   也走 bundle,彻底单实例。
 */

// ── dsh-session ────────────────────────────────────────────────────────
// run.ts:31 / abort.ts:20 / sessionProjections.ts:24 /
// sessions/store.ts:27 / subagent/taskStore.ts:35 /
// translate/sessionEvents.ts:25
export { SessionId } from '@deepseek-ai/dsh-session'
export type {
  Session,
  SessionEvent,
  SessionEventType,
  AgentCancelCause,
} from '@deepseek-ai/dsh-session'

// ── dsh-llm ────────────────────────────────────────────────────────────
// run.ts:32 / tools/cron.ts:27 / subagent/taskStore.ts:36
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export type { ContentBlock } from '@deepseek-ai/dsh-llm'

// ── dsh-tools ──────────────────────────────────────────────────────────
// commands/index.ts:16 / plugins/index.ts:25 / tools/askUser.ts:36 /
// tools/bash.ts:19 / tools/cron.ts:25 / tools/displayFiles.ts:24 /
// tools/skill.ts:18 / tools/subagent.ts:24 / tools/taskList.ts:29
export { defineTool } from '@deepseek-ai/dsh-tools'

// ── dsh-subagent ───────────────────────────────────────────────────────
// createDshRuntime.ts:36 / subagent/taskStore.ts:37
// Phase 4:走上游 SubagentRuntime.start('spawn', req) 替代自实现 agents.create
export { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
export type { SubagentRun, SubagentResult } from '@deepseek-ai/dsh-subagent'

// ── dsh-agent-presets ──────────────────────────────────────────────────
// createDshRuntime.ts:37 — AgentPresets Service(preset YAML 装载)
export { AgentPresets } from '@deepseek-ai/dsh-agent-presets'

// ── dsh-session-persistence-jsonl ──────────────────────────────────────
// createDshRuntime.ts:35 — 引入 koffi(native FFI,走 esbuild external)
export { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'

// ── dsh-shell ──────────────────────────────────────────────────────────
// tools/bash.ts:20-26 — ShellExecutor 子类化 + 类型
export { ShellExecutor } from '@deepseek-ai/dsh-shell'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'

// ── dsh-agent(类型 only) ──────────────────────────────────────────────
// run.ts:29 / abort.ts:19 / subagent/taskStore.ts:34
// tools/subagent.ts:72, 235 inline-type 形式
export type { Agent } from '@deepseek-ai/dsh-agent'

// ── dsh-user-approval(类型 only) ──────────────────────────────────────
// interaction/bridge.ts:25 — 消费方用 `import { ApprovalRequest as DshApprovalRequest }`
// 形式 re-alias(避免与 zai 自身 ApprovalRequest 类型冲突)。dsh-core 这里 export
// 源名 `ApprovalRequest` 即可,消费方 import 时再做 alias。
export type {
  ApprovalRequest,
  ApprovalOutcome,
} from '@deepseek-ai/dsh-user-approval'

// ── dsh-jobs(类型 only) ───────────────────────────────────────────────
// tools/registry.ts:40
export type { JobId, JobRegistry, JobStatus } from '@deepseek-ai/dsh-jobs'

// ── dsh-user-questions(类型 only) ─────────────────────────────────────
// tools/askUser.ts:38-43
export type {
  AskUserQuestionItem,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
  UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
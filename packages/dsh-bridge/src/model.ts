/**
 * 模型选择桥接 — ds-021 hotfix (per-turn model 切换) + B1a T1.4 收口。
 *
 * 历史:旧实现是 stub(`agentCtx.set('modelSelection', ...)`),把 zai 解析的
 * provider/model 写到 ctx state 就返回,没真接 dsh-llm。下游 adapter 一直
 * 只能用 `createDshRuntime` 时传入的 `defaultModel`,用户在 web UI 切 model
 * 不生效。
 *
 * 修复:dsh 上游(`@deepseek-ai/dsh-agent`, `core/agent/src/model-selection.ts`)
 * 提供现成 `installModelSelection(agentCtx, ref)`,监听 agent scope 内的
 * `'system-prompt/assemble'` 与 `'agent/request'` 两个事件,把 `ref.current`
 * 写到下一次的 LlmCallConfig.provider/model。**scope-local**,天然并发安全
 * (同进程多 session 各自的 agent scope 各自装一份 ref)。
 *
 * zai 端用 `createModelSelectionRef()` 开 ref holder,keyed by sessionId
 * 维护,每次 `adapter.run({ model })` 更新 `ref.current` → 下次 followup
 * 自然命中新 model。详见 docs/superpowers/plans/2026-08-22-per-turn-model-fix.md
 * (待补 plan 文档;在 dsh 维护契约 §6 已知缺口修补序列中)。
 *
 * zai 的 settings 解析(`defaultModel`、`ANTHROPIC_*` env 语义、provider/
 * model route overrides)与 provider/model route overrides — 详见
 * docs/superpowers/specs/2026-08-03-provider-model-route-overrides-design.md
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection as upstreamInstallModelSelection,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'

/**
 * 创建空的 model selection ref holder — 每个 session 持一份。
 *
 * 形态 `{ current, assembled }` — `current` 是"下一次请求要用的选择",
 * `assembled` 在上游 `system-prompt/assemble` 事件里被 snapshot(防止同
 * turn 内切换撕裂 prompt assembly vs LlmCallConfig 两个 surface)。
 *
 * @param initial — 初始选择,缺省表示无选择(由 dsh-llm 走 profile default)。
 */
export function createModelSelectionRef(
  initial?: ModelSelection,
): ModelSelectionRef {
  return { current: initial, assembled: undefined }
}

/**
 * 把 ref holder 装到 agent scope(scope-local),返回 disposer。
 *
 * 上游实现:监听 `'system-prompt/assemble'` 把 `ref.current` 写入
 * `assembly.variables.provider/model`;监听 `'agent/request'` 把
 * `ref.assembled` 写入 LlmCallConfig.provider/model — 该 listener
 * 是 scope-local,所以并发多 session 互不干扰。
 *
 * 调用方必须保证 `ref` 在整个 agent 生命周期内持续存在(它是被 mutate 的
 * holder,不是 snapshot)。zai 用 `Map<sessionId, ref>` 在 adapter 层
 * 维持所有权,dispose session 时清 map + dispose 上游 listener。
 *
 * @param agentCtx - agent 的 scoped Context(在 `agents.create({ setup })`
 *   回调里拿到的就是 agentCtx)。
 * @param ref - 持有当前 selection 的可变 holder。
 * @returns disposer,同时解除 `'system-prompt/assemble'` 与 `'agent/request'`
 *   两个 listener。
 */
export function installModelSelection(
  agentCtx: Context,
  ref: ModelSelectionRef,
): () => void {
  return upstreamInstallModelSelection(agentCtx, ref)
}

/**
 * 从 zai settings + process.env 解析 cold-start 默认 model selection。
 *
 * 解析顺序(仅用于 `createDshRuntime.defaultModel` 与初始 ref seed):
 *   1. zai settings.model(用户/项目级覆盖)
 *   2. process.env.ANTHROPIC_DEFAULT_SONNET_MODEL(zai 默认)
 *   3. process.env.ANTHROPIC_SMALL_FAST_MODEL(zai fast)
 *   4. 默认 'MiniMax-M3'(与 zn-agent-core / agentRuntime.ts:370-372 对齐)
 *
 * 此函数只用于进程启动时把 `defaultModel` 落入 `createDshRuntime` 与
 * model selection ref 初始值;运行期 per-turn 模型切换走
 * `installModelSelection` + `ref.current` 直写。
 */
export function resolveModelSelection(opts: {
  settingsModel?: string
}): ModelSelection {
  const model =
    opts.settingsModel
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? process.env.ANTHROPIC_SMALL_FAST_MODEL
    ?? 'MiniMax-M3'
  // provider 走默认 anthropic(zai 默认) — dsh-cmdline 与 dsh-llm 子项目
  // 以 anthropic 为基础 adapter(llm-adapter-guide)。
  return { provider: 'anthropic', model }
}

// 重新导出上游类型,避免 zai-side 另接 @deepseek-ai/dsh-agent
// 增长 zai 包依赖面(由 dsh-bridge 主入口收敛)。
export type { ModelSelection, ModelSelectionRef }

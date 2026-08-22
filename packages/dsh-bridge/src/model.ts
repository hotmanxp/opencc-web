/**
 * 模型选择桥接 — B1a T1.4。
 *
 * zai settings 的 provider/model 解析结果（`defaultModel`、`ANTHROPIC_*` env
 * 语义、provider/model route overrides — 详见
 * docs/superpowers/specs/2026-08-03-provider-model-route-overrides-design.md）
 * 映射到 dsh 的 `installModelSelection` 调用形态。
 *
 * dsh 的 model selection 走 LlmAdapter 子类（B1a 阶段 zai 默认走 zai-friendly adapter，
 * 复用 `ANTHROPIC_*` env）；B2 阶段把 zai 的 route overrides 接进 adapter 选择逻辑。
 */

import type { Context } from '@deepseek-ai/cordis'

export interface ModelSelection {
  provider: string
  model: string
  /** 备用备选 — dsh `assembled` 字段（headless/index.js:115-118） */
  assembled?: unknown
}

/**
 * 安装 model selection 到 agent ctx。
 *
 * dsh-headless 提供 `installModelSelection(agentCtx, selection)`，签名与 zai 的
 * 解析结果不直接对齐：dsh 期望 `{ current: { provider, model }, assembled }`。
 *
 * 当前实现把 zai 的 selection 平铺到 dsh 格式。
 */
export async function installModelSelection(
  agentCtx: Context,
  selection: ModelSelection,
): Promise<void> {
  // installModelSelection 是 dsh-agent 的导出函数，签名：
  //   installModelSelection(agentCtx, { current, assembled })
  // 当前为 stub：仅记录到 ctx config，不直接调 dsh 函数（B1a 真实接线时补）。
  agentCtx.set('modelSelection', {
    current: selection,
    assembled: selection.assembled,
  })
}

/**
 * 从 zai settings + process.env 解析当前生效的 model selection。
 *
 * 解析顺序：
 *   1. zai settings.model（用户/项目级覆盖）
 *   2. process.env.ANTHROPIC_DEFAULT_SONNET_MODEL（zai 默认）
 *   3. process.env.ANTHROPIC_SMALL_FAST_MODEL（zai fast）
 *   4. 默认 'MiniMax-M3'（与 zn-agent-core / agentRuntime.ts:370-372 对齐）
 */
export function resolveModelSelection(opts: {
  settingsModel?: string
}): ModelSelection {
  const model =
    opts.settingsModel
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? process.env.ANTHROPIC_SMALL_FAST_MODEL
    ?? 'MiniMax-M3'
  // provider 走默认 anthropic（zai 默认）。
  // dsh-cmdline 与 dsh-llm 子项目以 anthropic 为基础 adapter（llm-adapter-guide）。
  return { provider: 'anthropic', model }
}
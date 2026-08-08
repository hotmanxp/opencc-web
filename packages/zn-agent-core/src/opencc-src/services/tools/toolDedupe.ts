// zai patch (2026-08-08): 并行工具去重判定(独立模块,避免拖入
// StreamingToolExecutor 的完整依赖链 — 后者 import Tool.js 会触发
// BashTool 等工具注册,BashTool 需要 getMaxTimeoutMs 等 vendor 运行时
// 状态,纯逻辑测试拉不起)。
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { stableStringify } from 'src/utils/stableStringify.js'

export type ToolQueueStatus = 'queued' | 'executing' | 'completed' | 'yielded'

export type DedupeCandidate = {
  status: ToolQueueStatus
  block: ToolUseBlock
}

/**
 * 找到已 queued/executing、且 name + input 完全相同的工具调用。
 * 在同一轮响应里模型可能重复提交相同工具调用(例如 429/超时重试或
 * 并行发散时);命中重复项则跳过执行,避免同一命令并行执行两次放大
 * 上游请求(会话 sess-1786201578807 现场:同一 `pnpm test` 命令被
 * 并行提交两次)。input 用 stableStringify 做指纹,避免 JSON key
 * 顺序差异导致误判。
 */
export function findDuplicateTrackedTool(
  tools: DedupeCandidate[],
  block: ToolUseBlock,
): { id: string; name: string } | null {
  const inputKey = stableStringify(block.input ?? {})
  const dup = tools.find(
    (t) =>
      (t.status === 'queued' || t.status === 'executing') &&
      t.block.name === block.name &&
      stableStringify(t.block.input ?? {}) === inputKey,
  )
  return dup ? { id: dup.block.id, name: dup.block.name } : null
}

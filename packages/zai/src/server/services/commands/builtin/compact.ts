import {
  compactSession,
} from '@zn-ai/zai-agent-core'
import type { LocalCommand, LocalCommandResult } from '@zn-ai/zai-agent-core'
import {
  getTranscriptStore,
  getCurrentSessionId,
  getRuntime,
} from '../../agentRuntime.js'

/**
 * /compact 真正实现: 读 transcript → 调 LLM 生成 summary → 追加
 * compact_boundary + assistant(summary) 两条 message 落盘。
 *
 * 设计见 docs/superpowers/specs/2026-07-18-compact-command-design.md §6-7
 */
export const compactCommand: LocalCommand = {
  type: 'local',
  name: 'compact',
  description: '手动压缩当前对话',
  argumentHint: '[--force]',
  source: 'builtin',
  async call(_args, context): Promise<LocalCommandResult> {
    try {
      // 1. resolve sessionId
      const sessionId = context.sessionId ?? getCurrentSessionId() ?? undefined
      if (!sessionId) {
        // 静默兜底 — 没有 session 视为 cleared
        return { kind: 'cleared' }
      }

      // 2. 读 + 校验 < 2
      const store = getTranscriptStore()
      let existing: Awaited<ReturnType<typeof store.read>> | null = null
      try {
        existing = await store.read(sessionId)
      } catch {
        return { kind: 'error', message: '会话不存在' }
      }

      if (existing.messages.length < 2) {
        return {
          kind: 'error',
          message: `对话太短, 无需压缩 (当前 ${existing.messages.length} 条, 至少需要 2 条)`,
        }
      }

      // 3. 取 modelCaller
      const runtime = getRuntime()
      const modelCaller = (runtime as unknown as { config?: { modelCaller?: any } }).config?.modelCaller
      if (!modelCaller) {
        return { kind: 'error', message: 'ModelCaller 未配置 (agent runtime 未初始化)' }
      }

      // 4. 调 service
      const result = await compactSession({
        store,
        sessionId,
        modelCaller,
        cwd: context.cwd,
        model: context.model ?? (runtime as unknown as { config?: { defaultModel?: string } }).config?.defaultModel,
      })

      if (result.kind === 'error') return result

      // 5. 落盘
      try {
        await store.replace(sessionId, result.newMessages)
      } catch (err) {
        return { kind: 'error', message: `落盘失败: ${(err as Error).message}` }
      }

      return {
        kind: 'compacted',
        removedMessages: existing.messages.length - 2,
        summary: result.summary,
      }
    } catch (err) {
      // 兜底 — 任何未被上面 try/catch 接住的 throw
      return {
        kind: 'error',
        message: `压缩失败: ${(err as Error).message.slice(0, 200)}`,
      }
    }
  },
}

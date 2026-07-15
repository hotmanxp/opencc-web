import type { LegacyTool } from '../Tool.js'
import { BackgroundAgentInputSchema, type BackgroundAgentInput } from './schema.js'
import { renderBackgroundAgentPrompt } from './prompt.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
  TaskNotFoundError,
} from '../../runtime/background/index.js'

export const BACKGROUND_AGENT_TOOL_NAME = 'BackgroundAgent'

/**
 * 暴露给 LLM 的「后台任务 dispatch」工具。
 * 立即返回 shortId,不等待任务完成。
 */
export const BackgroundAgentTool: LegacyTool<typeof BackgroundAgentInputSchema, string> = {
  name: BACKGROUND_AGENT_TOOL_NAME,
  description: renderBackgroundAgentPrompt(),
  inputSchema: BackgroundAgentInputSchema,
  // 关键:支持并发 — LLM 同一 turn 内多次调用不会互锁
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput) {
    const input = rawInput as BackgroundAgentInput
    if (!hasBackgroundRuntime()) {
      return {
        output:
          'BackgroundAgent 当前不可用:BackgroundRuntime 未初始化。请在 Web 服务下使用,或通过 setBackgroundRuntime() 注入。',
        isError: true,
      }
    }
    try {
      const runtime = getBackgroundRuntime()
      const task = await runtime.dispatch({
        prompt: input.prompt,
        cwd: input.cwd,
        agent: input.agent,
      })
      const label = input.label ?? input.prompt.slice(0, 40)
      const message = `后台任务已派发: "${label}"。可用 BackgroundAgentResult 工具(shortId=${task.id})查询结果。`
      return {
        output: JSON.stringify(
          {
            shortId: task.id,
            status: 'dispatched',
            message,
          },
          null,
          2,
        ),
        isError: false,
      }
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return { output: `task not found: ${err.message}`, isError: true }
      }
      return {
        output: `BackgroundAgent dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
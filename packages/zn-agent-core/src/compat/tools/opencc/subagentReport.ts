/**
 * subagent_report — 子 agent 主动向父 agent 上报(对齐 DSH tool-subagent-report)。
 * 注册进 AgentTool 子上下文;父 session 优先取子上下文注入值,回退
 * per-async-chain ALS,最后才回退 __zaiCurrentSessionId bridge。
 */
import { z } from 'zod/v4'
import { deliverInboxMessage } from '../../inboxBridge.js'
import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'

export const subagentReportTool = {
  name: 'subagent_report',
  description: '报告当前子任务的进度或移交结果给父 agent。',
  inputSchema: z.object({
    output: z.string().describe('上报给父 agent 的内容。'),
    delivery: z
      .enum(['wakeup', 'quiet'])
      .default('wakeup')
      .describe('wakeup:父空闲则开新 turn;quiet:合并到父的下一次交互。'),
  }),
  async execute(
    input: { output: string; delivery?: 'wakeup' | 'quiet' },
    context: { parentSessionId?: string },
  ): Promise<{ delivered: boolean }> {
    const delivery = input.delivery ?? 'wakeup'
    // zai patch (2026-10-16, cc-002 治理项): 加 ALS 层。此前只读进程级全局
    // `__zaiCurrentSessionId` —— 单例,多 session 共享进程时互相覆写,上报
    // 会投进别的会话。顺序与 SpawnAgent / CliAgent / subagentControl 对齐:
    // 显式 context → per-chain ALS(经 globalThis seam)→ 全局兜底。
    const alsSessionId = (globalThis as {
      __zaiSessionIdResolver?: () => string | undefined
    }).__zaiSessionIdResolver?.()
    const senderSessionId =
      alsSessionId ??
      (globalThis as { __zaiCurrentSessionId?: string }).__zaiCurrentSessionId ??
      ''
    const parent = context.parentSessionId ?? senderSessionId
    if (!parent) return { delivered: false }
    return {
      delivered: deliverInboxMessage({
        parentSessionId: parent,
        senderSessionId,
        content: input.output,
        delivery,
        source: { kind: 'subagent', form: 'report' },
      }),
    }
  },
}

/**
 * vendor 表面版本:裸露的 `{ name, description, inputSchema, execute }`
 * 直接塞进子代理工具集时,vendor 的 `toolToAPISchema` 会对每个工具调
 * `tool.prompt(...)`(utils/api.ts:221),缺该方法 → 子代理第一轮 API
 * 请求抛 `tool.prompt is not a function`,任务永远停留在 queued
 * (HRMSV3-ZN-WEBSITE#668 回归,2026-08-18)。用 wrapAsOpenccTool 补全
 * vendor Tool 必需表面(prompt / mapToolResultToToolResultBlockParam /
 * checkPermissions 等),runAgent.ts 组装 `allTools` 时用它替代裸工具。
 */
export const subagentReportOpenccTool = wrapAsOpenccTool({
  name: subagentReportTool.name,
  description: subagentReportTool.description,
  inputSchema: subagentReportTool.inputSchema,
  call: async (
    args: unknown,
    ctx: unknown,
  ): Promise<{ delivered: boolean }> => {
    return subagentReportTool.execute(
      args as { output: string; delivery?: 'wakeup' | 'quiet' },
      (ctx ?? {}) as { parentSessionId?: string },
    )
  },
})

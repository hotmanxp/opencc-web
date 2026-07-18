import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { LegacyTool } from '../Tool.js'
import { renderPrompt } from './prompt.js'
import { AgentInputSchema } from './schema.js'
import { loadAgentDefinitions } from './loadAgentsDir.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../runtime/background/index.js'

type AgentInput = z.infer<typeof AgentInputSchema>

export const AgentTool: LegacyTool<typeof AgentInputSchema, string> = {
  name: 'Agent',
  description: renderPrompt(),
  inputSchema: AgentInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as AgentInput

    // 默认后台模式:派发到 BackgroundRuntime,立即返回 shortId。
    // 关闭需显式传 run_in_background: false。
    if (input.run_in_background !== false && hasBackgroundRuntime()) {
      try {
        const runtime = getBackgroundRuntime()
        const parentSessionId = ctx.parentSessionId ?? 'sess-unknown'
        const subSessionId = `${parentSessionId}-sub-${randomUUID().slice(0, 8)}`
        const desc = input.description ?? input.prompt.slice(0, 60)
        ctx.emitEvent({
          type: 'subagent:start',
          subSessionId,
          subagentType: input.subagent_type,
          description: desc,
        })
        // ★ 关键:把 parentSessionId / agentType / description 写到
        // dispatch metadata。zai server 端 SubagentNotifier 在任务
        // 进入 terminal 时,会读 task.parentSessionId 把
        // <task-notification> user 消息回流到父 session,触发下一轮
        // turn。LLM 收到通知后继续,不需要主动调 TaskOutput.
        const task = await runtime.dispatch({
          prompt: input.prompt,
          cwd: ctx.cwd,
          agent: input.subagent_type,
          metadata: {
            parentSessionId,
            agentType: input.subagent_type,
            description: desc,
          },
        })
        ctx.emitEvent({
          type: 'subagent:dispatched',
          subSessionId,
          taskId: task.id,
          subagentType: input.subagent_type,
        })
        return {
          output: `<subagent_dispatched agent_type="${input.subagent_type}" task_id="${task.id}">\n后台 Agent 已派发:"${desc}"\n系统会在完成后自动以 <task-notification> 形式通知父 session,不要主动调用 TaskOutput。\n只有需要查看部分进度时再用 TaskOutput(task_id="${task.id}", block:false) 查询。\n</subagent_dispatched>`,
          isError: false,
        }
      } catch (err) {
        // 后台派发失败时回落到同步路径
        console.warn('[AgentTool] background dispatch failed, falling back to sync:', err)
      }
    }

    // 同步路径:run_in_background=false 或 BackgroundRuntime 未初始化
    if (!ctx.__runtimeConfig) {
      return { output: 'AgentTool disabled: no __runtimeConfig in ToolContext', isError: true }
    }

    const pluginAgents = (ctx.state as any).__pluginAgents ?? []
    const def = await loadAgentDefinitions(
      ctx.dataDir,
      ctx.__runtimeConfig?.userAgentsDir,
      undefined,
      pluginAgents,
    )
    const agent = def.agents.find(a => a.name === input.subagent_type)
                 ?? def.agents.find(a => a.name === 'general-purpose')

    const parentSessionId = ctx.parentSessionId ?? 'sess-unknown'
    const subSessionId = `${parentSessionId}-sub-${randomUUID().slice(0, 8)}`

    const subOpts = {
      prompt: input.prompt,
      cwd: ctx.cwd,
      model: agent?.model ?? ctx.__defaultModel,
      systemPrompt: agent?.systemPrompt,
      additionalTools: agent?.additionalTools,
      parentSessionId,
      subagentType: input.subagent_type,
      maxTurns: agent?.maxTurns ?? ctx.__maxTurns ?? 25,
      abortSignal: ctx.abortSignal,
      disallowedTools: ['Agent'],
    }

    const hookRunner = (ctx.state as any).__pluginHookRunner as import('../../plugins/HookRunner.js').HookRunner | undefined
    if (hookRunner) {
      await hookRunner.run('SubagentStart', {
        subagentType: input.subagent_type,
        prompt: input.prompt,
        sessionId: parentSessionId,
      }, ctx.abortSignal)
    }

    ctx.emitEvent({
      type: 'subagent:start',
      subSessionId,
      subagentType: input.subagent_type,
      description: input.description ?? input.prompt.slice(0, 60),
    })

    // Dynamic import breaks the queryEngine ↔ AgentTool cycle
    const { queryEngine } = await import('../../runtime/queryEngine.js')
    const subStream = queryEngine(subOpts, ctx.__runtimeConfig)
    let finalOutput = ''
    let exitReason: 'completed' | 'aborted' | 'max_turns' | 'error' = 'completed'
    try {
      for await (const ev of subStream) {
        ctx.emitEvent({ type: 'subagent:event', subSessionId, event: ev })
        const t = (ev as { type: string }).type
        // 兜底: 累积 text_delta. 正常路径下 queryEngine 已在 runtime.done.text
        // 携带最终文本, 这里只作为 stream 改写 / 旧版兼容时的防御.
        if (t === 'content_block_delta' && (ev as any).delta?.type === 'text_delta') {
          finalOutput += (ev as any).delta.text
          continue
        }
        if (t === 'runtime.done') {
          exitReason = 'completed'
          if (typeof (ev as any).text === 'string' && (ev as any).text.length > 0) {
            finalOutput = (ev as any).text
          }
          break
        }
        if (t === 'runtime.aborted') { exitReason = 'aborted'; break }
        if (t === 'runtime.error') {
          exitReason = ((ev as any).error?.code === 'max_turns_reached') ? 'max_turns' : 'error'
          if ((ev as any).error?.message) {
            finalOutput = `error: ${(ev as any).error.message}`
          }
          break
        }
      }
    } catch (err) {
      exitReason = 'error'
      finalOutput = `error: ${err instanceof Error ? err.message : String(err)}`
    }

    if (hookRunner) {
      await hookRunner.run('SubagentStop', {
        subagentType: input.subagent_type,
        output: finalOutput,
        exitReason,
        sessionId: parentSessionId,
      }, ctx.abortSignal)
    }
    ctx.emitEvent({ type: 'subagent:done', subSessionId, output: finalOutput, exitReason })

    return {
      output: `<subagent_result agent_type="${input.subagent_type}" exit_reason="${exitReason}">\n${finalOutput}\n</subagent_result>`,
      isError: exitReason === 'error',
    }
  },
}

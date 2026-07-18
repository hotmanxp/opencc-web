import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { LegacyTool } from '../Tool.js'
import { getAgentToolDescription } from './prompt.js'
import { AgentInputSchema } from './schema.js'
import { loadAgentDefinitions } from './loadAgentsDir.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../runtime/background/index.js'

type AgentInput = z.infer<typeof AgentInputSchema>

export const AgentTool: LegacyTool<typeof AgentInputSchema, string> = {
  name: 'Agent',
  description: getAgentToolDescription(),
  inputSchema: AgentInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  // ---------------------------------------------------------------------------
  // Opencc Tool contract methods
  // ---------------------------------------------------------------------------

  async validateInput(input: AgentInput): Promise<
    { result: true } | { result: false; message: string; errorCode: number }
  > {
    if (!input.prompt || input.prompt.length === 0) {
      return { result: false, message: 'prompt must not be empty', errorCode: 1 }
    }
    return { result: true }
  },

  async checkPermissions(): Promise<{ behavior: 'allow' }> {
    return { behavior: 'allow' }
  },

  userFacingName(input: AgentInput): string {
    return `Agent(${input.subagent_type})`
  },

  getActivityDescription(input: AgentInput): string {
    if (input.description) return input.description
    return input.prompt.slice(0, 60)
  },

  getToolUseSummary(input: AgentInput): string | null {
    if (input.description) return input.description
    return null
  },

  toAutoClassifierInput(input: AgentInput) {
    return {
      name: 'Agent',
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      description: input.description,
    }
  },

  mapToolResultToToolResultBlockParam(output: any, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result',
      content: typeof output === 'string' ? output : JSON.stringify(output),
      is_error: false,
    }
  },

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
        // 把 parentSessionId / agentType / description 写到 dispatch metadata,
        // zai server 端 SubagentNotifier 在任务进入 terminal 时,会读
        // task.parentSessionId 把 <task-notification> user 消息回流到父
        // session,触发下一轮 turn。
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
        console.warn('[AgentTool] background dispatch failed, falling back to sync:', err)
        // fall through to sync
      }
    }

    // 同步路径:runForkedAgent(走 prompt 缓存共享)
    if (!ctx.__runtimeConfig) {
      return { output: 'AgentTool disabled: no __runtimeConfig in ToolContext', isError: true }
    }

    const { runForkedAgent, getLastCacheSafeParams, extractResultText } = await import(
      '../../opencc-internals/utils/forkedAgent.js'
    )
    const { createUserMessage } = await import('../../opencc-internals/utils/messages.js')

    const pluginAgents = (ctx.state as any).__pluginAgents ?? []
    const def = await loadAgentDefinitions(
      ctx.dataDir,
      ctx.__runtimeConfig?.userAgentsDir,
      undefined,
      pluginAgents,
    )
    const agent = def.agents.find(a => a.name === input.subagent_type)
                 ?? def.agents.find(a => a.name === 'general-purpose')
                 ?? def.agents[0]

    const parentSessionId = ctx.parentSessionId ?? 'sess-unknown'
    const subSessionId = `${parentSessionId}-sub-${randomUUID().slice(0, 8)}`
    const desc = input.description ?? input.prompt.slice(0, 60)
    const abortController = new AbortController()
    ctx.abortSignal.addEventListener('abort', () => abortController.abort(ctx.abortSignal.reason), { once: true })

    const hookRunner = (ctx.state as any).__pluginHookRunner as import('../../plugins/HookRunner.js').HookRunner | undefined
    if (hookRunner) {
      await hookRunner.run('SubagentStart', {
        subagentType: input.subagent_type,
        prompt: input.prompt,
        sessionId: parentSessionId,
      }, ctx.abortSignal)
    }
    ctx.emitEvent({ type: 'subagent:start', subSessionId, subagentType: input.subagent_type, description: desc })

    const sharedParams = getLastCacheSafeParams()
    const systemContext: Record<string, string> = {
      ...(sharedParams?.systemContext ?? {}),
    }
    if (agent?.systemPrompt) {
      // Inject agent.systemPrompt into systemContext so cache hit is preserved.
      systemContext['__AGENT_PROMPT__'] = agent.systemPrompt
    }

    let exitReason: 'completed' | 'aborted' | 'max_turns' | 'error' = 'completed'
    let finalOutput = ''
    try {
      // 防递归(R6):sync path 必须阻断 sub-agent 继续派 sub-agent.
      // async 路径靠 defaultBackgroundRuntime.ts:273 在 agentRuntime.run
      // 时把 {disallowedTools:['Agent']} 传给 queryEngine →
      // resolveToolPool(queryEngine.ts:390) 在 tools 数组里过滤掉
      // Agent. runForkedAgent 没有 top-level 参数,只能通过
      // cacheSafeParams.toolUseContext.options 注入.
      //
      // 两件事必须同时做:
      // (a) options.disallowedTools: ['Agent'] — 复刻 spec / async 路径合同
      // (b) options.tools 把 name==='Agent' 的条目剔除 — opencc query.ts
      //     直接读 toolUseContext.options.tools 喂给 StreamingToolExecutor
      //     (1040) / 模型 (1199),不会过 resolveToolPool,所以"声明
      //     disallowedTools"这一行本身不能阻止递归. 必须显式剥掉 Agent.
      // options.disallowedTools is a zai-local extension; upstream's
      // strict ToolUseContext.options type doesn't know about it. Cast
      // antiRecursionOptions as any so we can attach the zai field
      // without a structural-type mismatch on commands[] or undefined.
      const antiRecursionOptions: any = {
        ...(sharedParams?.toolUseContext.options ?? {}),
        disallowedTools: Array.from(
          new Set([
            ...(((sharedParams?.toolUseContext.options as any)?.disallowedTools ?? []) as string[]),
            'Agent',
          ]),
        ),
        ...((sharedParams?.toolUseContext.options as any)?.tools
          ? {
              tools: ((sharedParams?.toolUseContext.options as any).tools as any[]).filter(
                (t: any) => t?.name !== 'Agent',
              ),
            }
          : {}),
      }
      const cacheSafeParams = sharedParams
        ? {
            ...sharedParams,
            systemContext,
            toolUseContext: {
              ...sharedParams.toolUseContext,
              options: antiRecursionOptions,
            },
          }
        : {
            systemPrompt: '',
            userContext: {},
            systemContext,
            toolUseContext: {
              abortController,
              options: antiRecursionOptions,
            } as any, // minimal stub
            forkContextMessages: [],
          }
      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: input.prompt }) as any],
        cacheSafeParams,
        canUseTool: ctx.canUseTool,
        querySource: 'agent',
        forkLabel: input.subagent_type,
        maxTurns: agent?.maxTurns ?? ctx.__maxTurns ?? 25,
        onStreamEvent: (ev) => ctx.emitEvent({ type: 'subagent:event', subSessionId, event: ev }),
        skipTranscript: true,
        skipCacheWrite: false,
      })
      finalOutput = extractResultText(result.messages, 'Execution completed')
    } catch (err) {
      if (ctx.abortSignal.aborted) exitReason = 'aborted'
      else exitReason = 'error'
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
      output:
        `<subagent_result agent_type="${input.subagent_type}" exit_reason="${exitReason}">\n` +
        `${finalOutput}\n</subagent_result>`,
      isError: exitReason === 'error',
    }
  },
}

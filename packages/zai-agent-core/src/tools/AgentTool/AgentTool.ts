import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext } from '../Tool.js'
import { renderPrompt } from './prompt.js'
import { AgentInputSchema } from './schema.js'
import { loadAgentDefinitions } from './loadAgentsDir.js'

type AgentInput = z.infer<typeof AgentInputSchema>

export const AgentTool: Tool<typeof AgentInputSchema, string> = {
  name: 'Agent',
  description: renderPrompt(),
  inputSchema: AgentInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as AgentInput
    if (!ctx.__runtimeConfig) {
      return { output: 'AgentTool disabled: no __runtimeConfig in ToolContext', isError: true }
    }

    const def = await loadAgentDefinitions(ctx.dataDir)
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
        if (t === 'runtime.done') { exitReason = 'completed'; break }
        if (t === 'runtime.aborted') { exitReason = 'aborted'; break }
        if (t === 'runtime.error') {
          exitReason = ((ev as any).error?.code === 'max_turns_reached') ? 'max_turns' : 'error'
        }
      }
    } catch (err) {
      exitReason = 'error'
      finalOutput = `error: ${err instanceof Error ? err.message : String(err)}`
    }

    ctx.emitEvent({ type: 'subagent:done', subSessionId, output: finalOutput, exitReason })

    return {
      output: `<subagent_result agent_type="${input.subagent_type}" exit_reason="${exitReason}">\n${finalOutput}\n</subagent_result>`,
      isError: exitReason === 'error',
    }
  },
}

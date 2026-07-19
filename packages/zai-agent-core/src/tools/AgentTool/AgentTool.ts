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

/**
 * Auto-background threshold (ms) read from env. When the sync path of the
 * main-loop AgentTool call runs longer than this, the call is automatically
 * aborted and re-dispatched via BackgroundRuntime. Opencc gates the same
 * feature behind CLAUDE_AUTO_BACKGROUND_TASKS / GrowthBook; zai uses the
 * env var ZAI_AUTO_BACKGROUND_AGENTS_MS directly (default 0 = disabled).
 */
function getAutoBackgroundMs(): number {
  const raw = process.env.ZAI_AUTO_BACKGROUND_AGENTS_MS
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

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

  // ---------------------------------------------------------------------------
  // Isolation gate (P1-2)
  // ---------------------------------------------------------------------------

  /**
   * Returns the effective isolation strategy for this call. Reads the env
   * gate ZAI_ENABLE_AGENT_WORKTREE_ISOLATION — when set (truthy) and the
   * caller passed isolation: 'worktree', the value is propagated. Otherwise
   * 'none' (no worktree created). zai has no worktree utility yet; the
   * value flows into the metadata so a future implementation can pick it up
   * without a schema change.
   */
  resolveIsolation(input: AgentInput): 'worktree' | 'none' {
    if (input.isolation !== 'worktree') return 'none'
    const enabled = process.env.ZAI_ENABLE_AGENT_WORKTREE_ISOLATION
    if (!enabled || enabled === '0' || enabled.toLowerCase() === 'false') {
      return 'none'
    }
    return 'worktree'
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

    // Resolve effective model: input.model > agent def model > parent inherit.
    // The agent definition's frontmatter `model` is read below in the sync
    // path; here we only honor the explicit per-call override for dispatch.
    const resolvedModel = input.model
    // Isolation: gate-checked, falls back to 'none' if the env flag isn't set.
    const isolation = AgentTool.resolveIsolation!(input)

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
        //
        // model: optional override → flows through DispatchInput.model to
        //   BackgroundRuntime → DefaultBackgroundRuntime.runOne → QueryOptions.model
        //   → queryLoop.ts:142/247 (model is picked up by modelCaller).
        // name: forwarded to metadata for future SendMessage addressing.
        // isolation: forwarded to metadata; consumers (or future worktree util)
        //   can read it to spin up an isolated copy.
        const task = await runtime.dispatch({
          prompt: input.prompt,
          cwd: ctx.cwd,
          agent: input.subagent_type,
          model: resolvedModel,
          metadata: {
            parentSessionId,
            agentType: input.subagent_type,
            description: desc,
            ...(input.name ? { name: input.name } : {}),
            ...(isolation !== 'none' ? { isolation } : {}),
          },
        })
        ctx.emitEvent({
          type: 'subagent:dispatched',
          subSessionId,
          taskId: task.id,
          subagentType: input.subagent_type,
        })
        // Structured output (P2-5): union<sync, async>. zai's LegacyTool
        // returns string, so JSON.stringify the async branch. Frontends that
        // already parse the legacy <subagent_dispatched> tag keep working
        // (the JSON object sits at the tail of the same envelope), and new
        // consumers can parse the trailing JSON block directly.
        const structuredAsync = {
          status: 'async_launched' as const,
          taskId: task.id,
          description: desc,
          prompt: input.prompt,
          agentType: input.subagent_type,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(isolation !== 'none' ? { isolation } : {}),
        }
        return {
          output:
            `<subagent_dispatched agent_type="${input.subagent_type}" task_id="${task.id}">\n`
            + `后台 Agent 已派发:"${desc}"\n系统会在完成后自动以 <task-notification> 形式通知父 session,不要主动调用 TaskOutput。\n只有需要查看部分进度时再用 TaskOutput(task_id="${task.id}", block:false) 查询。\n</subagent_dispatched>\n`
            + `<!--structured:${JSON.stringify(structuredAsync)}-->`,
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
        // Per-call model override: input.model > agent def frontmatter > parent
        // inherit. queryLoop.ts:142/247 reads `options.model` first, then falls
        // back to config.defaultModel. ToolUseContext.options doesn't formally
        // declare `model` (it's a zai-local extension, like disallowedTools),
        // so the spread carries the field through the type-narrow Any cast.
        ...((resolvedModel ?? agent?.model)
          ? { model: resolvedModel ?? agent?.model }
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
      // Auto-background (P2-6): race the sync run against a timer; if it
      // exceeds ZAI_AUTO_BACKGROUND_AGENTS_MS, abort + re-dispatch via
      // BackgroundRuntime and return the async_launched envelope. Mirrors
      // opencc's CLAUDE_AUTO_BACKGROUND_TASKS gate (120s default there).
      const autoBgMs = getAutoBackgroundMs()
      const autoBgController = new AbortController()
      const onAbortRelay = () => autoBgController.abort(ctx.abortSignal.reason)
      ctx.abortSignal.addEventListener('abort', onAbortRelay, { once: true })
      let autoBgTimer: ReturnType<typeof setTimeout> | undefined
      if (autoBgMs > 0 && hasBackgroundRuntime()) {
        autoBgTimer = setTimeout(() => autoBgController.abort('auto-background'), autoBgMs)
      }
      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: input.prompt }) as any],
        cacheSafeParams,
        canUseTool: ctx.canUseTool,
        querySource: 'agent',
        forkLabel: input.subagent_type,
        maxTurns: agent?.maxTurns ?? ctx.__maxTurns,
        // Model override (per-call input.model > agent def frontmatter > parent)
        // is already plumbed via cacheSafeParams.toolUseContext.options.model
        // (see antiRecursionOptions above). queryLoop.ts:142/247 reads
        // `options.model` and forwards it to modelCaller.
        onStreamEvent: (ev) => ctx.emitEvent({ type: 'subagent:event', subSessionId, event: ev }),
        skipTranscript: true,
        skipCacheWrite: false,
      })
      if (autoBgTimer) clearTimeout(autoBgTimer)
      finalOutput = extractResultText(result.messages, 'Execution completed')
    } catch (err) {
      // Auto-background tripped: re-dispatch via BackgroundRuntime and return
      // the async_launched envelope. The sync call was aborted before any
      // final output was produced (or partial output existed), so the parent
      // session gets a taskId it can poll via TaskOutput.
      const autoBgMs = getAutoBackgroundMs()
      if (
        autoBgMs > 0 &&
        hasBackgroundRuntime() &&
        // Distinguish abort-by-auto-bg from abort-by-user: only the former triggers.
        ctx.abortSignal.reason === undefined
      ) {
        try {
          const runtime = getBackgroundRuntime()
          const task = await runtime.dispatch({
            prompt: input.prompt,
            cwd: ctx.cwd,
            agent: input.subagent_type,
            model: resolvedModel,
            metadata: {
              parentSessionId,
              agentType: input.subagent_type,
              description: desc,
              autoBackgrounded: true,
              ...(input.name ? { name: input.name } : {}),
              ...(isolation !== 'none' ? { isolation } : {}),
            },
          })
          ctx.emitEvent({
            type: 'subagent:dispatched',
            subSessionId,
            taskId: task.id,
            subagentType: input.subagent_type,
          })
          const structuredAsync = {
            status: 'async_launched' as const,
            taskId: task.id,
            description: desc,
            prompt: input.prompt,
            agentType: input.subagent_type,
            autoBackgrounded: true,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(isolation !== 'none' ? { isolation } : {}),
          }
          return {
            output:
              `<subagent_dispatched agent_type="${input.subagent_type}" task_id="${task.id}" auto_backgrounded="true">\n`
              + `Sync Agent 超时 (>=${autoBgMs}ms),已自动切到后台:"${desc}"\n系统会在完成后自动以 <task-notification> 形式通知父 session。\n</subagent_dispatched>\n`
              + `<!--structured:${JSON.stringify(structuredAsync)}-->`,
            isError: false,
          }
        } catch {
          // fall through to error path
        }
      }
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

    // Structured sync output (P2-5). Same envelope shape as before plus a
    // trailing JSON block carrying status: 'completed'. Frontends that read
    // <subagent_result> still parse the legacy tag; new consumers can pick
    // the JSON off the tail.
    const structuredSync = {
      status: 'completed' as const,
      agentType: input.subagent_type,
      prompt: input.prompt,
      output: finalOutput,
      exitReason,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(isolation !== 'none' ? { isolation } : {}),
    }
    return {
      output:
        `<subagent_result agent_type="${input.subagent_type}" exit_reason="${exitReason}">\n` +
        `${finalOutput}\n</subagent_result>\n` +
        `<!--structured:${JSON.stringify(structuredSync)}-->`,
      isError: exitReason === 'error',
    }
  },
}

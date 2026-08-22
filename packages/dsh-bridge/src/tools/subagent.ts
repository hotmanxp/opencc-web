/**
 * Agent 工具 — dsh 风格 (dsh-017)。
 *
 * 把 `spawnDshSubagent` (subagent/taskStore.ts) 包成 dsh `defineTool`,
 * 对齐 opencc AgentTool 的 input schema (description / prompt / subagent_type /
 * model / run_in_background),让 dsh 模式 LLM 能调 subagent spawn。
 *
 * opencc AgentTool input schema 参考 packages/zn-agent-core/src/opencc-src/
 * tools/AgentTool/AgentTool.tsx:94-99;opencc 走 zod 4 + lazySchema,dsh 走
 * dsh-tools 的 schemastery 参数描述(对齐 fs.ts 的 parameters 形态)。
 *
 * **Phase 1 范围** (本次):
 *   - description + prompt + subagent_type + model + run_in_background
 *   - 父 session 自动从 opts.getParentSessionId() 拉
 *   - 父 agent 自动从 ctx.agents.get(parentSessionId) 拉
 *   - run_in_background 立即返回 taskId;否则 await handle.promise 拿结果
 *
 * **Phase 2 范围** (暂不实现):
 *   - name / team_name / mode / isolation / cwd 字段(opencc 多 agent 模式)
 *   - subagent_type 路由: Phase 1 默认 'general-purpose',其他类型报清晰错误
 *   - worktree 隔离: dsh 0.1.0-rc.7 不支持
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  spawnDshSubagent,
  type DshTaskState,
} from '../subagent/taskStore.js'

/**
 * dsh Agent 接口最小子集 — zai 端不直接 import @deepseek-ai/dsh-agent,
 * 而是通过 dsh-bridge 暴露这个 type 来约束 contract(只要 zai 端返回的对象
 * 有 followup / session / cancel 字段,subagent.ts 的 spawnDshSubagent 就能用)。
 */
export type AgentToolParentAgent = {
  followup: (msg: unknown) => void
  session: unknown
  cancel: (cause: { kind: 'user' }) => void
}

/** Agent 工具选项 — 跟 registerBashTool 对齐,接 zai 端注入的 sink。 */
export interface AgentToolOptions {
  /** 当前 cwd — 子 agent 继承。 */
  cwd: string
  /** 父 session id — 通知父 agent 时需要。 */
  getParentSessionId: () => string | undefined
  /**
   * 当前 dsh provider profile name — 子 agent 需继承(否则 dsh 在
   * agent/request waterfall 找不到 provider/model,抛 "has no provider/model"
   * 错误)。dsh-014 修复同样问题。zai dsh factory 注入 'anthropic' (B1a
   * T1.4 收口的 default profile)。
   */
  getProvider?: () => string | undefined
  /**
   * Phase 3 P0-A+ B1: 默认 model name — LLM 没显式传 model 时,子 agent
   * 用 zai 配置的 defaultModel (settings.json model 或 ANTHROPIC_DEFAULT_SONNET_MODEL)。
   * 不传则用 LLM 输入的 `model` 字段(undefined 时 dsh 抛 "has no provider/model")。
   */
  getDefaultModel?: () => string | undefined
  /**
   * 拿父 agent 回调 — Cron 触发时用 + Agent 工具 spawn 后通知父 agent 用。
   * 接受 `AgentToolParentAgent` 子集类型(只要有 followup / session / cancel
   * 字段即可),zai 端不用 import 完整 dsh Agent 类型。
   */
  getParentAgent?: (sessionId: string) => AgentToolParentAgent | undefined
  /**
   * dsh agents service 提供者 — dsh-tools ToolRunContext 不含 cordis ctx,
   * 需要 zai 端把 ctx.get('agents') 预解析后注入。Agent 工具 spawn 子 agent
   * 时需要这个 service。
   */
  getAgentsService?: () => import('@deepseek-ai/dsh-agent').Agent | unknown | undefined
  /**
   * dsh-019 修复:`ctx.plugin is not a function` 错误 — spawnDshSubagent 内部
   * 用 `createScope(parentCtx, ...)` 创建子 scope,需要 parentCtx.plugin(scope)
   * 装载 scope 内部 cordis 实例。stub ctx(只 mock get)缺 plugin 方法,
   * 报 "ctx.plugin is not a function"。zai 端传真实 handle.ctx 走这条路,
   * getAgentsService 仍保留(供 ctx.get('agents') fallback)。
   */
  getDshCtx?: () => Context | undefined
  /**
   * 子任务启动 sink — 转发到 zai `subagentTracker` (类比 bashBackgroundTracker),
   * 让 UI TaskDock 看到 dsh subagent 任务。不传则不注册。
   */
  onTaskStart?: (info: { taskId: string; description: string; prompt: string }) => void
  /**
   * 子任务完成 sink — 转发到 zai `subagentTracker.markFinished`。
   * 状态: 'running' → 'done' / 'failed' / 'cancelled'。
   */
  onTaskFinish?: (info: {
    taskId: string
    status: 'done' | 'failed' | 'cancelled'
    error?: string
  }) => void
}

/**
 * 格式化任务结果文本 — 给 LLM 看。
 */
function formatTaskResult(state: DshTaskState): string {
  if (state.status === 'done') {
    return `[dsh-subagent task ${state.taskId} completed in ${state.finishedAt! - state.startedAt}ms]\n\nResult:\n${typeof state.result === 'string' ? state.result : JSON.stringify(state.result ?? null, null, 2)}`
  }
  if (state.status === 'failed') {
    return `[dsh-subagent task ${state.taskId} failed in ${state.finishedAt! - state.startedAt}ms]\n\nError: ${state.error ?? '(unknown)'}`
  }
  if (state.status === 'cancelled') {
    return `[dsh-subagent task ${state.taskId} was cancelled]`
  }
  return `[dsh-subagent task ${state.taskId} still running; this should not happen when await finished]`
}

/**
 * Agent 工具 — dsh 风格,让 LLM 能 spawn 子 agent 跑复杂任务。
 */
export function createAgentTool(opts: AgentToolOptions) {
  return defineTool({
    name: 'Agent',
    description:
      'Launch a new agent to handle a complex, multi-step task autonomously. ' +
      'By default (`run_in_background=true`) the subagent runs asynchronously and this ' +
      'call returns a task ID immediately — you will be notified via <task-notification> ' +
      'in a later turn when it finishes. If you set `run_in_background=false`, this call ' +
      'blocks until the subagent completes (synchronous mode, used when you need the result ' +
      'before continuing). Use subagent_control to send messages or interrupt a running ' +
      "task. subagent_type defaults to 'general-purpose' in dsh mode (Phase 1).",
    parameters: {
      description: {
        type: 'string',
        description: 'A short (3-5 word) summary of the task for tracking in TaskDock UI.',
        required: true,
      },
      prompt: {
        type: 'string',
        description: 'The full task description for the subagent to execute.',
        required: true,
      },
      subagent_type: {
        type: 'string',
        description:
          "Optional. The type of specialized agent to use. dsh Phase 1 only supports 'general-purpose' " +
          "(default). Other types return a clear error.",
      },
      model: {
        type: 'string',
        description:
          'Optional model override (e.g. "claude-3-5-sonnet-latest", "MiniMax-M3"). ' +
          'If omitted, inherits the parent session model.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Set to true to spawn the subagent and return a task ID immediately. ' +
          'You will receive a <task-notification> in a later turn when the subagent completes.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Human-readable result text for the parent model.' },
          taskId: { type: 'string', description: 'The subagent task ID. Use for tracking and subagent_control.' },
          status: {
            type: 'string',
            enum: ['done', 'failed', 'cancelled', 'running'],
            description: 'Final (or initial, if run_in_background=true) subagent status.',
          },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { output: string }
        return [{ type: 'text', text: v.output }]
      },
    },
    async execute(args, ctxObj) {
      const a = args as {
        description: string
        prompt: string
        subagent_type?: string
        model?: string
        run_in_background?: boolean
      }
      // dsh-tools `ToolRunContext` 包含 `agent` (dsh Agent) + `signal`。
      // 但 spawnDshSubagent 需要 cordis Context 来调 ctx.get('agents')。
      // 工具内部通过 ctxObj.agent 拿父 agent（不依赖 globalThis 桥）;
      // ctx 用 unknown cast (内部访问具体 API 已有强类型 import)。
      const ctx = ctxObj as unknown as Context
      const parentSessionId = opts.getParentSessionId()
      const ctxObjAgent = (ctxObj as { agent?: unknown }).agent as AgentToolParentAgent | undefined
      // 优先用 ctxObj.agent（dsh-tools 直接传）;否则用 opts.getParentAgent fallback
      const parentAgent = ctxObjAgent
        ?? (parentSessionId && opts.getParentAgent ? opts.getParentAgent(parentSessionId) : undefined)

      // Phase 1: only 'general-purpose' (or omitted) is supported
      if (a.subagent_type && a.subagent_type !== 'general-purpose') {
        return {
          output: `[error] subagent_type "${a.subagent_type}" is not supported in dsh Phase 1. ` +
            `Only "general-purpose" is available; omit the field to use the default.`,
          taskId: '',
          status: 'failed' as const,
        }
      }

      let handle
      try {
        // dsh-019 修复:用真实 cordis ctx(必须能调 ctx.plugin(scope)装载
        // 子 scope)。getDshCtx 优先(传真实 ctx),fallback 到 stub(只
        // mock get('agents'),够 spawnDshSubagent 跑但 createScope 会失败)。
        const realCtx = opts.getDshCtx?.()
        const agentsService = opts.getAgentsService?.()
        let ctx: Context
        if (realCtx) {
          ctx = realCtx
        } else if (agentsService) {
          // stub fallback — 仅 mock get('agents'),createScope 内部会失败
          ctx = {
            get: (key: string) => key === 'agents' ? agentsService : undefined,
          } as unknown as Context
          console.warn(
            '[dsh-bridge] Agent tool: getDshCtx not provided by zai-side, ' +
            'falling back to stub ctx — subagent spawn will fail with "ctx.plugin is not a function"',
          )
        } else {
          return {
            output: '[error] dsh-bridge Agent tool: neither getDshCtx nor getAgentsService provided by zai-side wiring',
            taskId: '',
            status: 'failed' as const,
          }
        }
        handle = await spawnDshSubagent(ctx, {
          parentSessionId,
          // cast 子集到完整 Agent — spawnDshSubagent 内部只用 followup /
          // session（notifications）;dsh Agent 的其他字段不需要。
          parentAgent: parentAgent as unknown as import('@deepseek-ai/dsh-agent').Agent,
          prompt: a.prompt,
          cwd: opts.cwd,
          // Phase 3 P0-A+ B1: model 优先级 = LLM 传的 `model` 参数 >
          // zai 配置的 defaultModel (getDefaultModel)。LLM 不传时 fallback
          // 到 defaultModel,避免 dsh "has no provider/model" 错。
          model: a.model ?? opts.getDefaultModel?.(),
          // Phase 3 P0-A+ B1: 传 provider 让子 agent 能找到 LLM profile
          // (否则 dsh 抛 "has no provider/model" — dsh-014 修复同样问题)。
          provider: opts.getProvider?.(),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: `[error] failed to spawn subagent: ${message}`,
          taskId: '',
          status: 'failed' as const,
        }
      }

      // 通知 zai-side tracker (TaskDock UI)
      opts.onTaskStart?.({
        taskId: handle.taskId,
        description: a.description,
        prompt: a.prompt,
      })

      if (a.run_in_background) {
        // **异步模式** (Phase 4 保留):立刻返回 running,父 turn end 后
        // 子 agent 仍继续跑;完成后通过 `<task-notification>` 注入父
        // session inbox,等下次 turn 被消费(用户在 UI 再次提问触发)。
        return {
          output: `Subagent ${handle.taskId} spawned in background. ` +
            `You will be notified via <task-notification> when it finishes. ` +
            `Use subagent_control to send messages or interrupt this task.`,
          taskId: handle.taskId,
          status: 'running' as const,
        }
      }

      // **同步模式** (Phase 4 新增,DSH 0.1.0-rc.8 走上游 SubagentRuntime):
      // await handle.promise,父 turn 阻塞到子 agent 完成 → SubagentRun.result
      // → 映射成 DshTaskState → 包装成 done/failed/cancelled 返回。
      // 父 turn 自然 end 前拿到结果(无需重启 turn),对齐 opencc vendor
      // TaskOutputTool 的 waitForTaskCompletion 语义。
      //
      // 上游 dsh-subagent 在 0.1.0-rc.8 已经把 dsh-scope 父子隔离托管在
      // SubagentRuntime.start() 内部,dsh-017 之前"强制 run_in_background=true
      // 避开 dsh-scope binding bug"的根因已不存在 — LLM 现在可以自由选
      // 同步 / 异步。
      try {
        const finalState = await handle.promise
        return {
          output: formatTaskResult(finalState),
          taskId: handle.taskId,
          status: finalState.status,
        }
      } catch (err) {
        // handle.promise 由 spawnDshSubagent 内部包装 — promise 本身永不
        // reject(失败时 resolve 成 status='failed'),只有基础设施故障才
        // 走到这里。降级到 failed 让 LLM 能看到错误。
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: `[error] subagent ${handle.taskId} crashed: ${message}`,
          taskId: handle.taskId,
          status: 'failed' as const,
        }
      }
    },
  })
}

/**
 * 注册 Agent 工具到 dsh ctx.tools。
 * 类比 registerBashTool 的形态,返回 disposer。
 */
export function registerAgentTool(
  ctx: Context,
  opts: AgentToolOptions,
): () => void {
  const tools = ctx.get('tools') as {
    register: (tool: ReturnType<typeof defineTool>) => () => void
  }
  if (!tools) {
    throw new Error('[dsh-bridge] registerAgentTool: ctx.tools unavailable — dsh-tools not loaded?')
  }
  return tools.register(createAgentTool(opts)) as () => void
}

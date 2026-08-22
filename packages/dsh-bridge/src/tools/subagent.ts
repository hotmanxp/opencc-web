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
      'The subagent always runs in the background in dsh mode — this call returns ' +
      'a task ID immediately. You will be notified via <task-notification> in a later ' +
      'turn when the subagent finishes. Use subagent_control to send messages or ' +
      "interrupt this task. subagent_type defaults to 'general-purpose' in dsh mode (Phase 1).",
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
          model: a.model,
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
        return {
          output: `Subagent ${handle.taskId} spawned in background. ` +
            `You will be notified via <task-notification> when it finishes. ` +
            `Use subagent_control to send messages or interrupt this task.`,
          taskId: handle.taskId,
          status: 'running' as const,
        }
      }

      // dsh-017 修订：Agent 工具在 dsh 模式**强制 run_in_background=true**。
      // 原因:
      //   1. dsh-subagent 是独立 dsh Agent,跑独立 session + 独立 scope,
      //      与父 agent 异步 — 等同 zai 风格的"后台任务"
      //   2. dsh 0.1.0-rc.8 已知 dsh-scope binding bug,即使父 session
      //      fresh 也会随机失败(同一 parentScopeKey 对象被重复 bind)。
      //      改成后台让 LLM turn 立即结束,scope 失败只影响子 agent
      //      启动,不影响父 agent 继续走
      //   3. TaskDock UI 立即看到子 agent 任务(同 bash 后台任务机制)
      //   4. 子 agent 完成时通过 `<task-notification>` 自动注入父
      //      session 下一轮 turn(已在 spawnDshSubagent 内部实现)
      //
      // LLM 传的 `run_in_background` 字段在 dsh 模式下**忽略** — 永远
      // 走后台。Phase 2 修 dsh-scope bug 后可放开让 LLM 选。
      return {
        output:
          `Subagent ${handle.taskId} spawned in background. ` +
          `You will be notified via <task-notification> in a later turn when it finishes. ` +
          `Use subagent_control to send messages or interrupt this task.`,
        taskId: handle.taskId,
        status: 'running' as const,
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

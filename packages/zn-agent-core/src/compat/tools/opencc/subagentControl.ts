/**
 * subagent_control — 父 agent 控制后台子 agent(对齐 DSH tool-subagent-control)。
 *   send_message     → bg.sendMessageToTask(taskId, prompt)(子 agent 下一轮 turn 消费)
 *   interrupt_agent  → bg.cancel(taskId)(仅中止当前 turn,幂等)
 *   list_agents      → bg.list({parentSessionId})
 *
 * 注册进主对话工具集(`compat/tools/index.ts` 的 `buildDefaultTools`),
 * 走 globalThis bridge(`__zaiBackgroundRuntime`)拿 bg;无 bg(纯
 * zn-agent-core 单测 / vendor CLI 直跑)时所有 action 走 no-op,行为对齐
 * `agentTaskBridge.tryGetBg` 的回退语义。
 *
 * zai patch (HRMSV3-ZN-WEBSITE#668):开箱即用 send_message 投递;任务
 * 不存在 / 已终态时 send_message 返回 {ok:false},模型看到错误再决定
 * 是否重试。list_agents 当前 session 通过 `__zaiCurrentSessionId` 桥
 * 拿(对齐 `agentTaskBridge` / `subagentReport` 既有模式)。
 */
import type { BackgroundRuntime } from '../../background/BackgroundRuntime.js'
import type { BackgroundTask } from '../../background/types.js'
import { getBackgroundRuntime } from '../../background/registry.js'

/**
 * zai patch:必须从 globalThis 读 —— opencc-src/server 的 bundle 由
 * esbuild 单文件打包,会把 compat/background/registry 内联成 bundle
 * 私有实例,zai server 在 dist/compat/background/registry.js 注入的
 * setBackgroundRuntime 写的是另一个模块的 `_runtime`,与本 bundle 内
 * getBackgroundRuntime 看到的不是同一个。与 `agentTaskBridge.tryGetBg`
 * 同款 globalThis bridge 模式。
 */
function tryGetBg(): BackgroundRuntime | null {
  const fromGlobal = (globalThis as {
    __zaiBackgroundRuntime?: BackgroundRuntime | null
  }).__zaiBackgroundRuntime
  if (fromGlobal !== undefined) return fromGlobal
  try {
    return getBackgroundRuntime()
  } catch {
    // BackgroundRuntime 未初始化(纯 zn-agent-core 单测 / 早期 boot)
    // — 静默回退,subagent_control 工具走 no-op。
    return null
  }
}

function readCurrentSessionId(): string | undefined {
  const v = (globalThis as { __zaiCurrentSessionId?: string | null | undefined })
    .__zaiCurrentSessionId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * zai-side 通过 seamRegistry 访问 subagent seam,不再走 globalThis 桥。
 * dsh factory 在 initDshRuntime 时把 subagent seam 注册进 kernel;
 * 本 compat 工具在 dsh 模式下通过 `kernel.getSeam('subagent')` 获取,
 * opencc 模式下 fallback 到 BackgroundRuntime。
 */
interface DshSubagentControlBridge {
  list: (parentSessionId?: string) => Promise<Array<{
    id: string
    status: string
    description?: string
  }>>
  cancel: (taskId: string) => Promise<{ ok: boolean }>
  sendMessage: (taskId: string, prompt: string) => Promise<{ ok: boolean }>
}

/** Dynamic import of getKernelAdapter from zai's agentRuntime (same process at runtime). */
async function getDshSubagentControl(): Promise<DshSubagentControlBridge | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getKernelAdapter } = require('../../../../zai/src/server/services/agentRuntime.js')
    const adapter = getKernelAdapter()
    if (!adapter.getSeam) return null
    return adapter.getSeam('subagent') as unknown as DshSubagentControlBridge
  } catch {
    return null
  }
}

export interface SubagentControlInput {
  action: 'send_message' | 'interrupt_agent' | 'list_agents'
  task_id?: string
  message?: string
}

export interface SubagentControlOutput {
  ok?: boolean
  agents?: Array<{ id: string; status: string; description?: string }>
  error?: string
}

interface SubagentControlExecutor {
  (input: SubagentControlInput, ctx?: unknown): Promise<SubagentControlOutput>
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * zai patch:execute 直接走 await,而非通过 Tool.call —— 这里返回结构
 * 对象(ok/agents/error),不是 `{output:string}`,与主对话工具集
 * makeTool 兼容路径不同(zai-native tools 用 makeTool,opencc builtin
 * 工具直接走 call)。给 compat/tools/index.ts 的 buildDefaultTools
 * 直接 .call() 即可,模型看到的 tool_result 会从 {output} 序列化字段
 * 拼装;为了让模型清晰拿到结构,execute 返回的对象也带 output 文本。
 */
async function executeImpl(
  input: SubagentControlInput,
): Promise<SubagentControlOutput> {
  // dsh-019→Task 19: 通过 kernel.getSeam('subagent') 拿 dsh subagent seam;
  // seam 未注册(opencc 模式)时 fallback 到 BackgroundRuntime。
  const dsh = await getDshSubagentControl()
  if (dsh) {
    if (input.action === 'send_message') {
      if (!input.task_id || !input.message) {
        return { ok: false, error: 'send_message 需要 task_id 和 message' }
      }
      try {
        return await dsh.sendMessage(input.task_id, input.message)
      } catch (err) {
        return { ok: false, error: asError(err) }
      }
    }
    if (input.action === 'interrupt_agent') {
      if (!input.task_id) {
        return { ok: false, error: 'interrupt_agent 需要 task_id' }
      }
      try {
        return await dsh.cancel(input.task_id)
      } catch (err) {
        return { ok: false, error: asError(err) }
      }
    }
    // list_agents
    const sessionId = readCurrentSessionId()
    try {
      const agents = await dsh.list(sessionId)
      return { agents }
    } catch (err) {
      return { ok: false, error: asError(err) }
    }
  }

  const bg = tryGetBg()
  if (!bg) {
    return {
      ok: false,
      error:
        '[subagent_control] BackgroundRuntime 未初始化 — 无后台任务上下文,所有 action no-op',
    }
  }

  if (input.action === 'send_message') {
    if (!input.task_id || !input.message) {
      return { ok: false, error: 'send_message 需要 task_id 和 message' }
    }
    try {
      const res = await bg.sendMessageToTask(input.task_id, input.message)
      return { ok: res.ok }
    } catch (err) {
      return { ok: false, error: asError(err) }
    }
  }

  if (input.action === 'interrupt_agent') {
    if (!input.task_id) {
      return { ok: false, error: 'interrupt_agent 需要 task_id' }
    }
    try {
      const res = await bg.cancel(input.task_id)
      return { ok: res.ok }
    } catch (err) {
      return { ok: false, error: asError(err) }
    }
  }

  // list_agents
  // 拿到当前 session 派生任务:TaskListFilter 不带 parentSessionId 字段
  // (types.ts:79 仅 status/limit),所以在 client 端 filter —— 拿全量
  // 再按 parentSessionId 过滤。如果将来 TaskListFilter 扩字段,可改为
  // bg.list({parentSessionId})。
  const sessionId = readCurrentSessionId()
  try {
    const all: BackgroundTask[] = await bg.list()
    const tasks = sessionId
      ? all.filter((t) => t.parentSessionId === sessionId)
      : all
    return {
      agents: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        ...(t.description ? { description: t.description } : {}),
      })),
    }
  } catch (err) {
    return { ok: false, error: asError(err) }
  }
}

export const subagentControlTool: {
  name: string
  description: string
  parameters: {
    action: { type: string; enum: string[]; required: boolean; description: string }
    task_id: { type: string; description: string }
    message: { type: string; description: string }
  }
  execute: SubagentControlExecutor
} = {
  name: 'subagent_control',
  description:
    '控制后台子 agent:send_message 投递指令到子 agent 下一轮 turn;' +
    'interrupt_agent 中止子 agent 当前 turn(幂等);list_agents 列出当前 session 的后台任务。',
  parameters: {
    action: {
      type: 'string',
      enum: ['send_message', 'interrupt_agent', 'list_agents'],
      required: true,
      description: '控制动作。',
    },
    task_id: {
      type: 'string',
      description: 'send_message / interrupt_agent 必填 — 子 agent task id。',
    },
    message: {
      type: 'string',
      description: 'send_message 必填 — 投递到子 agent 下一轮 turn 的指令。',
    },
  },
  execute: executeImpl,
}

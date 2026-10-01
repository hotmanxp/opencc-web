/**
 * subagent_control — 父 agent 控制后台子 agent。
 *   send_message     → bg.sendMessageToTask(taskId, prompt)
 *   interrupt_agent  → bg.cancel(taskId)(仅中止当前 turn,幂等)
 *   list_agents      → bg.list() 后按 parentSessionId 客户端过滤
 *
 * 走 globalThis bridge(`__zaiBackgroundRuntime`)拿 bg;无 bg(纯
 * zn-agent-core 单测 / vendor CLI 直跑)时所有 action 走 no-op,行为对齐
 * `agentTaskBridge.tryGetBg` 的回退语义。
 *
 * 注册点:`opencc-src/tools.ts` 的 `getAllBaseTools()`,经
 * `wrapSubagentControlAsOpencc()` 包装成 vendor Tool 形状。
 *
 * zai patch (HRMSV3-ZN-WEBSITE#668):开箱即用 send_message 投递;任务
 * 不存在 / 已终态时 send_message 返回 {ok:false},模型看到错误再决定
 * 是否重试。
 *
 * 语义澄清(读代码时容易误判的两点):
 *   - send_message 只是**入队**。`DefaultBackgroundRuntime.runOne` 是
 *     单次执行、只在开头读一次 `taskInbox`,所以正在跑的那一轮不会被打断,
 *     消息要等这个 task 结束、下一次 runOne 启动才被消费。
 *   - list_agents 的 sessionId 走 ALS 优先、globalThis 兜底(见
 *     `readCurrentSessionId`);解析不到就直接拒绝,不返回全量。
 *
 * 历史:曾有一个 dsh 分支(`kernel.getSeam('subagent')`)与 DSH 内核并存。
 * DSH 集成 2026-09-14 废弃后 `getKernelAdapter` 导出已不存在,该 require
 * 恒失败被 catch 吞掉 —— 分支实际从未生效,已删。
 */
import { z } from 'zod'
import { z as z4 } from 'zod/v4'
import type { BackgroundRuntime } from '../../background/BackgroundRuntime.js'
import type { BackgroundTask } from '../../background/types.js'
import { getBackgroundRuntime } from '../../background/registry.js'
import { makeTool } from '../makeTool.js'
import { wrapWithOverrides } from '../../runtime/openccToolWrap.js'
import {
  getSdkSessionId,
} from '../../../opencc-src/bootstrap/state.js'

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

/**
 * 解析发起本次调用的 sessionId。
 *
 * 优先取 vendor 的 SDK ALS(`opencc-src/bootstrap/state.ts` 的
 * `getSdkSessionId()` —— 读 `sdkContextStorage`,**没有值就返回
 * undefined,绝不退回进程级 STATE**)。生产路径每次
 * `createOpenccRuntime-impl.ts:1023` 的 `stream.next()` 都在
 * `runWithSdkContext({ sessionId: input.sessionId, ... })` 内跑,
 * 工具执行发生在同一个 async chain,所以这里能拿到本次调用真正的
 * sessionId。
 *
 * 为什么不只读 globalThis: `__zaiCurrentSessionId` 是**进程级单例**,
 * zai-server 多 session 共享进程,任何 session 发 prompt 都会覆写它。
 * 并发两个 session 时,A 的 list_agents 会读到 B 的 sessionId ——
 * 既泄漏 B 的子 agent,又看不见自己的。
 *
 * 为什么不读 vendor 的 `getSessionId()`: 它在 ALS 缺值时 fallback 到
 * `STATE.sessionId`,那是另一个进程级单例(bootstrap/state.ts:530/570
 * 写的),正是我们要避开的。`getSdkSessionId()` 是同文件里为此新加的
 * 纯 ALS 访问器。
 *
 * 为什么不读 `compat/runWithSessionId.ts` 的 ALS: 那套只被
 * `createReplSession.ts:392` 包裹,而 zai 生产主链路走
 * `createOpenccRuntime` → QueryEngine,压根不经过 createReplSession。
 * 在生产环境读它永远拿到 undefined。
 *
 * ALS 之外(纯 core 单测 / 未起 query 的轻量运行时)用 globalThis 兜底。
 */
function readCurrentSessionId(): string | undefined {
  const als = getSdkSessionId()
  if (als) return als
  const v = (globalThis as { __zaiCurrentSessionId?: string | null | undefined })
    .__zaiCurrentSessionId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export interface SubagentControlInput {
  action: 'send_message' | 'interrupt_agent' | 'list_agents'
  task_id?: string
  message?: string
}

/**
 * zod 形态的入参 schema —— opencc 的 `toolToAPISchema` 走
 * `zodToJsonSchema`,必须给它 zod 而不是裸 JSON Schema(否则
 * `schema._zod.def` 读不到,工具 schema 会退化成空对象)。
 * 约束与旧的 `parameters` 字段一一对应。
 */
const SubagentControlInputSchema = z.object({
  action: z
    .enum(['send_message', 'interrupt_agent', 'list_agents'])
    .describe('控制动作。'),
  task_id: z
    .string()
    .optional()
    .describe('send_message / interrupt_agent 必填 — 子 agent task id。'),
  message: z
    .string()
    .optional()
    .describe('send_message 必填 — 投递到子 agent 下一轮 turn 的指令。'),
})

export interface SubagentControlOutput {
  ok?: boolean
  agents?: Array<{ id: string; status: string; description?: string }>
  error?: string
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * zai patch:execute 直接走 await,而非通过 Tool.call —— 这里返回结构
 * 对象(ok/agents/error),不是 `{output:string}`,与 makeTool 兼容路径
 * 不同(zai-native tools 用 makeTool,opencc builtin 工具直接走 call)。
 * 注册时直接 .call() 即可,模型看到的 tool_result 会从 {output} 序列化
 * 字段拼装;为了让模型清晰拿到结构,execute 返回的对象也带 output 文本。
 */
async function executeImpl(
  input: SubagentControlInput,
): Promise<SubagentControlOutput> {
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
  if (!sessionId) {
    // 解析不到 session 就**不能**退化成返回全量: 那是跨会话泄漏 ——
    // 模型会看到别的 session 的子 agent id,进而用 send_message /
    // interrupt_agent 去动别人的任务。宁可直接拒绝。
    return {
      ok: false,
      error:
        '[subagent_control] 解析不到当前 sessionId,拒绝列出全量任务 ' +
        '(否则会跨会话泄漏其它 session 的子 agent)。' +
        '若确认本就没有后台子 agent,可忽略此错误。',
    }
  }
  try {
    const all: BackgroundTask[] = await bg.list()
    const tasks = all.filter((t) => t.parentSessionId === sessionId)
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

export const subagentControlTool = makeTool({
  name: 'subagent_control',
  description:
    '控制后台子 agent:send_message 投递指令到子 agent 下一轮 turn;' +
    'interrupt_agent 中止子 agent 当前 turn(幂等);list_agents 列出当前 session 的后台任务。',
  inputSchema: SubagentControlInputSchema,
  executor: async (input) => ({ output: renderOutput(await executeImpl(input)) }),
})

/**
 * 把 executeImpl 的结构化结果渲染成给模型看的文本。
 *
 * list_agents 走人话而不是 JSON —— 模型要据此决定 task_id,纯 JSON 里
 * 的 id/status 字段名对它没有先验含义。
 */
function renderOutput(out: SubagentControlOutput): string {
  if (out.error) return `[error] ${out.error}`
  if (out.agents) {
    if (out.agents.length === 0) {
      return '当前 session 没有后台子 agent。'
    }
    const rows = out.agents.map(
      (a, i) =>
        `${i + 1}. task_id=${a.id} status=${a.status}${a.description ? ` — ${a.description}` : ''}`,
    )
    return `当前 session 的后台子 agent(共 ${out.agents.length} 个):\n${rows.join('\n')}`
  }
  return out.ok ? 'ok' : '操作未生效(无错误详情)'
}

/**
 * opencc 的 `toolToAPISchema` 用 zod/v4 的 `toJSONSchema` 转换
 * `tool.inputSchema`,内部读 `schema._zod.def`。zai-native 的 schema 用
 * workspace 的 zod v3(`compat/tools/makeTool.ts`),实例上没有 `_zod`
 * —— 带着 v3 schema 进池会让每次 API 请求炸在
 * "Cannot read properties of undefined (reading 'def')"。
 * vendor 自己的工具全用 `zod/v4`。所以这里镜像一份 v4 schema 给 opencc,
 * 而 `call` 路径仍走 v3 的 safeParse 校验:两者不会打架,因为模型发的就是
 * 这份 v4 schema 的形状,`z.object` 默认宽松(会剥掉未知字段)。
 *
 * 同 AskUserQuestionTool.ts 的处理方式。
 */
const SubagentControlInputV4 = z4.object({
  action: z4.enum(['send_message', 'interrupt_agent', 'list_agents']),
  task_id: z4.string().optional(),
  message: z4.string().optional(),
})

/**
 * Wrap subagent_control as an opencc-compatible Tool so vendor's `query()`
 * can call it. Registered in `opencc-src/tools.ts` `getAllBaseTools()`
 * alongside the vendor tools.
 *
 * 只覆写 `mapToolResultToToolResultBlockParam`:默认包装器在 data 不是
 * `{output: string}` 时会 `JSON.stringify` 整个结构,那对模型是噪音。
 * 这里的 executor 已经把结果渲染成文本,直接把 `output` 透传即可。
 */
export function wrapSubagentControlAsOpencc(): unknown {
  const wrapped = wrapWithOverrides(subagentControlTool as never, {
    mapToolResultToToolResultBlockParam(data: unknown, toolUseID: string) {
      const d = data as { output?: unknown } | null
      const text =
        d && typeof d === 'object' && typeof d.output === 'string' ? d.output : ''
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: [{ type: 'text' as const, text }],
      }
    },
  })
  // `inputSchema` 在 vendor 的 Tool 接口上是 readonly,但 AskUserQuestionTool
  // 走的是同一套路(见其 line 116),所以这里同样断言成 any。
  ;(wrapped as { inputSchema: unknown }).inputSchema = SubagentControlInputV4
  return wrapped
}

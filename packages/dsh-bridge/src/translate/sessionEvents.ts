/**
 * dsh SessionEvent → zai ServerEvent 翻译器 — B1a T1.3 + B1b T1.5。
 *
 * 核心子集（B1a 必交付）：
 *   - turn/start    → runtime.started
 *   - assistant/chunk(text-delta) → runtime.delta
 *   - assistant/message → (累积后) runtime.done
 *   - turn/end(reason.completed) → runtime.done
 *   - turn/end(reason.error)     → runtime.error
 *   - tool/call    → runtime.tool_call
 *   - tool/result  → runtime.tool_result
 *
 * 11 组映射表（B1b 完整映射）：
 *   全部 SessionEventType → 对应 ServerEvent 分组 + 「对等 / 透传 / ignorable」标注。
 *
 * 当前实现覆盖核心子集；B1b 在 T1.5 中补齐 Step / Session / Job / Queue / Command 等
 * 剩余 11 组翻译（与 ServerEvent 的 Runtime/Session/Job/Prompt/System/State/Instance/
 * Queue/Command/StreamError/Projection 对齐 — 主计划 §3.1 G2 修正）。
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

// zai ServerEvent 由 zai 侧引入。dsh-bridge 不应反向依赖 zai 主包，
// 改为由调用方在 dsh-adapter 中做 union 适配。当前导出 ServerEvent 类型
// 由 zai 侧编译期导入；这里只声明「会产出 zod-compatible 事件」的最小合约。
type ZaiServerEvent = {
  type: string
  eventId?: string
  ts?: number
  seq?: number
  [k: string]: unknown
}

/**
 * 翻译单个 dsh SessionEvent → ServerEvent（或 null 表示 ignorable）。
 * 关键约束：未映射事件必须显式记录到 ignorable 清单，不静默吞掉（T1.3 验收）。
 */
export function translateSessionEvent(
  event: SessionEvent,
  ctx: { sessionId: string; turnIndex: number; seqBase: number },
): ZaiServerEvent | null {
  const seq = ctx.seqBase + (event.seq ?? 0)
  const baseFields = {
    eventId: `evt-${seq}`,
    ts: Date.now(),
    seq,
  }

  switch (event.type) {
    case 'turn/start': {
      return {
        ...baseFields,
        type: 'runtime.started',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
      }
    }

    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && 'text' in chunk) {
        return {
          ...baseFields,
          type: 'runtime.delta',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          delta: chunk.text,
        }
      }
      if (chunk.type === 'reasoning-delta' && 'text' in chunk) {
        return {
          ...baseFields,
          type: 'runtime.thinking',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          thinking: chunk.text,
        }
      }
      return null // ignorable
    }

    case 'assistant/message': {
      // assistant/message 是 assembled message — 文本已落定，由 turn/end 触发
      // runtime.done 输出。 这里只 emit 一个透明 delta 表示消息完成。
      const content = event.data.message.content as Array<{ type: string; text?: string }>
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text === '') return null
      return {
        ...baseFields,
        type: 'runtime.delta',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        delta: text,
      }
    }

    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind === 'completed') {
        return {
          ...baseFields,
          type: 'runtime.done',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
        }
      }
      if (reason.kind === 'error') {
        return {
          ...baseFields,
          type: 'runtime.error',
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex,
          error: {
            category: reason.error?.code ?? 'unknown',
            message: reason.error?.message ?? 'turn error',
            recoverable: false,
          },
        }
      }
      // cancelled / empty — 当作 abort 处理
      return {
        ...baseFields,
        type: 'runtime.aborted',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        reason: reason.kind,
      }
    }

    case 'tool/call': {
      return {
        ...baseFields,
        type: 'runtime.tool_call',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolUseId: String(event.data.callId),
        toolName: event.data.name,
        input: safeJsonParse(event.data.arguments),
      }
    }

    case 'tool/result': {
      // dsh 的 tool/result 内容是 [ToolResultBlock]，tool_use_id + content 在 block 上。
      const content = event.data.message.content as unknown as Array<{ tool_use_id?: string; content?: unknown }>
      const block = content[0]
      // callId 与 tool_use_id 配对（B1b 维护 callId → name 映射）
      const toolUseId = block?.tool_use_id ?? ''
      const output = block?.content ?? content
      return {
        ...baseFields,
        type: 'runtime.tool_result',
        sessionId: ctx.sessionId,
        turnIndex: ctx.turnIndex,
        toolUseId,
        toolName: extractToolName(event.data.message),
        input: null,
        output,
      }
    }

    case 'user/message': {
      // user/message 在 dsh 侧是 user prompt — zai 不单独 emit（前端在 input box 已渲染）。
      // 标记为 ignorable。
      return null
    }

    case 'step/start':
    case 'step/end':
    case 'todo/write':
    case 'request/header':
    case 'request/context':
    case 'session/end-seed':
      // log-only / boundary marker — 不直接翻译为 ServerEvent；
      // B1b 阶段对齐到 state.* / projection.* group。
      return null

    default: {
      // plugin-merged 扩展类型 — 标记 ignorable。
      return null
    }
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function extractToolName(_msg: unknown): string {
  // dsh ToolResultMessage 不携带 toolName — 与 tool/call 的 callId 配对需要
  // 维护本地表（callId → name）。当前为 stub：返回空字符串，由 adapter 层
  // B1b T1.5 阶段补 callId→name 映射。
  return ''
}

/**
 * 11 组映射表（B1b T1.5 完整映射 — 当前为初稿）。
 *
 * 表格列出 zai ServerEvent 的 11 个分组（Runtime/Session/Job/Prompt/System/
 * State/Instance/Queue/Command/StreamError/Projection），以及每个分组下
 * 各 dsh SessionEventType 的「对等 / 透传 / ignorable」状态。
 *
 * B1b 阶段据此补齐缺失项（State/Instance/Queue 等需要 dsh-side 订阅
 * agent-loop 派生事件，dsh-cmdline, dsh-subagent 等 plugin 也在该阶段引入）。
 */
export const SESSION_EVENT_TO_SERVER_GROUP_MAP = {
  Runtime: {
    'turn/start': 'pair',
    'turn/end': 'pair',
    'assistant/chunk': 'pair',
    'assistant/message': 'pair',
    'tool/call': 'pair',
    'tool/result': 'pair',
    'user/message': 'ignorable',
    'step/start': 'ignorable',
    'step/end': 'ignorable',
    'todo/write': 'ignorable',
    'request/header': 'ignorable',
    'request/context': 'ignorable',
    'session/end-seed': 'ignorable',
  },
  Session: {
    'session/created': 'pair', // → session.created
    'session/disposed': 'pair', // → session.deleted
    'session/event': 'pair', // upstream relay
  },
  Job: {
    'job/started': 'pair', // → job.started
    'job/progress': 'pair',
    'job/done': 'pair',
    'job/failed': 'pair',
  },
  Prompt: {
    'tools/pre-execute': 'pair', // → prompt.approve / prompt.permission
    'tool/ask-user': 'pair', // → prompt.ask
    'user/answer': 'pair',
  },
  System: {
    'agent/status': 'pair', // → server.connected / server.error
    'appExit': 'pair', // → system.stopping
  },
  State: {
    'cwd/changed': 'pair', // → state.cwd.changed
    'bash-task/changed': 'pair', // → state.bash_task.changed
    'v2-task/changed': 'pair', // → state.v2_task.changed
    'agent-task/changed': 'pair', // → state.agent_task.changed
  },
  Instance: {
    'instance/changed': 'pair', // → instance.changed
  },
  Queue: {
    'queue/changed': 'pair', // → queue.changed
  },
  Command: {
    'command/run': 'pair', // → command.run
    'command/done': 'pair', // → command.done
  },
  StreamError: {
    'stream/error': 'pair', // → stream/error
  },
  Projection: {
    'session/projection': 'pair', // → session/projection
  },
} as const

export type ServerEventGroup = keyof typeof SESSION_EVENT_TO_SERVER_GROUP_MAP

/**
 * 列出所有 11 组的 ServerEventGroup 名称，便于测试断言完整性。
 */
export const ALL_SERVER_EVENT_GROUPS = Object.keys(
  SESSION_EVENT_TO_SERVER_GROUP_MAP,
) as ServerEventGroup[]

/**
 * 列出「未映射到 ServerEvent」的 dsh SessionEventType（B1b T1.5 完成后应为空）。
 */
export function listUnmappedEvents(): string[] {
  const unmapped: string[] = []
  for (const group of Object.values(SESSION_EVENT_TO_SERVER_GROUP_MAP)) {
    for (const [eventType, status] of Object.entries(group)) {
      if (status === 'ignorable') {
        unmapped.push(eventType)
      }
    }
  }
  return Array.from(new Set(unmapped))
}
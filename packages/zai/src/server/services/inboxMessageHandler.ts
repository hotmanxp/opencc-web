/**
 * zai patch (2026-09-07, plan P2-2.4, worktree-dsh): 8 类 inbox message type
 * 解析 + 路由。vendor `useInboxPoller` 是 React hook, zai 服务端不跑,
 * 但 zai 服务端仍能从 bg-daemon / vendor inbox 消费 InboxMessage —— 这里
 * 把 8 类消息类型的 guard + handler 拆成 zai 层独立模块。
 *
 * 来源(vendor-message-system.md §8.3 8 类 message types 完整解析):
 *   - permission_request        → ToolUseConfirmQueue(leader 弹窗)
 *   - permission_response       → processMailboxPermissionResponse
 *   - sandbox_permission_request → workerSandboxPermissions
 *   - sandbox_permission_response → processSandboxPermissionResponse
 *   - shutdown_request          → regularMessages pass-through
 *   - shutdown_approved         → kill pane + remove from team
 *   - team_permission_update    → apply to toolPermissionContext
 *   - mode_set_request          → update permission mode + config.json
 *   - plan_approval_request     → auto-approve + write response to inbox
 *
 * 8 类 vs 表中 9 类: plan_approval_request 是可选实现, zai 默认走 vendor
 * 通用 regularMessages 通道 (兜底 8 类之外的类型)。
 *
 * dsh 视角特有设计(2026-09-07, plan §0):
 *   zai inbox handler 是 dsh Inbox 双队列在 zai 服务端的物理实现 —— 每
 *   类消息类型对应 dsh 的 delivery kind (followup / steer / inject),
 *   handler 的 dispatch 决策对应 dsh wakeDriver 的 idle / busy /
 *   settling 状态转移。
 *
 * 不修改 vendor (InboxMessageSchema 留在 vendor 处): zai 层只解析 type
 * 字符串 + JSON payload, 通过 handleInboxMessage() 派发到对应 zai 内部
 * channel (permissionRegistry / askRegistry / eventBus / SubagentNotifier 等)。
 */

import type { QueuedCommand } from '@zn-ai/zn-agent-core'

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** 8 类 inbox message types(对齐 vendor useInboxPoller.ts:818) */
export type InboxMessageType =
  | 'permission_request'
  | 'permission_response'
  | 'sandbox_permission_request'
  | 'sandbox_permission_response'
  | 'shutdown_request'
  | 'shutdown_approved'
  | 'team_permission_update'
  | 'mode_set_request'
  | 'plan_approval_request'
  | 'regular'  // fallback 类型: 未识别 message type 走此路

export interface ZaiInboxMessage {
  type: InboxMessageType
  /** 发件人 agent / teammate 名称 */
  from: string
  /** ISO 8601 timestamp */
  timestamp: string
  /** 原始 JSON 文本(guard 函数可能解析失败, raw 保留兜底) */
  raw: string
  /** 解析后的结构化 payload(type-specific 字段) */
  parsed?: Record<string, unknown>
  /** zai 注入的 sessionId 标签, 用于 per-session 路由 */
  sessionId?: string
  /** mailbox id, 用于 ack 游标 */
  id?: number
}

export interface PermissionRequestPayload {
  toolUseId: string
  toolName: string
  description: string
  input: unknown
  /** sender agent name */
  from: string
}

export interface PermissionResponsePayload {
  /** the request this is responding to */
  requestId: string
  behavior: 'allow' | 'deny'
  reason?: string
  /** updated permissions to apply (for tool-level grants) */
  updatedPermissions?: Record<string, unknown>
}

export interface ShutdownRequestPayload {
  reason?: string
}

export interface ShutdownApprovedPayload {
  reason?: string
}

export interface ModeSetRequestPayload {
  mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
}

export interface PlanApprovalRequestPayload {
  planId: string
  /** auto-approve vs require user approval */
  autoApprove: boolean
}

export type InboxDispatchAction =
  | { kind: 'permission_request'; sessionId: string; payload: PermissionRequestPayload }
  | { kind: 'permission_response'; sessionId: string; payload: PermissionResponsePayload }
  | { kind: 'sandbox_permission_request'; sessionId: string; payload: PermissionRequestPayload }
  | { kind: 'sandbox_permission_response'; sessionId: string; payload: PermissionResponsePayload }
  | { kind: 'shutdown_request'; sessionId: string; payload: ShutdownRequestPayload }
  | { kind: 'shutdown_approved'; sessionId: string; payload: ShutdownApprovedPayload }
  | { kind: 'team_permission_update'; sessionId: string; payload: Record<string, unknown> }
  | { kind: 'mode_set_request'; sessionId: string; payload: ModeSetRequestPayload }
  | { kind: 'plan_approval_request'; sessionId: string; payload: PlanApprovalRequestPayload }
  | { kind: 'regular'; sessionId: string; payload: { raw: string } }

// ---------------------------------------------------------------------------
// Guard functions (vendor InboxMessage type narrowing)
// ---------------------------------------------------------------------------

export function isPermissionRequest(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'permission_request' && typeof parsed.toolUseId === 'string'
}
export function isPermissionResponse(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'permission_response' && typeof parsed.requestId === 'string'
}
export function isSandboxPermissionRequest(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'sandbox_permission_request' && typeof parsed.toolUseId === 'string'
}
export function isSandboxPermissionResponse(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'sandbox_permission_response' && typeof parsed.requestId === 'string'
}
export function isShutdownRequest(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'shutdown_request'
}
export function isShutdownApproved(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'shutdown_approved'
}
export function isTeamPermissionUpdate(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'team_permission_update'
}
export function isModeSetRequest(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'mode_set_request' && typeof parsed.mode === 'string'
}
export function isPlanApprovalRequest(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'plan_approval_request' && typeof parsed.planId === 'string'
}

// ---------------------------------------------------------------------------
// Parser (vendor InboxMessage → zai InboxMessage)
// ---------------------------------------------------------------------------

/**
 * 解析一条 vendor InboxMessage 原始消息文本(JSON)。失败时返回 null
 * (loud fail, 调用方走 regular fallback)。vendor mailbox 可能推送
 * 非 JSON 字符串(legacy path), 这里 try/catch 兜底。
 */
export function parseInboxMessage(raw: string): ZaiInboxMessage | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const type = (parsed.type as InboxMessageType) ?? 'regular'
  const from = (parsed.from as string) ?? 'unknown'
  const timestamp = (parsed.timestamp as string) ?? new Date().toISOString()

  return {
    type,
    from,
    timestamp,
    raw,
    parsed,
    sessionId: parsed.sessionId as string | undefined,
    id: parsed.id as number | undefined,
  }
}

// ---------------------------------------------------------------------------
// Dispatcher (zai InboxMessage → InboxDispatchAction)
// ---------------------------------------------------------------------------

/**
 * 主分发入口: 把一条 zai InboxMessage 翻译为 InboxDispatchAction,
 * 调用方(setupMailboxBridge / useInboxPoller fallback / SSE bridge)按
 * kind 路由到对应 registry / channel。sessionId 必须存在 —— 没有
 * sessionId 标签的消息无法路由到具体 session, 返回 null(调用方走
 * 'regular' 兜底或丢弃)。
 */
export function dispatchInboxMessage(msg: ZaiInboxMessage): InboxDispatchAction | null {
  const sessionId = msg.sessionId
  if (!sessionId) {
    // zai patch (2026-09-07, plan §0): 没有 sessionId 标签的 inbox 消息
    // 路由不到具体 session, 返回 null。vendor 单进程场景下 zai 不消费
    // 这类消息(直接走 vendor 自己的 useInboxPoller hook)。
    return null
  }
  const parsed = msg.parsed ?? {}

  if (isPermissionRequest(parsed)) {
    return {
      kind: 'permission_request',
      sessionId,
      payload: {
        toolUseId: parsed.toolUseId as string,
        toolName: (parsed.toolName as string) ?? '',
        description: (parsed.description as string) ?? '',
        input: parsed.input,
        from: msg.from,
      },
    }
  }
  if (isPermissionResponse(parsed)) {
    return {
      kind: 'permission_response',
      sessionId,
      payload: {
        requestId: parsed.requestId as string,
        behavior: (parsed.behavior as 'allow' | 'deny') ?? 'deny',
        reason: parsed.reason as string | undefined,
        updatedPermissions: parsed.updatedPermissions as Record<string, unknown> | undefined,
      },
    }
  }
  if (isSandboxPermissionRequest(parsed)) {
    return {
      kind: 'sandbox_permission_request',
      sessionId,
      payload: {
        toolUseId: parsed.toolUseId as string,
        toolName: (parsed.toolName as string) ?? '',
        description: (parsed.description as string) ?? '',
        input: parsed.input,
        from: msg.from,
      },
    }
  }
  if (isSandboxPermissionResponse(parsed)) {
    return {
      kind: 'sandbox_permission_response',
      sessionId,
      payload: {
        requestId: parsed.requestId as string,
        behavior: (parsed.behavior as 'allow' | 'deny') ?? 'deny',
      },
    }
  }
  if (isShutdownRequest(parsed)) {
    return { kind: 'shutdown_request', sessionId, payload: { reason: parsed.reason as string | undefined } }
  }
  if (isShutdownApproved(parsed)) {
    return { kind: 'shutdown_approved', sessionId, payload: { reason: parsed.reason as string | undefined } }
  }
  if (isTeamPermissionUpdate(parsed)) {
    return { kind: 'team_permission_update', sessionId, payload: parsed }
  }
  if (isModeSetRequest(parsed)) {
    return {
      kind: 'mode_set_request',
      sessionId,
      payload: { mode: parsed.mode as ModeSetRequestPayload['mode'] },
    }
  }
  if (isPlanApprovalRequest(parsed)) {
    return {
      kind: 'plan_approval_request',
      sessionId,
      payload: {
        planId: parsed.planId as string,
        autoApprove: Boolean(parsed.autoApprove),
      },
    }
  }

  // 未识别 / 未对齐的类型 → regular fallback (XML wrap + submit as
  // teammate message)。与 vendor useInboxPoller:920-924 一致。
  return { kind: 'regular', sessionId, payload: { raw: msg.raw } }
}

// ---------------------------------------------------------------------------
// QueuedCommand adapter: zai 内部事件流 (subagentNotifier / taskFactory 等)
// 也通过本模块路由, 这里把 Quasi-QueuedCommand 转 ZaiInboxMessage, 让
// zai 自管 inbox 与 vendor mailbox 共享同一分发路径。
// ---------------------------------------------------------------------------

export function queuedCommandToInboxMessage(cmd: QueuedCommand & { sessionId?: string }): ZaiInboxMessage {
  return {
    type: 'regular',
    from: 'internal',
    timestamp: new Date().toISOString(),
    raw: typeof cmd.value === 'string' ? cmd.value : JSON.stringify(cmd.value),
    parsed: cmd as unknown as Record<string, unknown>,
    sessionId: cmd.sessionId ?? cmd.agentId,
  }
}

// ---------------------------------------------------------------------------
// 8 dsh-aligned delivery kinds (plan §2.4)
// ---------------------------------------------------------------------------
//
// 区别于上面 10 个 vendor 类型 (useInboxPoller:818 mailbox JSON 解析),
// 这 8 个 dsh delivery kind 是 zai 多 session 服务端从内部事件流
// (subagentNotifier / bashNotifier / systemReminder / cronScheduler /
// toolExecution 等) 收集 inbox 消息的统一抽象。每类对齐 dsh agent-loop
// inbox 的语义, 由 `dispatchDshInbox()` 路由到对应 zai 内部 channel:
//
//  1. task-notification     → SessionInbox.followup (idle wake / busy steer)
//  2. permission_denied     → askRegistry.reject (用户拒绝 tool 工具调用)
//  3. permission_allowed    → askRegistry.answer (用户批准 tool 工具调用)
//  4. elicit                → ElicitationRegistry.request (MCP elicit 协议)
//  5. tool_result           → toolExecution.queueResult (tool use result 回灌)
//  6. system_reminder       → next-turn prompt prepend (mid-turn drain)
//  7. user_message          → SessionInbox.followup (idle wake / busy steer)
//  8. bash_task.changed / cron_fired → eventBus emit (前端 SSE, 不入 inbox)
//
// 设计要点:
//   - 与上面 10 vendor 类型是**两层抽象**: vendor mailbox 是跨进程通信
//     (文件 + Unix socket), dsh inbox 是同进程事件流。两者通过
//     `__zaiInboxBridge` global 桥接 (zai-server createApp 时 install)。
//   - 不修改 vendor InboxMessageSchema (vendor mailbox 字段名固定)。
//   - zai-server 暴露 `dispatchDshInbox()` 给内部事件流调用方
//     (subagentNotifier.handle / bashNotifier.handle / cronScheduler.onFire
//     / preApiCallReminderProvider 等)。失败的 dispatch 返回 false, 调用方
//     走 vendor 原通道兜底。
//   - 测试 seam: `__resetDshInboxBridgesForTests()` 清空所有 bridge。

/** 8 类 dsh-aligned inbox delivery kinds (plan §2.4)。 */
export type DshDeliveryKind =
  | 'task-notification'
  | 'permission_denied'
  | 'permission_allowed'
  | 'elicit'
  | 'tool_result'
  | 'system_reminder'
  | 'user_message'
  | 'bash_task.changed'
  | 'cron_fired'

export interface DshInboxEnvelope {
  kind: DshDeliveryKind
  sessionId: string
  /** 发件方, 自由文本(agent name / teammate / 'system' / 'user') */
  from?: string
  /** ms epoch (optional; default = Date.now() at dispatch time) */
  createdAt?: number
  /** payload: type-specific, 自由 shape; receiver 自行 narrow */
  payload: Record<string, unknown>
  /** delivery preference: 'wake' = idle 时唤醒, 'quiet' = 不唤醒 */
  delivery?: 'wake' | 'quiet'
}

export interface DshDispatchResult {
  kind: DshDeliveryKind
  ok: boolean
  /** Optional reason when ok=false (for logging) */
  reason?: string
}

// ---------------------------------------------------------------------------
// Bridge registry — 8 delivery kinds → concrete zai channel
// ---------------------------------------------------------------------------
// 不直接 import askRegistry / elicitationRegistry 等具体模块 —— 避免
// inboxMessageHandler 变成中央依赖, 接收方由 zai-server 在 createApp 时
// install, 模块依赖单向 (inbox handler 只声明契约, 不感知实现)。
//
// Bridge shape:
//   - task-notification / user_message: `{ followup(sessionId, msg) }`
//     与 SessionInbox.followup 同构
//   - permission_denied / permission_allowed: `{ answer/reject(toolUseId, ...) }`
//     askRegistry 实现
//   - elicit: `{ request(input) → Promise<result> }`, ElicitationRegistry 实现
//   - tool_result: `{ queueResult(toolUseId, output, isError) }`, toolExecution 实现
//   - system_reminder: `{ prependReminder(sessionId, text) }`, next-turn prompt
//   - bash_task.changed / cron_fired: 直接 emit eventBus(不是 inbox 投递)

declare global {
  // eslint-disable-next-line no-var
  var __zaiInboxBridge:
    | {
        /** SessionInbox.followup / steer (task-notification / user_message) */
        followup?: (sessionId: string, msg: { id: string; source: { kind: string; form: string }; content: string; createdAt: number }) => void
        /** askRegistry.answer(allow) — permission_allowed */
        answerAsk?: (toolUseId: string, payload: Record<string, unknown>) => boolean
        /** askRegistry.reject(deny) — permission_denied */
        rejectAsk?: (toolUseId: string, reason?: string) => boolean
        /** ElicitationRegistry.request — elicit */
        requestElicit?: (input: Record<string, unknown>) => Promise<{ action: string; content?: Record<string, unknown> }>
        /** toolExecution.queueResult — tool_result */
        queueToolResult?: (sessionId: string, toolUseId: string, output: unknown, isError: boolean) => void
        /** queryLoop / runQueryLoop prepend — system_reminder */
        prependReminder?: (sessionId: string, text: string) => void
        /** eventBus.emit wrapper — bash_task.changed / cron_fired */
        emit?: (eventType: string, payload: Record<string, unknown>) => void
      }
    | undefined
}

/**
 * Install concrete channel implementations. Called once at zai-server startup
 * (createApp), passing references to SessionInbox / askRegistry /
 * elicitationRegistry / toolExecution / eventBus. After install,
 * `dispatchDshInbox()` routes any DshInboxEnvelope to its concrete channel.
 */
export function installDshInboxBridges(bridges: NonNullable<typeof globalThis.__zaiInboxBridge>): void {
  globalThis.__zaiInboxBridge = bridges
}

/** 测试 seam: 清空 bridge。 */
export function __resetDshInboxBridgesForTests(): void {
  globalThis.__zaiInboxBridge = undefined
}

/**
 * 主分发入口: 把一条 dsh inbox envelope 路由到对应 zai 内部 channel。
 * 返回 ok=false 表示 bridge 未安装 / 对应 kind 无 handler, 调用方应
 * 走 vendor 原通道兜底(subagentNotifier fallback / bashTracker log 等)。
 */
export function dispatchDshInbox(env: DshInboxEnvelope): DshDispatchResult {
  const bridge = globalThis.__zaiInboxBridge
  if (!bridge) {
    return { kind: env.kind, ok: false, reason: 'bridge not installed' }
  }
  const createdAt = env.createdAt ?? Date.now()
  const sessionId = env.sessionId

  switch (env.kind) {
    case 'task-notification':
    case 'user_message': {
      if (!bridge.followup) return { kind: env.kind, ok: false, reason: 'followup not wired' }
      const content = String(env.payload.content ?? env.payload.value ?? JSON.stringify(env.payload))
      bridge.followup(sessionId, {
        id: `${env.kind}-${createdAt}`,
        source: { kind: env.kind, form: 'notice' },
        content,
        createdAt,
      })
      return { kind: env.kind, ok: true }
    }
    case 'permission_denied': {
      const toolUseId = String(env.payload.toolUseId ?? '')
      if (!toolUseId) return { kind: env.kind, ok: false, reason: 'toolUseId missing' }
      if (!bridge.rejectAsk) return { kind: env.kind, ok: false, reason: 'rejectAsk not wired' }
      const ok = bridge.rejectAsk(toolUseId, env.payload.reason as string | undefined)
      return { kind: env.kind, ok }
    }
    case 'permission_allowed': {
      const toolUseId = String(env.payload.toolUseId ?? '')
      if (!toolUseId) return { kind: env.kind, ok: false, reason: 'toolUseId missing' }
      if (!bridge.answerAsk) return { kind: env.kind, ok: false, reason: 'answerAsk not wired' }
      const ok = bridge.answerAsk(toolUseId, env.payload)
      return { kind: env.kind, ok }
    }
    case 'elicit': {
      if (!bridge.requestElicit) return { kind: env.kind, ok: false, reason: 'requestElicit not wired' }
      void bridge.requestElicit(env.payload).catch((err) => {
        console.warn('[inboxMessageHandler] elicit failed:', err)
      })
      return { kind: env.kind, ok: true }
    }
    case 'tool_result': {
      const toolUseId = String(env.payload.toolUseId ?? '')
      if (!toolUseId) return { kind: env.kind, ok: false, reason: 'toolUseId missing' }
      if (!bridge.queueToolResult) return { kind: env.kind, ok: false, reason: 'queueToolResult not wired' }
      bridge.queueToolResult(
        sessionId,
        toolUseId,
        env.payload.output,
        Boolean(env.payload.isError),
      )
      return { kind: env.kind, ok: true }
    }
    case 'system_reminder': {
      const text = String(env.payload.text ?? env.payload.content ?? '')
      if (!text) return { kind: env.kind, ok: false, reason: 'text missing' }
      if (!bridge.prependReminder) return { kind: env.kind, ok: false, reason: 'prependReminder not wired' }
      bridge.prependReminder(sessionId, text)
      return { kind: env.kind, ok: true }
    }
    case 'bash_task.changed': {
      if (!bridge.emit) return { kind: env.kind, ok: false, reason: 'emit not wired' }
      bridge.emit('bash_task.changed', { sessionId, task: env.payload })
      return { kind: env.kind, ok: true }
    }
    case 'cron_fired': {
      if (!bridge.emit) return { kind: env.kind, ok: false, reason: 'emit not wired' }
      bridge.emit('cron_fired', { sessionId, prompt: env.payload.prompt ?? env.payload.value })
      return { kind: env.kind, ok: true }
    }
  }
}

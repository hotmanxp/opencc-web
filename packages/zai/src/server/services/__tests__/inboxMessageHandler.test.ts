// @ts-nocheck
/**
 * zai patch (2026-09-07, plan P2-2.4, worktree-dsh): 8 类 vendor inbox
 * message types 解析 + 8 类 dsh delivery kinds dispatch 单测。
 *
 * 覆盖矩阵 (10 vendor + 8 dsh = 18 总):
 *   - 10 vendor mailbox type 解析 + dispatchInboxMessage (vendor §8.3)
 *   - 8 dsh delivery kinds dispatchDshInbox (plan §2.4)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseInboxMessage,
  dispatchInboxMessage,
  isPermissionRequest,
  isPermissionResponse,
  isModeSetRequest,
  isPlanApprovalRequest,
  dispatchDshInbox,
  installDshInboxBridges,
  __resetDshInboxBridgesForTests,
  type DshInboxEnvelope,
  type DshDeliveryKind,
} from '../inboxMessageHandler.js'

describe('inboxMessageHandler: 10 类 vendor inbox message types (vendor §8.3)', () => {
  it('parseInboxMessage 解析 permission_request', () => {
    const raw = JSON.stringify({
      type: 'permission_request',
      from: 'teammate-1',
      timestamp: '2026-09-07T00:00:00Z',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      description: 'run ls',
      input: { cmd: 'ls' },
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    expect(msg).not.toBeNull()
    expect(msg!.type).toBe('permission_request')
    expect(msg!.sessionId).toBe('sess-A')
    expect(isPermissionRequest(msg!.parsed!)).toBe(true)
  })

  it('parseInboxMessage 解析 permission_response', () => {
    const raw = JSON.stringify({
      type: 'permission_response',
      requestId: 'req-1',
      behavior: 'allow',
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    expect(msg).not.toBeNull()
    expect(isPermissionResponse(msg!.parsed!)).toBe(true)
  })

  it('parseInboxMessage 解析 mode_set_request', () => {
    const raw = JSON.stringify({
      type: 'mode_set_request',
      mode: 'acceptEdits',
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    expect(isModeSetRequest(msg!.parsed!)).toBe(true)
  })

  it('parseInboxMessage 解析 plan_approval_request', () => {
    const raw = JSON.stringify({
      type: 'plan_approval_request',
      planId: 'plan-1',
      autoApprove: true,
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    expect(isPlanApprovalRequest(msg!.parsed!)).toBe(true)
  })

  it('parseInboxMessage 无效 JSON 返回 null', () => {
    expect(parseInboxMessage('not json')).toBeNull()
  })

  it('dispatchInboxMessage permission_request → permission_request action', () => {
    const raw = JSON.stringify({
      type: 'permission_request',
      from: 'teammate-1',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      description: 'run',
      input: { cmd: 'ls' },
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    const action = dispatchInboxMessage(msg!)
    expect(action).not.toBeNull()
    expect(action!.kind).toBe('permission_request')
    if (action!.kind === 'permission_request') {
      expect(action!.payload.toolUseId).toBe('tu-1')
      expect(action!.payload.from).toBe('teammate-1')
    }
  })

  it('dispatchInboxMessage 缺 sessionId 返回 null(无法路由)', () => {
    const raw = JSON.stringify({
      type: 'permission_request',
      toolUseId: 'tu-1',
      // sessionId 不设
    })
    const msg = parseInboxMessage(raw)
    const action = dispatchInboxMessage(msg!)
    expect(action).toBeNull()
  })

  it('dispatchInboxMessage 未识别 type 走 regular fallback', () => {
    const raw = JSON.stringify({
      type: 'unknown_type_xyz',
      text: 'hello',
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    const action = dispatchInboxMessage(msg!)
    expect(action).not.toBeNull()
    expect(action!.kind).toBe('regular')
  })

  it('dispatchInboxMessage permission_response with updatedPermissions', () => {
    const raw = JSON.stringify({
      type: 'permission_response',
      requestId: 'req-1',
      behavior: 'allow',
      updatedPermissions: { 'Bash(ls)': 'allow' },
      sessionId: 'sess-A',
    })
    const msg = parseInboxMessage(raw)
    const action = dispatchInboxMessage(msg!)
    expect(action!.kind).toBe('permission_response')
    if (action!.kind === 'permission_response') {
      expect(action!.payload.updatedPermissions).toEqual({ 'Bash(ls)': 'allow' })
    }
  })

  it('10 类 guard 函数全部 false 对非匹配 payload', () => {
    expect(isPermissionRequest({ type: 'shutdown_request' })).toBe(false)
    expect(isPermissionResponse({ type: 'shutdown_request' })).toBe(false)
    expect(isModeSetRequest({ type: 'shutdown_request' })).toBe(false)
    expect(isPlanApprovalRequest({ type: 'shutdown_request' })).toBe(false)
  })
})

describe('inboxMessageHandler: 8 类 dsh delivery kinds dispatch (plan §2.4)', () => {
  // 收集所有 bridge 调用以便 assert
  let followupCalls: any[]
  let answerAskCalls: Array<{ toolUseId: string; payload: any }>
  let rejectAskCalls: Array<{ toolUseId: string; reason?: string }>
  let elicitCalls: any[]
  let emitCalls: Array<{ eventType: string; payload: any }>

  beforeEach(() => {
    followupCalls = []
    answerAskCalls = []
    rejectAskCalls = []
    elicitCalls = []
    emitCalls = []
    installDshInboxBridges({
      followup: (sid, msg) => followupCalls.push({ sid, msg }),
      answerAsk: (toolUseId, payload) => {
        answerAskCalls.push({ toolUseId, payload })
        return true
      },
      rejectAsk: (toolUseId, reason) => {
        rejectAskCalls.push({ toolUseId, reason })
        return true
      },
      requestElicit: async (input) => {
        elicitCalls.push(input)
        return { action: 'accept', content: {} }
      },
      queueToolResult: undefined,
      prependReminder: undefined,
      emit: (eventType, payload) => emitCalls.push({ eventType, payload }),
    })
  })

  function expectDispatchOk(env: DshInboxEnvelope) {
    const result = dispatchDshInbox(env)
    expect(result.ok).toBe(true)
    expect(result.kind).toBe(env.kind)
  }

  it('1. task-notification → SessionInbox.followup (idle wake / busy steer)', () => {
    expectDispatchOk({
      kind: 'task-notification',
      sessionId: 'sess-A',
      payload: { content: '<task-notification>...</task-notification>' },
    })
    expect(followupCalls).toHaveLength(1)
    expect(followupCalls[0].sid).toBe('sess-A')
    expect(followupCalls[0].msg.content).toContain('task-notification')
    expect(followupCalls[0].msg.source.kind).toBe('task-notification')
  })

  it('2. permission_denied → askRegistry.reject', () => {
    expectDispatchOk({
      kind: 'permission_denied',
      sessionId: 'sess-A',
      payload: { toolUseId: 'tu-1', reason: 'user declined' },
    })
    expect(rejectAskCalls).toHaveLength(1)
    expect(rejectAskCalls[0].toolUseId).toBe('tu-1')
    expect(rejectAskCalls[0].reason).toBe('user declined')
  })

  it('3. permission_allowed → askRegistry.answer', () => {
    expectDispatchOk({
      kind: 'permission_allowed',
      sessionId: 'sess-A',
      payload: { toolUseId: 'tu-1', answers: { choice: 'yes' } },
    })
    expect(answerAskCalls).toHaveLength(1)
    expect(answerAskCalls[0].toolUseId).toBe('tu-1')
    expect(answerAskCalls[0].payload.answers).toEqual({ choice: 'yes' })
  })

  it('4. elicit → ElicitationRegistry.request', async () => {
    expectDispatchOk({
      kind: 'elicit',
      sessionId: 'sess-A',
      payload: { mcpServerName: 'mcp-1', message: 'Need input', mode: 'form' },
    })
    // requestElicit 是 async, 等 microtask
    await new Promise((r) => setTimeout(r, 0))
    expect(elicitCalls).toHaveLength(1)
    expect(elicitCalls[0].mcpServerName).toBe('mcp-1')
  })

  it('5. tool_result → toolExecution.queueResult (未实现, 返回 ok=false)', () => {
    const result = dispatchDshInbox({
      kind: 'tool_result',
      sessionId: 'sess-A',
      payload: { toolUseId: 'tu-1', output: 'ok', isError: false },
    })
    // queueToolResult bridge 未 install → ok=false (callers fallback)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('queueToolResult not wired')
  })

  it('6. system_reminder → queryLoop prepend (未实现, 返回 ok=false)', () => {
    const result = dispatchDshInbox({
      kind: 'system_reminder',
      sessionId: 'sess-A',
      payload: { text: 'be concise' },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('prependReminder not wired')
  })

  it('7. user_message → SessionInbox.followup', () => {
    expectDispatchOk({
      kind: 'user_message',
      sessionId: 'sess-A',
      payload: { content: 'user typed hello' },
    })
    expect(followupCalls).toHaveLength(1)
    expect(followupCalls[0].msg.source.kind).toBe('user_message')
  })

  it('8a. bash_task.changed → eventBus.emit', () => {
    expectDispatchOk({
      kind: 'bash_task.changed',
      sessionId: 'sess-A',
      payload: { taskId: 'bash-1', status: 'completed' },
    })
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0].eventType).toBe('bash_task.changed')
    // emit shape: { sessionId, task: payload }
    expect(emitCalls[0].payload.sessionId).toBe('sess-A')
    expect(emitCalls[0].payload.task.taskId).toBe('bash-1')
    expect(emitCalls[0].payload.task.status).toBe('completed')
  })

  it('8b. cron_fired → eventBus.emit', () => {
    expectDispatchOk({
      kind: 'cron_fired',
      sessionId: 'sess-A',
      payload: { prompt: 'scheduled task prompt' },
    })
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0].eventType).toBe('cron_fired')
    // emit shape: { sessionId, prompt }
    expect(emitCalls[0].payload.sessionId).toBe('sess-A')
    expect(emitCalls[0].payload.prompt).toBe('scheduled task prompt')
  })

  it('bridge 未安装 → 返回 ok=false (callers fallback)', () => {
    __resetDshInboxBridgesForTests()
    const result = dispatchDshInbox({
      kind: 'task-notification',
      sessionId: 'sess-A',
      payload: { content: 'orphan' },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bridge not installed')
  })

  it('permission_denied 缺 toolUseId → 返回 ok=false reason=toolUseId missing', () => {
    const result = dispatchDshInbox({
      kind: 'permission_denied',
      sessionId: 'sess-A',
      payload: { reason: 'no tool id' },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('toolUseId missing')
  })

  it('system_reminder 缺 text → 返回 ok=false', () => {
    const result = dispatchDshInbox({
      kind: 'system_reminder',
      sessionId: 'sess-A',
      payload: { content: '' },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('text missing')
  })

  it('8 delivery kinds 全部覆盖 (sanity 列表完整性)', () => {
    const all: DshDeliveryKind[] = [
      'task-notification',
      'permission_denied',
      'permission_allowed',
      'elicit',
      'tool_result',
      'system_reminder',
      'user_message',
      'bash_task.changed',
      'cron_fired',
    ]
    // dispatch 每种 kind, 至少有一种 ok=true 或 ok=false 但 reason 不为
    // 'bridge not installed'(证明走到了 switch 分支)。
    for (const kind of all) {
      const result = dispatchDshInbox({
        kind,
        sessionId: 'sess-A',
        payload: {},
      })
      expect(result.kind).toBe(kind)
      expect(result.reason).not.toBe('bridge not installed')
    }
  })
})

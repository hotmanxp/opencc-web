// @ts-nocheck
/**
 * zai patch (2026-09-07, plan P2-2.4, worktree-dsh): 8 类 inbox message
 * types 解析单测。
 */

import { describe, it, expect } from 'vitest'
import {
  parseInboxMessage,
  dispatchInboxMessage,
  isPermissionRequest,
  isPermissionResponse,
  isModeSetRequest,
  isPlanApprovalRequest,
} from '../inboxMessageHandler.js'

describe('inboxMessageHandler: 8 类 inbox message types', () => {
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

  it('8 类 guard 函数全部 false 对非匹配 payload', () => {
    expect(isPermissionRequest({ type: 'shutdown_request' })).toBe(false)
    expect(isPermissionResponse({ type: 'shutdown_request' })).toBe(false)
    expect(isModeSetRequest({ type: 'shutdown_request' })).toBe(false)
    expect(isPlanApprovalRequest({ type: 'shutdown_request' })).toBe(false)
  })
})

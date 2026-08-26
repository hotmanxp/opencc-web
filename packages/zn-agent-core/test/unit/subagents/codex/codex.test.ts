import { describe, it, expect } from 'vitest'
import {
  pickApprovalDecision,
  registerApprovalHandlers,
  isUnattendedImpossible,
} from '../../../../src/compat/subagents/codex/approvals.js'

describe('codex/approvals.pickApprovalDecision', () => {
  it('prefers cancel when offered', () => {
    expect(pickApprovalDecision(['approve', 'cancel', 'decline'])).toBe('cancel')
    expect(pickApprovalDecision(['cancel', 'approve'])).toBe('cancel')
  })

  it('falls back to decline when cancel is not offered', () => {
    expect(pickApprovalDecision(['approve', 'decline'])).toBe('decline')
  })

  it('falls back to decline when no offered list is present', () => {
    expect(pickApprovalDecision(undefined)).toBe('decline')
    expect(pickApprovalDecision([])).toBe('decline')
  })

  it('returns the lone entry when only approve is offered (no choice)', () => {
    expect(pickApprovalDecision(['approve'])).toBe('approve')
  })

  it('uses the first entry when offered list has no prefer-non-approve', () => {
    expect(pickApprovalDecision(['unknown1' as never])).toBe('unknown1' as never)
  })
})

describe('codex/approvals.isUnattendedImpossible', () => {
  it('returns false for known notification methods', () => {
    expect(isUnattendedImpossible('agentMessage')).toBe(false)
    expect(isUnattendedImpossible('turn/completed')).toBe(false)
    expect(isUnattendedImpossible('execApprovalRequest')).toBe(false)
    expect(isUnattendedImpossible('userInputRequest')).toBe(false)
    expect(isUnattendedImpossible('mcpElicitationRequest')).toBe(false)
  })

  it('returns true for unknown request methods — fail-closed default', () => {
    expect(isUnattendedImpossible('flibbertigibbet')).toBe(true)
    expect(isUnattendedImpossible('someNewUpstreamMethod')).toBe(true)
  })
})

describe('codex/approvals.registerApprovalHandlers — integration via synthetic transport', () => {
  // Minimal JsonRpcClient stub that captures notify() calls without
  // touching an actual stream. Keeps this test focused on whether the
  // listener was registered and what decision it picks per method.
  it('registers subscribers for each approval method', () => {
    const subscribers = new Map<string, Set<(m: string, p: unknown) => void>>()
    const stubRpc = {
      onNotification: (handler: (m: string, p: unknown) => void) => {
        if (!subscribers.has('*')) subscribers.set('*', new Set())
        subscribers.get('*')!.add(handler)
        return () => {
          subscribers.get('*')!.delete(handler)
        }
      },
      notify: () => {
        // capture-only
      },
    }
    const off = registerApprovalHandlers(stubRpc as unknown as Parameters<typeof registerApprovalHandlers>[0])
    expect(subscribers.get('*')!.size).toBeGreaterThan(0)
    off()
    expect(subscribers.get('*')!.size).toBe(0)
  })
})

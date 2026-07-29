import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.ts'
import {
  getAllowRules,
  getAskRules,
  getDenyRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
} from './permissions.ts'

// Regression tests for the opencc startup crash:
//
//   ERROR  Cannot read properties of undefined (reading 'alwaysDenyRules')
//      at Array.flatMap (<anonymous>)
//      at getDenyRules
//
// The TypeScript signature says `ToolPermissionContext` — not undefined — so
// in theory every caller passes a real value. In practice some startup paths
// (after settings changes, after /effort writes) thread `context` through
// helpers that briefly become undefined, and the unguarded property access
// at permissions.ts:215 (`context.alwaysDenyRules[source]`) throws before
// the rest of the function can run. Defensive guards here keep the failure
// localized (no rules at startup ≠ catastrophic crash) and surface the
// real upstream undefined in a follow-up if it ever recurs.

describe('getDenyRules (defensive guard)', () => {
  test('returns [] when context is undefined', () => {
    expect(() =>
      getDenyRules(undefined as unknown as Parameters<typeof getDenyRules>[0]),
    ).not.toThrow()
    expect(
      getDenyRules(undefined as unknown as Parameters<typeof getDenyRules>[0]),
    ).toEqual([])
  })

  test('returns [] when context lacks alwaysDenyRules', () => {
    const ctx = { ...getEmptyToolPermissionContext() } as Record<string, unknown>
    delete ctx.alwaysDenyRules
    expect(() =>
      getDenyRules(ctx as unknown as Parameters<typeof getDenyRules>[0]),
    ).not.toThrow()
    expect(
      getDenyRules(ctx as unknown as Parameters<typeof getDenyRules>[0]),
    ).toEqual([])
  })

  test('returns empty rules from a well-formed empty context', () => {
    expect(getDenyRules(getEmptyToolPermissionContext())).toEqual([])
  })
})

describe('getAllowRules (defensive guard)', () => {
  test('returns [] when context is undefined', () => {
    expect(() =>
      getAllowRules(undefined as unknown as Parameters<typeof getAllowRules>[0]),
    ).not.toThrow()
    expect(
      getAllowRules(undefined as unknown as Parameters<typeof getAllowRules>[0]),
    ).toEqual([])
  })
})

describe('getAskRules (defensive guard)', () => {
  test('returns [] when context is undefined', () => {
    expect(() =>
      getAskRules(undefined as unknown as Parameters<typeof getAskRules>[0]),
    ).not.toThrow()
    expect(
      getAskRules(undefined as unknown as Parameters<typeof getAskRules>[0]),
    ).toEqual([])
  })
})

describe('getDenyRuleForTool (defensive guard)', () => {
  test('returns null (not throw) when context is undefined', () => {
    expect(() =>
      getDenyRuleForTool(
        undefined as unknown as Parameters<typeof getDenyRuleForTool>[0],
        { name: 'Bash' },
      ),
    ).not.toThrow()
    expect(
      getDenyRuleForTool(
        undefined as unknown as Parameters<typeof getDenyRuleForTool>[0],
        { name: 'Bash' },
      ),
    ).toBeNull()
  })
})

describe('getDenyRuleForAgent (defensive guard)', () => {
  test('returns null (not throw) when context is undefined', () => {
    expect(() =>
      getDenyRuleForAgent(
        undefined as unknown as Parameters<typeof getDenyRuleForAgent>[0],
        'Agent',
        'Explore',
      ),
    ).not.toThrow()
    expect(
      getDenyRuleForAgent(
        undefined as unknown as Parameters<typeof getDenyRuleForAgent>[0],
        'Agent',
        'Explore',
      ),
    ).toBeNull()
  })
})

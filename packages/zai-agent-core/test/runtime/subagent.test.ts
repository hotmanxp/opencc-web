import { describe, expect, test } from 'vitest'
import { buildSubagentContext } from '../../src/runtime/subagent.js'

describe('buildSubagentContext', () => {
  test('string prompt → 包装成 user message', () => {
    const r = buildSubagentContext(
      { prompt: 'fix tests', cwd: '/x', parentSessionId: 'sess-1' },
      { dataDir: '/d' },
      'sess-1-sub-abc',
    )
    expect(r.initialUserMessage).toEqual({ role: 'user', content: 'fix tests' })
  })

  test('非 string prompt → 无 initialUserMessage', () => {
    const r = buildSubagentContext(
      { prompt: [{ role: 'user', content: 'x' }] as any, cwd: '/x', parentSessionId: 'sess-1' },
      { dataDir: '/d' },
      'sess-1-sub-abc',
    )
    expect(r.initialUserMessage).toBeUndefined()
  })
})

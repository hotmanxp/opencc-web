import { describe, expect, it } from 'vitest'
import { wrapTaskToolsAsOpencc } from '../../../../src/compat/tools/opencc/TaskTools.js'

describe('wrapTaskToolsAsOpencc', () => {
  it('returns 4 tools named TaskCreate/Get/Update/List', () => {
    const wrapped = wrapTaskToolsAsOpencc()
    expect(wrapped).toHaveLength(4)
    expect(wrapped.map((t: any) => t.name)).toEqual([
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
    ])
  })

  it('each tool has call, description, inputSchema', () => {
    const wrapped = wrapTaskToolsAsOpencc()
    for (const t of wrapped as any[]) {
      expect(typeof t.call).toBe('function')
      expect(typeof t.description).toBe('function')
      expect(t.inputSchema).toBeDefined()
      expect(typeof t.isReadOnly).toBe('function')
      expect(typeof t.isConcurrencySafe).toBe('function')
      expect(typeof t.isEnabled).toBe('function')
    }
  })
})
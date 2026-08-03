import { describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../../src/compat/tools/index.js'

describe('buildDefaultTools includes task tools', () => {
  it('default toolset exposes TaskCreate, TaskGet, TaskUpdate, TaskList', () => {
    const tools = buildDefaultTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain('TaskCreate')
    expect(names).toContain('TaskGet')
    expect(names).toContain('TaskUpdate')
    expect(names).toContain('TaskList')
  })

  it('exposes TaskCreate even without skillsDirs', () => {
    const tools = buildDefaultTools({ skillsDirs: [] })
    expect(tools.some((t) => t.name === 'TaskCreate')).toBe(true)
  })
})
import { describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../../src/compat/tools/index.js'

describe('buildDefaultTools includes task tools', () => {
  it('returns TaskCreate/Get/Update/List by default', () => {
    const tools = buildDefaultTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain('TaskCreate')
    expect(names).toContain('TaskGet')
    expect(names).toContain('TaskUpdate')
    expect(names).toContain('TaskList')
  })

  it('does not require skillsDirs to include task tools', () => {
    const tools = buildDefaultTools({ skillsDirs: [] })
    expect(tools.map((t) => t.name)).toContain('TaskCreate')
  })
})
